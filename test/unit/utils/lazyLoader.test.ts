/**
 * Unit tests for lazy loading utilities.
 *
 * Tests cover:
 * - LazyLoader basic operations
 * - Pagination and batch loading
 * - Virtual list calculations
 * - Debounce and throttle functions
 */

import * as assert from 'assert';
import {
  LazyLoader,
  ILazyLoadResult,
  createLogLazyLoader,
  calculateVirtualList,
  debounce,
  throttle,
} from '../../../src/utils/lazyLoader';

describe('LazyLoader', () => {
  describe('Basic Operations', () => {
    it('should load initial batch', async () => {
      const mockData = Array.from({ length: 100 }, (_, i) => ({ id: i }));

      const loader = new LazyLoader(
        (offset, limit): Promise<ILazyLoadResult<{ id: number }>> =>
          Promise.resolve({
            items: mockData.slice(offset, offset + limit),
            hasMore: offset + limit < mockData.length,
            currentOffset: offset,
          }),
        { pageSize: 20 }
      );

      await loader.loadInitial();

      assert.strictEqual(loader.items.length, 20);
      assert.strictEqual(loader.hasMore, true);
      assert.strictEqual(loader.isLoading, false);
    });

    it('should load more items', async () => {
      const mockData = Array.from({ length: 100 }, (_, i) => ({ id: i }));

      const loader = new LazyLoader(
        (offset, limit): Promise<ILazyLoadResult<{ id: number }>> =>
          Promise.resolve({
            items: mockData.slice(offset, offset + limit),
            hasMore: offset + limit < mockData.length,
            currentOffset: offset,
          }),
        { pageSize: 20 }
      );

      await loader.loadInitial();
      await loader.loadMore();

      assert.strictEqual(loader.items.length, 40);
      assert.strictEqual(loader.hasMore, true);
    });

    it('should detect when no more items available', async () => {
      const mockData = Array.from({ length: 30 }, (_, i) => ({ id: i }));

      const loader = new LazyLoader(
        (offset, limit): Promise<ILazyLoadResult<{ id: number }>> =>
          Promise.resolve({
            items: mockData.slice(offset, offset + limit),
            hasMore: offset + limit < mockData.length,
            currentOffset: offset,
          }),
        { pageSize: 20 }
      );

      await loader.loadInitial();
      assert.strictEqual(loader.hasMore, true);

      await loader.loadMore();
      assert.strictEqual(loader.items.length, 30);
      assert.strictEqual(loader.hasMore, false);
    });

    it('should not load more when already loading', async () => {
      let loadCount = 0;

      const loader = new LazyLoader(
        async (offset, _limit): Promise<ILazyLoadResult<{ id: number }>> => {
          loadCount++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            items: [{ id: offset }],
            hasMore: true,
            currentOffset: offset,
          };
        },
        { pageSize: 1 }
      );

      // Start multiple loads simultaneously
      const promise1 = loader.loadInitial();
      const promise2 = loader.loadInitial();

      await Promise.all([promise1, promise2]);

      // Should only have loaded once
      assert.strictEqual(loadCount, 1);
    });

    it('should not load more when no more items', async () => {
      const loader = new LazyLoader(
        (): Promise<ILazyLoadResult<{ id: number }>> =>
          Promise.resolve({
            items: [{ id: 1 }],
            hasMore: false,
            currentOffset: 0,
          }),
        { pageSize: 10 }
      );

      await loader.loadInitial();
      await loader.loadMore();

      assert.strictEqual(loader.items.length, 1);
    });

    it('should reset state', async () => {
      const mockData = Array.from({ length: 100 }, (_, i) => ({ id: i }));

      const loader = new LazyLoader(
        (offset, limit): Promise<ILazyLoadResult<{ id: number }>> =>
          Promise.resolve({
            items: mockData.slice(offset, offset + limit),
            hasMore: offset + limit < mockData.length,
            currentOffset: offset,
          }),
        { pageSize: 20 }
      );

      await loader.loadInitial();
      await loader.loadMore();

      assert.strictEqual(loader.items.length, 40);

      await loader.reset();

      assert.strictEqual(loader.items.length, 0);
      assert.strictEqual(loader.hasMore, true);
    });

    it('should reset and reload', async () => {
      const mockData = Array.from({ length: 100 }, (_, i) => ({ id: i }));

      const loader = new LazyLoader(
        (offset, limit): Promise<ILazyLoadResult<{ id: number }>> =>
          Promise.resolve({
            items: mockData.slice(offset, offset + limit),
            hasMore: offset + limit < mockData.length,
            currentOffset: offset,
          }),
        { pageSize: 20 }
      );

      await loader.loadInitial();
      await loader.loadMore();

      await loader.reset(true);

      assert.strictEqual(loader.items.length, 20);
    });
  });

  describe('shouldLoadMore', () => {
    it('should return true when near end of loaded items', async () => {
      const mockData = Array.from({ length: 100 }, (_, i) => ({ id: i }));

      const loader = new LazyLoader(
        (offset, limit): Promise<ILazyLoadResult<{ id: number }>> =>
          Promise.resolve({
            items: mockData.slice(offset, offset + limit),
            hasMore: offset + limit < mockData.length,
            currentOffset: offset,
          }),
        { pageSize: 20, loadThreshold: 5 }
      );

      await loader.loadInitial();

      // At item 14 (5 items from end of 20), should trigger load
      assert.strictEqual(loader.shouldLoadMore(14), true);
    });

    it('should return false when far from end', async () => {
      const mockData = Array.from({ length: 100 }, (_, i) => ({ id: i }));

      const loader = new LazyLoader(
        (offset, limit): Promise<ILazyLoadResult<{ id: number }>> =>
          Promise.resolve({
            items: mockData.slice(offset, offset + limit),
            hasMore: offset + limit < mockData.length,
            currentOffset: offset,
          }),
        { pageSize: 20, loadThreshold: 5 }
      );

      await loader.loadInitial();

      // At item 5 (14 items from end), should not trigger load
      assert.strictEqual(loader.shouldLoadMore(5), false);
    });

    it('should return false when no more items', async () => {
      const loader = new LazyLoader(
        (): Promise<ILazyLoadResult<{ id: number }>> =>
          Promise.resolve({
            items: [{ id: 1 }],
            hasMore: false,
            currentOffset: 0,
          }),
        { pageSize: 10 }
      );

      await loader.loadInitial();

      assert.strictEqual(loader.shouldLoadMore(0), false);
    });
  });

  describe('State Access', () => {
    it('should provide readonly state', async () => {
      const loader = new LazyLoader(
        (): Promise<ILazyLoadResult<{ id: number }>> =>
          Promise.resolve({
            items: [{ id: 1 }],
            hasMore: true,
            currentOffset: 0,
          }),
        { pageSize: 10 }
      );

      await loader.loadInitial();

      const state = loader.state;
      assert.strictEqual(state.items.length, 1);
      assert.strictEqual(state.hasMore, true);
      assert.strictEqual(state.isLoading, false);
    });
  });
});

describe('createLogLazyLoader', () => {
  it('should create a loader for log entries', async () => {
    const mockCommits = Array.from({ length: 200 }, (_, i) => ({
      hash: `commit${i}`,
      message: `Message ${i}`,
    }));

    const loader = createLogLazyLoader(
      (skip, maxCount) => Promise.resolve(mockCommits.slice(skip, skip + maxCount)),
      50
    );

    await loader.loadInitial();

    assert.strictEqual(loader.items.length, 50);
    assert.strictEqual(loader.hasMore, true);
  });

  it('should detect end of log', async () => {
    const mockCommits = Array.from({ length: 30 }, (_, i) => ({
      hash: `commit${i}`,
    }));

    const loader = createLogLazyLoader(
      (skip, maxCount) => Promise.resolve(mockCommits.slice(skip, skip + maxCount)),
      50
    );

    await loader.loadInitial();

    assert.strictEqual(loader.items.length, 30);
    assert.strictEqual(loader.hasMore, false);
  });
});

describe('calculateVirtualList', () => {
  it('should calculate visible range for scrolled list', () => {
    const result = calculateVirtualList({
      totalItems: 1000,
      itemHeight: 30,
      viewportHeight: 300,
      scrollTop: 150,
      overscan: 3,
    });

    // scrollTop 150 / itemHeight 30 = 5 (first visible item)
    // viewportHeight 300 / itemHeight 30 = 10 visible items
    // With overscan 3: startIndex = max(0, 5-3) = 2
    // endIndex = min(1000, 5+10+3) = 18

    assert.strictEqual(result.startIndex, 2);
    assert.strictEqual(result.endIndex, 18);
    assert.strictEqual(result.totalHeight, 30000);
    assert.strictEqual(result.offsetTop, 60); // 2 * 30
  });

  it('should handle start of list', () => {
    const result = calculateVirtualList({
      totalItems: 1000,
      itemHeight: 30,
      viewportHeight: 300,
      scrollTop: 0,
      overscan: 5,
    });

    assert.strictEqual(result.startIndex, 0);
    assert.ok(result.endIndex > 0);
    assert.strictEqual(result.offsetTop, 0);
  });

  it('should handle end of list', () => {
    const result = calculateVirtualList({
      totalItems: 100,
      itemHeight: 30,
      viewportHeight: 300,
      scrollTop: 2700, // Near end
      overscan: 5,
    });

    assert.strictEqual(result.endIndex, 100);
    assert.ok(result.startIndex < 100);
  });

  it('should handle empty list', () => {
    const result = calculateVirtualList({
      totalItems: 0,
      itemHeight: 30,
      viewportHeight: 300,
      scrollTop: 0,
    });

    assert.strictEqual(result.startIndex, 0);
    assert.strictEqual(result.endIndex, 0);
    assert.strictEqual(result.totalHeight, 0);
    assert.strictEqual(result.visibleCount, 0);
  });

  it('should handle zero item height', () => {
    const result = calculateVirtualList({
      totalItems: 100,
      itemHeight: 0,
      viewportHeight: 300,
      scrollTop: 0,
    });

    assert.strictEqual(result.startIndex, 0);
    assert.strictEqual(result.endIndex, 0);
    assert.strictEqual(result.totalHeight, 0);
  });

  it('should use default overscan', () => {
    const result = calculateVirtualList({
      totalItems: 100,
      itemHeight: 30,
      viewportHeight: 300,
      scrollTop: 300,
    });

    // Default overscan is 5
    // scrollTop 300 / 30 = 10
    // startIndex = max(0, 10-5) = 5
    assert.strictEqual(result.startIndex, 5);
  });
});

describe('debounce', () => {
  it('should delay function execution', async () => {
    let callCount = 0;
    const fn = debounce(() => {
      callCount++;
    }, 50);

    fn();
    fn();
    fn();

    assert.strictEqual(callCount, 0);

    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.strictEqual(callCount, 1);
  });

  it('should reset delay on subsequent calls', async () => {
    let callCount = 0;
    const fn = debounce(() => {
      callCount++;
    }, 50);

    fn();
    await new Promise((resolve) => setTimeout(resolve, 30));
    fn();
    await new Promise((resolve) => setTimeout(resolve, 30));
    fn();

    assert.strictEqual(callCount, 0);

    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.strictEqual(callCount, 1);
  });

  it('should pass arguments to debounced function', async () => {
    let receivedArgs: unknown[] = [];
    const fn = debounce((...args: unknown[]) => {
      receivedArgs = args;
    }, 50);

    fn('arg1', 'arg2');

    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.deepStrictEqual(receivedArgs, ['arg1', 'arg2']);
  });
});

describe('throttle', () => {
  it('should execute immediately on first call', () => {
    let callCount = 0;
    const fn = throttle(() => {
      callCount++;
    }, 50);

    fn();

    assert.strictEqual(callCount, 1);
  });

  it('should limit execution rate', async () => {
    let callCount = 0;
    const fn = throttle(() => {
      callCount++;
    }, 50);

    fn(); // Executes immediately
    fn(); // Queued
    fn(); // Ignored (already queued)

    assert.strictEqual(callCount, 1);

    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.strictEqual(callCount, 2);
  });

  it('should pass arguments to throttled function', () => {
    let receivedArgs: unknown[] = [];
    const fn = throttle((...args: unknown[]) => {
      receivedArgs = args;
    }, 50);

    fn('arg1', 'arg2');

    assert.deepStrictEqual(receivedArgs, ['arg1', 'arg2']);
  });
});

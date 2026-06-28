/**
 * Unit tests for caching utilities.
 *
 * Tests cover:
 * - LRU cache basic operations (get, set, delete)
 * - LRU eviction behavior
 * - TTL expiration
 * - Cache invalidation
 * - GitCacheManager operations
 */

import * as assert from 'assert';
import {
  LRUCache,
  GitCacheManager,
  createCacheKey,
  DEFAULT_CACHE_CONFIGS,
} from '../../../src/utils/cache';

describe('LRUCache', () => {
  describe('Basic Operations', () => {
    it('should store and retrieve values', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10 });

      cache.set('key1', 100);
      cache.set('key2', 200);

      assert.strictEqual(cache.get('key1'), 100);
      assert.strictEqual(cache.get('key2'), 200);
    });

    it('should return undefined for non-existent keys', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10 });

      assert.strictEqual(cache.get('nonexistent'), undefined);
    });

    it('should update existing values', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10 });

      cache.set('key1', 100);
      cache.set('key1', 200);

      assert.strictEqual(cache.get('key1'), 200);
      assert.strictEqual(cache.size, 1);
    });

    it('should delete values', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10 });

      cache.set('key1', 100);
      assert.strictEqual(cache.delete('key1'), true);
      assert.strictEqual(cache.get('key1'), undefined);
      assert.strictEqual(cache.size, 0);
    });

    it('should return false when deleting non-existent key', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10 });

      assert.strictEqual(cache.delete('nonexistent'), false);
    });

    it('should check if key exists with has()', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10 });

      cache.set('key1', 100);

      assert.strictEqual(cache.has('key1'), true);
      assert.strictEqual(cache.has('nonexistent'), false);
    });

    it('should clear all entries', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10 });

      cache.set('key1', 100);
      cache.set('key2', 200);
      cache.set('key3', 300);

      cache.clear();

      assert.strictEqual(cache.size, 0);
      assert.strictEqual(cache.get('key1'), undefined);
      assert.strictEqual(cache.get('key2'), undefined);
      assert.strictEqual(cache.get('key3'), undefined);
    });

    it('should return correct size', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10 });

      assert.strictEqual(cache.size, 0);

      cache.set('key1', 100);
      assert.strictEqual(cache.size, 1);

      cache.set('key2', 200);
      assert.strictEqual(cache.size, 2);

      cache.delete('key1');
      assert.strictEqual(cache.size, 1);
    });

    it('should iterate over keys', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10 });

      cache.set('key1', 100);
      cache.set('key2', 200);
      cache.set('key3', 300);

      const keys = Array.from(cache.keys());
      assert.strictEqual(keys.length, 3);
      assert.ok(keys.includes('key1'));
      assert.ok(keys.includes('key2'));
      assert.ok(keys.includes('key3'));
    });
  });

  describe('LRU Eviction', () => {
    it('should evict least recently used entry when at capacity', async () => {
      const cache = new LRUCache<string, number>({ maxSize: 3 });

      cache.set('key1', 100);
      await new Promise((resolve) => setTimeout(resolve, 10));
      cache.set('key2', 200);
      await new Promise((resolve) => setTimeout(resolve, 10));
      cache.set('key3', 300);

      // Access key1 and key3 to make them recently used
      await new Promise((resolve) => setTimeout(resolve, 10));
      cache.get('key1');
      await new Promise((resolve) => setTimeout(resolve, 10));
      cache.get('key3');

      // Add new entry, should evict key2 (least recently used)
      cache.set('key4', 400);

      assert.strictEqual(cache.size, 3);
      assert.strictEqual(cache.get('key1'), 100);
      assert.strictEqual(cache.get('key2'), undefined); // Evicted
      assert.strictEqual(cache.get('key3'), 300);
      assert.strictEqual(cache.get('key4'), 400);
    });

    it('should evict oldest entry when none accessed', () => {
      const cache = new LRUCache<string, number>({ maxSize: 2 });

      cache.set('key1', 100);
      cache.set('key2', 200);
      cache.set('key3', 300);

      assert.strictEqual(cache.size, 2);
      assert.strictEqual(cache.get('key1'), undefined); // Evicted (oldest)
    });

    it('evicts the correct LRU entry using insertion-order (no setTimeout needed)', () => {
      // Map insertion-order LRU: every get/set promotes the entry to the MRU
      // end; _evictLRU() pops the front (oldest) entry — all O(1).
      const cache = new LRUCache<string, number>({ maxSize: 3 });

      cache.set('a', 1); // order: [a]
      cache.set('b', 2); // order: [a, b]
      cache.set('c', 3); // order: [a, b, c]

      // Promote 'a' to MRU end
      cache.get('a'); // order: [b, c, a]

      // Promote 'c' to MRU end
      cache.get('c'); // order: [b, a, c]

      // 'b' is now LRU; adding 'd' evicts 'b'
      cache.set('d', 4); // order: [a, c, d]

      assert.strictEqual(cache.get('b'), undefined, 'b (LRU) must be evicted');
      assert.strictEqual(cache.get('a'), 1, 'a must survive');
      assert.strictEqual(cache.get('c'), 3, 'c must survive');
      assert.strictEqual(cache.get('d'), 4, 'd (new) must survive');
    });

    it('updating an existing key via set() promotes it to MRU', () => {
      // A set(key, newValue) on an existing key must act as an access —
      // promoting the key to MRU so it is not the next eviction candidate.
      const cache = new LRUCache<string, number>({ maxSize: 2 });

      cache.set('x', 10); // order: [x]
      cache.set('y', 20); // order: [x, y]

      // Update 'x' — must promote it to MRU end
      cache.set('x', 11); // order: [y, x]

      // 'y' is now LRU; adding 'z' must evict 'y', NOT 'x'
      cache.set('z', 30); // order: [x, z]

      assert.strictEqual(cache.get('y'), undefined, 'y (LRU) must be evicted');
      assert.strictEqual(cache.get('x'), 11, 'updated x must survive (promoted to MRU)');
      assert.strictEqual(cache.get('z'), 30, 'z (new) must survive');
    });

    it('should call onEvict callback when evicting', () => {
      const evicted: { key: string; value: number }[] = [];

      const cache = new LRUCache<string, number>({
        maxSize: 2,
        onEvict: (key, value): void => {
          evicted.push({ key, value });
        },
      });

      cache.set('key1', 100);
      cache.set('key2', 200);
      cache.set('key3', 300); // Should evict key1

      assert.strictEqual(evicted.length, 1);
      assert.strictEqual(evicted[0].key, 'key1');
      assert.strictEqual(evicted[0].value, 100);
    });

    it('should call onEvict callback when deleting', () => {
      const evicted: { key: string; value: number }[] = [];

      const cache = new LRUCache<string, number>({
        maxSize: 10,
        onEvict: (key, value): void => {
          evicted.push({ key, value });
        },
      });

      cache.set('key1', 100);
      cache.delete('key1');

      assert.strictEqual(evicted.length, 1);
      assert.strictEqual(evicted[0].key, 'key1');
    });

    it('should call onEvict callback when clearing', () => {
      const evicted: { key: string; value: number }[] = [];

      const cache = new LRUCache<string, number>({
        maxSize: 10,
        onEvict: (key, value): void => {
          evicted.push({ key, value });
        },
      });

      cache.set('key1', 100);
      cache.set('key2', 200);
      cache.clear();

      assert.strictEqual(evicted.length, 2);
    });
  });

  describe('TTL Expiration', () => {
    it('should return undefined for expired entries on get()', async () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttl: 50 });

      cache.set('key1', 100);

      // Entry should be valid immediately
      assert.strictEqual(cache.get('key1'), 100);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Entry should be expired
      assert.strictEqual(cache.get('key1'), undefined);
    });

    it('should return false for expired entries on has()', async () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttl: 50 });

      cache.set('key1', 100);

      assert.strictEqual(cache.has('key1'), true);

      await new Promise((resolve) => setTimeout(resolve, 60));

      assert.strictEqual(cache.has('key1'), false);
    });

    it('should prune expired entries', async () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttl: 50 });

      cache.set('key1', 100);
      cache.set('key2', 200);

      await new Promise((resolve) => setTimeout(resolve, 60));

      cache.pruneExpired();

      assert.strictEqual(cache.size, 0);
    });

    it('should not expire entries when TTL is 0', async () => {
      const cache = new LRUCache<string, number>({ maxSize: 10, ttl: 0 });

      cache.set('key1', 100);

      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.strictEqual(cache.get('key1'), 100);
    });
  });

  describe('Invalidation', () => {
    it('should invalidate entries matching predicate', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10 });

      cache.set('/repo1/file1', 100);
      cache.set('/repo1/file2', 200);
      cache.set('/repo2/file1', 300);

      cache.invalidateWhere((key) => key.startsWith('/repo1'));

      assert.strictEqual(cache.get('/repo1/file1'), undefined);
      assert.strictEqual(cache.get('/repo1/file2'), undefined);
      assert.strictEqual(cache.get('/repo2/file1'), 300);
    });

    it('should not invalidate entries not matching predicate', () => {
      const cache = new LRUCache<string, number>({ maxSize: 10 });

      cache.set('key1', 100);
      cache.set('key2', 200);

      cache.invalidateWhere((key) => key === 'nonexistent');

      assert.strictEqual(cache.get('key1'), 100);
      assert.strictEqual(cache.get('key2'), 200);
    });
  });
});

describe('createCacheKey', () => {
  it('should join parts with colons', () => {
    const key = createCacheKey('repo', 'branch', 'file');
    assert.strictEqual(key, 'repo:branch:file');
  });

  it('should filter out undefined parts', () => {
    const key = createCacheKey('repo', undefined, 'file');
    assert.strictEqual(key, 'repo:file');
  });

  it('should handle numbers', () => {
    const key = createCacheKey('repo', 123, 'file');
    assert.strictEqual(key, 'repo:123:file');
  });

  it('should handle single part', () => {
    const key = createCacheKey('repo');
    assert.strictEqual(key, 'repo');
  });

  it('should handle empty parts', () => {
    const key = createCacheKey();
    assert.strictEqual(key, '');
  });
});

describe('DEFAULT_CACHE_CONFIGS', () => {
  it('should have configuration for branches', () => {
    assert.ok(DEFAULT_CACHE_CONFIGS.branches);
    assert.ok(DEFAULT_CACHE_CONFIGS.branches.maxSize > 0);
    assert.ok(DEFAULT_CACHE_CONFIGS.branches.ttl > 0);
  });

  it('should have configuration for commits', () => {
    assert.ok(DEFAULT_CACHE_CONFIGS.commits);
    assert.ok(DEFAULT_CACHE_CONFIGS.commits.maxSize > 0);
    assert.ok(DEFAULT_CACHE_CONFIGS.commits.ttl > 0);
  });

  it('should have configuration for status', () => {
    assert.ok(DEFAULT_CACHE_CONFIGS.status);
    assert.ok(DEFAULT_CACHE_CONFIGS.status.maxSize > 0);
    assert.ok(DEFAULT_CACHE_CONFIGS.status.ttl > 0);
  });

  it('should have configuration for blame', () => {
    assert.ok(DEFAULT_CACHE_CONFIGS.blame);
    assert.ok(DEFAULT_CACHE_CONFIGS.blame.maxSize > 0);
    assert.ok(DEFAULT_CACHE_CONFIGS.blame.ttl > 0);
  });

  it('should have configuration for diff', () => {
    assert.ok(DEFAULT_CACHE_CONFIGS.diff);
    assert.ok(DEFAULT_CACHE_CONFIGS.diff.maxSize > 0);
    assert.ok(DEFAULT_CACHE_CONFIGS.diff.ttl > 0);
  });

  it('should have configuration for log', () => {
    assert.ok(DEFAULT_CACHE_CONFIGS.log);
    assert.ok(DEFAULT_CACHE_CONFIGS.log.maxSize > 0);
    assert.ok(DEFAULT_CACHE_CONFIGS.log.ttl > 0);
  });
});

describe('GitCacheManager', () => {
  it('should provide access to all cache types', () => {
    const manager = new GitCacheManager();

    assert.ok(manager.branches);
    assert.ok(manager.commits);
    assert.ok(manager.status);
    assert.ok(manager.blame);
    assert.ok(manager.diff);
    assert.ok(manager.log);
  });

  it('should invalidate all caches for a repository', () => {
    const manager = new GitCacheManager();

    // Add entries to different caches
    manager.branches.set('/repo1:branches', ['main']);
    manager.commits.set('/repo1:abc123', { hash: 'abc123' });
    manager.branches.set('/repo2:branches', ['develop']);

    // Invalidate repo1
    manager.invalidateRepository('/repo1');

    // repo1 entries should be gone
    assert.strictEqual(manager.branches.get('/repo1:branches'), undefined);
    assert.strictEqual(manager.commits.get('/repo1:abc123'), undefined);

    // repo2 entries should remain
    assert.deepStrictEqual(manager.branches.get('/repo2:branches'), ['develop']);
  });

  it('does not invalidate a sibling repo whose path shares a string prefix', () => {
    const manager = new GitCacheManager();
    manager.branches.set('/a/repo:branches', ['main']);
    manager.branches.set('/a/repo2:branches', ['dev']); // sibling; prefix-overlaps /a/repo

    manager.invalidateRepository('/a/repo');

    assert.strictEqual(
      manager.branches.get('/a/repo:branches'),
      undefined,
      'target repo invalidated'
    );
    assert.deepStrictEqual(
      manager.branches.get('/a/repo2:branches'),
      ['dev'],
      'a sibling /a/repo2 sharing the string prefix must NOT be invalidated'
    );
  });

  it('should clear all caches', () => {
    const manager = new GitCacheManager();

    manager.branches.set('key1', 'value1');
    manager.commits.set('key2', 'value2');
    manager.status.set('key3', 'value3');

    manager.clearAll();

    assert.strictEqual(manager.branches.size, 0);
    assert.strictEqual(manager.commits.size, 0);
    assert.strictEqual(manager.status.size, 0);
  });

  it('should prune expired entries from all caches', () => {
    // This test verifies the pruneExpired method is called on all caches
    // The actual expiration is tested in LRUCache tests
    const manager = new GitCacheManager();

    // Just verify the method doesn't throw
    manager.pruneExpired();
  });
});

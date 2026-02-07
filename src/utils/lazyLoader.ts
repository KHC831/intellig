/**
 * Lazy loading utilities for performance optimization.
 *
 * This module provides utilities for lazy loading and pagination of large data sets,
 * particularly useful for handling large Git repositories with extensive histories.
 *
 * Requirements: 9.9 (Log) - Implement lazy loading for large repositories
 */

/**
 * Options for configuring lazy loading behavior.
 */
export interface ILazyLoadOptions {
  /** Number of items to load per page/batch */
  pageSize: number;
  /** Initial number of items to load (defaults to pageSize) */
  initialLoadSize?: number;
  /** Threshold for triggering next load (items from end) */
  loadThreshold?: number;
}

/**
 * Result of a lazy load operation.
 */
export interface ILazyLoadResult<T> {
  /** The loaded items */
  items: T[];
  /** Whether there are more items to load */
  hasMore: boolean;
  /** Total count of items (if known) */
  totalCount?: number;
  /** Current page/offset */
  currentOffset: number;
}

/**
 * State for tracking lazy loading progress.
 */
export interface ILazyLoadState<T> {
  /** All loaded items so far */
  items: T[];
  /** Current offset/page */
  offset: number;
  /** Whether more items are available */
  hasMore: boolean;
  /** Whether a load operation is in progress */
  isLoading: boolean;
  /** Total count if known */
  totalCount?: number;
}

/**
 * Function type for loading a page of items.
 */
export type PageLoader<T> = (offset: number, limit: number) => Promise<ILazyLoadResult<T>>;

/**
 * Lazy loader class for managing paginated data loading.
 *
 * Features:
 * - Automatic pagination management
 * - Configurable page sizes and thresholds
 * - Loading state tracking
 * - Support for infinite scroll patterns
 *
 * @template T - Type of items being loaded
 */
export class LazyLoader<T> {
  private _state: ILazyLoadState<T>;
  private _options: Required<ILazyLoadOptions>;
  private _loader: PageLoader<T>;
  private _loadPromise: Promise<void> | null = null;

  constructor(loader: PageLoader<T>, options: ILazyLoadOptions) {
    this._loader = loader;
    this._options = {
      pageSize: options.pageSize,
      initialLoadSize: options.initialLoadSize ?? options.pageSize,
      loadThreshold: options.loadThreshold ?? Math.floor(options.pageSize / 2),
    };
    this._state = {
      items: [],
      offset: 0,
      hasMore: true,
      isLoading: false,
    };
  }

  /**
   * Get the current state.
   */
  get state(): Readonly<ILazyLoadState<T>> {
    return this._state;
  }

  /**
   * Get all loaded items.
   */
  get items(): readonly T[] {
    return this._state.items;
  }

  /**
   * Check if more items are available.
   */
  get hasMore(): boolean {
    return this._state.hasMore;
  }

  /**
   * Check if a load operation is in progress.
   */
  get isLoading(): boolean {
    return this._state.isLoading;
  }

  /**
   * Load the initial batch of items.
   *
   * @returns Promise that resolves when loading is complete
   */
  async loadInitial(): Promise<void> {
    if (this._state.isLoading) {
      return this._loadPromise ?? Promise.resolve();
    }

    this._state.isLoading = true;
    this._loadPromise = this._doLoad(0, this._options.initialLoadSize);

    try {
      await this._loadPromise;
    } finally {
      this._state.isLoading = false;
      this._loadPromise = null;
    }
  }

  /**
   * Load the next page of items.
   *
   * @returns Promise that resolves when loading is complete
   */
  async loadMore(): Promise<void> {
    if (this._state.isLoading || !this._state.hasMore) {
      return this._loadPromise ?? Promise.resolve();
    }

    this._state.isLoading = true;
    this._loadPromise = this._doLoad(this._state.offset, this._options.pageSize);

    try {
      await this._loadPromise;
    } finally {
      this._state.isLoading = false;
      this._loadPromise = null;
    }
  }

  /**
   * Check if more items should be loaded based on current scroll position.
   *
   * @param visibleEndIndex - Index of the last visible item
   * @returns True if more items should be loaded
   */
  shouldLoadMore(visibleEndIndex: number): boolean {
    if (!this._state.hasMore || this._state.isLoading) {
      return false;
    }

    const itemsFromEnd = this._state.items.length - visibleEndIndex - 1;
    return itemsFromEnd <= this._options.loadThreshold;
  }

  /**
   * Reset the loader state and optionally reload.
   *
   * @param reload - Whether to reload initial data after reset
   */
  async reset(reload = false): Promise<void> {
    this._state = {
      items: [],
      offset: 0,
      hasMore: true,
      isLoading: false,
    };

    if (reload) {
      await this.loadInitial();
    }
  }

  /**
   * Internal method to perform the actual load operation.
   */
  private async _doLoad(offset: number, limit: number): Promise<void> {
    const result = await this._loader(offset, limit);

    // Append new items
    this._state.items = [...this._state.items, ...result.items];
    this._state.offset = result.currentOffset + result.items.length;
    this._state.hasMore = result.hasMore;

    if (result.totalCount !== undefined) {
      this._state.totalCount = result.totalCount;
    }
  }
}

/**
 * Create a lazy loader for Git log entries.
 *
 * @param loadFn - Function to load log entries
 * @param pageSize - Number of entries per page (default: 100)
 * @returns A configured LazyLoader instance
 */
export function createLogLazyLoader<T>(
  loadFn: (skip: number, maxCount: number) => Promise<T[]>,
  pageSize = 100
): LazyLoader<T> {
  const loader: PageLoader<T> = async (offset, limit) => {
    const items = await loadFn(offset, limit);
    return {
      items,
      hasMore: items.length === limit,
      currentOffset: offset,
    };
  };

  return new LazyLoader(loader, {
    pageSize,
    initialLoadSize: pageSize,
    loadThreshold: 20,
  });
}

/**
 * Virtual list helper for rendering large lists efficiently.
 *
 * Calculates which items should be rendered based on scroll position
 * and viewport size, with configurable overscan for smooth scrolling.
 */
export interface IVirtualListConfig {
  /** Total number of items */
  totalItems: number;
  /** Height of each item in pixels */
  itemHeight: number;
  /** Height of the viewport in pixels */
  viewportHeight: number;
  /** Current scroll position in pixels */
  scrollTop: number;
  /** Number of items to render outside viewport (default: 5) */
  overscan?: number;
}

/**
 * Result of virtual list calculation.
 */
export interface IVirtualListResult {
  /** Index of first item to render */
  startIndex: number;
  /** Index of last item to render (exclusive) */
  endIndex: number;
  /** Offset for the first rendered item */
  offsetTop: number;
  /** Total height of all items */
  totalHeight: number;
  /** Number of items to render */
  visibleCount: number;
}

/**
 * Calculate which items to render in a virtual list.
 *
 * @param config - Virtual list configuration
 * @returns Calculation result with indices and offsets
 */
export function calculateVirtualList(config: IVirtualListConfig): IVirtualListResult {
  const { totalItems, itemHeight, viewportHeight, scrollTop, overscan = 5 } = config;

  if (totalItems === 0 || itemHeight === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      offsetTop: 0,
      totalHeight: 0,
      visibleCount: 0,
    };
  }

  const totalHeight = totalItems * itemHeight;
  const visibleCount = Math.ceil(viewportHeight / itemHeight);

  // Calculate start index with overscan
  const rawStartIndex = Math.floor(scrollTop / itemHeight);
  const startIndex = Math.max(0, rawStartIndex - overscan);

  // Calculate end index with overscan
  const rawEndIndex = rawStartIndex + visibleCount;
  const endIndex = Math.min(totalItems, rawEndIndex + overscan);

  // Calculate offset for positioning
  const offsetTop = startIndex * itemHeight;

  return {
    startIndex,
    endIndex,
    offsetTop,
    totalHeight,
    visibleCount: endIndex - startIndex,
  };
}

/**
 * Debounce function for scroll handlers.
 *
 * @param fn - Function to debounce
 * @param delay - Delay in milliseconds
 * @returns Debounced function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>): void => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * Throttle function for scroll handlers.
 *
 * @param fn - Function to throttle
 * @param limit - Minimum time between calls in milliseconds
 * @returns Throttled function
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>): void => {
    const now = Date.now();

    if (now - lastCall >= limit) {
      lastCall = now;
      fn(...args);
    } else if (!timeoutId) {
      timeoutId = setTimeout(
        () => {
          lastCall = Date.now();
          fn(...args);
          timeoutId = null;
        },
        limit - (now - lastCall)
      );
    }
  };
}

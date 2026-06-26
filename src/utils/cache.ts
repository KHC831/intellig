/**
 * Caching utilities for performance optimization.
 *
 * This module provides a generic LRU (Least Recently Used) cache implementation
 * and specialized caches for Git data to improve performance with large repositories.
 */

/**
 * Options for configuring the LRU cache.
 */
export interface ILRUCacheOptions<K, V> {
  /** Maximum number of entries in the cache */
  maxSize: number;
  /** Time-to-live in milliseconds (0 = no expiration) */
  ttl?: number;
  /** Optional callback when an entry is evicted */
  onEvict?: (key: K, value: V) => void;
}

/**
 * Cache entry with metadata for LRU tracking.
 */
interface ICacheEntry<V> {
  value: V;
  timestamp: number;
  lastAccessed: number;
}

/**
 * Generic LRU (Least Recently Used) cache implementation.
 *
 * Features:
 * - Configurable maximum size with automatic eviction
 * - Optional TTL (time-to-live) for entries
 * - O(1) get/set operations using Map
 * - Eviction callback support
 *
 * @template K - Key type
 * @template V - Value type
 */
export class LRUCache<K, V> {
  private _cache: Map<K, ICacheEntry<V>> = new Map();
  private _maxSize: number;
  private _ttl: number;
  private _onEvict?: (key: K, value: V) => void;

  constructor(options: ILRUCacheOptions<K, V>) {
    this._maxSize = options.maxSize;
    this._ttl = options.ttl ?? 0;
    this._onEvict = options.onEvict;
  }

  /**
   * Get a value from the cache.
   *
   * @param key - The key to look up
   * @returns The cached value, or undefined if not found or expired
   */
  get(key: K): V | undefined {
    const entry = this._cache.get(key);

    if (!entry) {
      return undefined;
    }

    // Check TTL expiration
    if (this._ttl > 0 && Date.now() - entry.timestamp > this._ttl) {
      this.delete(key);
      return undefined;
    }

    // Update last accessed time for LRU tracking
    entry.lastAccessed = Date.now();

    return entry.value;
  }

  /**
   * Set a value in the cache.
   *
   * @param key - The key to store
   * @param value - The value to store
   */
  set(key: K, value: V): void {
    // If key exists, update it
    if (this._cache.has(key)) {
      const entry = this._cache.get(key)!;
      entry.value = value;
      entry.timestamp = Date.now();
      entry.lastAccessed = Date.now();
      return;
    }

    // Evict if at capacity
    if (this._cache.size >= this._maxSize) {
      this._evictLRU();
    }

    // Add new entry
    const now = Date.now();
    this._cache.set(key, {
      value,
      timestamp: now,
      lastAccessed: now,
    });
  }

  /**
   * Check if a key exists in the cache (without updating LRU).
   *
   * @param key - The key to check
   * @returns True if the key exists and is not expired
   */
  has(key: K): boolean {
    const entry = this._cache.get(key);

    if (!entry) {
      return false;
    }

    // Check TTL expiration
    if (this._ttl > 0 && Date.now() - entry.timestamp > this._ttl) {
      this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete a key from the cache.
   *
   * @param key - The key to delete
   * @returns True if the key was deleted
   */
  delete(key: K): boolean {
    const entry = this._cache.get(key);

    if (entry && this._onEvict) {
      this._onEvict(key, entry.value);
    }

    return this._cache.delete(key);
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    if (this._onEvict) {
      for (const [key, entry] of this._cache) {
        this._onEvict(key, entry.value);
      }
    }
    this._cache.clear();
  }

  /**
   * Get the current size of the cache.
   */
  get size(): number {
    return this._cache.size;
  }

  /**
   * Get all keys in the cache.
   */
  keys(): IterableIterator<K> {
    return this._cache.keys();
  }

  /**
   * Invalidate entries matching a predicate.
   *
   * @param predicate - Function that returns true for keys to invalidate
   */
  invalidateWhere(predicate: (key: K) => boolean): void {
    const keysToDelete: K[] = [];

    for (const key of this._cache.keys()) {
      if (predicate(key)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.delete(key);
    }
  }

  /**
   * Evict the least recently used entry.
   */
  private _evictLRU(): void {
    let oldestKey: K | undefined;
    let oldestTime = Infinity;

    for (const [key, entry] of this._cache) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      this.delete(oldestKey);
    }
  }

  /**
   * Remove expired entries from the cache.
   * Call this periodically to clean up expired entries.
   */
  pruneExpired(): void {
    if (this._ttl <= 0) {
      return;
    }

    const now = Date.now();
    const keysToDelete: K[] = [];

    for (const [key, entry] of this._cache) {
      if (now - entry.timestamp > this._ttl) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.delete(key);
    }
  }
}

/**
 * Cache key generator for Git operations.
 */
export function createCacheKey(...parts: (string | number | undefined)[]): string {
  return parts.filter((p) => p !== undefined).join(':');
}

/**
 * Default cache configurations for different Git data types.
 */
export const DEFAULT_CACHE_CONFIGS = {
  /** Cache for branch lists - moderate size, short TTL */
  branches: {
    maxSize: 50,
    ttl: 10000, // 10 seconds
  },
  /** Cache for commit data - large size, longer TTL */
  commits: {
    maxSize: 1000,
    ttl: 60000, // 1 minute
  },
  /** Cache for file status - small size, very short TTL */
  status: {
    maxSize: 20,
    ttl: 5000, // 5 seconds
  },
  /** Cache for blame data - moderate size, longer TTL */
  blame: {
    maxSize: 100,
    ttl: 30000, // 30 seconds
  },
  /** Cache for diff data - moderate size, short TTL */
  diff: {
    maxSize: 100,
    ttl: 10000, // 10 seconds
  },
  /** Cache for log data - large size, moderate TTL */
  log: {
    maxSize: 200,
    ttl: 30000, // 30 seconds
  },
};

/**
 * Centralized cache manager for Git service operations.
 * Provides typed caches for different Git data types with appropriate configurations.
 */
export class GitCacheManager {
  private _branchCache: LRUCache<string, unknown>;
  private _commitCache: LRUCache<string, unknown>;
  private _statusCache: LRUCache<string, unknown>;
  private _blameCache: LRUCache<string, unknown>;
  private _diffCache: LRUCache<string, unknown>;
  private _logCache: LRUCache<string, unknown>;

  constructor() {
    this._branchCache = new LRUCache(DEFAULT_CACHE_CONFIGS.branches);
    this._commitCache = new LRUCache(DEFAULT_CACHE_CONFIGS.commits);
    this._statusCache = new LRUCache(DEFAULT_CACHE_CONFIGS.status);
    this._blameCache = new LRUCache(DEFAULT_CACHE_CONFIGS.blame);
    this._diffCache = new LRUCache(DEFAULT_CACHE_CONFIGS.diff);
    this._logCache = new LRUCache(DEFAULT_CACHE_CONFIGS.log);
  }

  /**
   * Get the branch cache.
   */
  get branches(): LRUCache<string, unknown> {
    return this._branchCache;
  }

  /**
   * Get the commit cache.
   */
  get commits(): LRUCache<string, unknown> {
    return this._commitCache;
  }

  /**
   * Get the status cache.
   */
  get status(): LRUCache<string, unknown> {
    return this._statusCache;
  }

  /**
   * Get the blame cache.
   */
  get blame(): LRUCache<string, unknown> {
    return this._blameCache;
  }

  /**
   * Get the diff cache.
   */
  get diff(): LRUCache<string, unknown> {
    return this._diffCache;
  }

  /**
   * Get the log cache.
   */
  get log(): LRUCache<string, unknown> {
    return this._logCache;
  }

  /**
   * Invalidate all caches for a repository.
   *
   * @param repoPath - The repository path to invalidate
   */
  invalidateRepository(repoPath: string): void {
    // Match on the `:` delimiter (cache keys are `repoPath:…` via createCacheKey)
    // so `/a/repo` doesn't also invalidate a sibling `/a/repo2`'s entries.
    const prefix = `${repoPath}:`;
    const predicate = (key: string): boolean => key === repoPath || key.startsWith(prefix);

    this._branchCache.invalidateWhere(predicate);
    this._commitCache.invalidateWhere(predicate);
    this._statusCache.invalidateWhere(predicate);
    this._blameCache.invalidateWhere(predicate);
    this._diffCache.invalidateWhere(predicate);
    this._logCache.invalidateWhere(predicate);
  }

  /**
   * Clear all caches.
   */
  clearAll(): void {
    this._branchCache.clear();
    this._commitCache.clear();
    this._statusCache.clear();
    this._blameCache.clear();
    this._diffCache.clear();
    this._logCache.clear();
  }

  /**
   * Prune expired entries from all caches.
   */
  pruneExpired(): void {
    this._branchCache.pruneExpired();
    this._commitCache.pruneExpired();
    this._statusCache.pruneExpired();
    this._blameCache.pruneExpired();
    this._diffCache.pruneExpired();
    this._logCache.pruneExpired();
  }
}

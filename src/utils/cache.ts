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
 * Cache entry with metadata.
 *
 * LRU ordering is tracked by Map insertion order (not a field here). The
 * `timestamp` field is used only for TTL expiration checks in `get`/`has`.
 */
interface ICacheEntry<V> {
  value: V;
  /** Time of insertion or last update; used for TTL expiration. */
  timestamp: number;
}

/**
 * Generic LRU (Least Recently Used) cache implementation.
 *
 * Features:
 * - Configurable maximum size with automatic eviction
 * - Optional TTL (time-to-live) for entries
 * - O(1) get/set/evict operations using Map insertion order
 * - Eviction callback support
 *
 * LRU ordering is maintained via Map insertion order: every `get` and `set`
 * on an existing key delete-and-reinsert the entry so it moves to the end
 * (MRU position). `_evictLRU` then reads the first key via
 * `_cache.keys().next()` (O(1)) rather than scanning all entries.
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
   * Promotes the entry to the MRU position via delete-and-reinsert so the
   * Map insertion order always reflects recency.
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

    // Promote to MRU position: remove from current insertion-order slot and
    // re-insert at the end so _evictLRU() finds the actual LRU at the front.
    this._cache.delete(key);
    this._cache.set(key, entry);

    return entry.value;
  }

  /**
   * Set a value in the cache.
   *
   * When updating an existing key the entry is delete-and-reinserted (MRU
   * promotion, same as `get`). New entries are appended at the end (MRU).
   *
   * @param key - The key to store
   * @param value - The value to store
   */
  set(key: K, value: V): void {
    const now = Date.now();

    // If key exists, update and promote to MRU position.
    if (this._cache.has(key)) {
      this._cache.delete(key);
      this._cache.set(key, { value, timestamp: now });
      return;
    }

    // Evict if at capacity
    if (this._cache.size >= this._maxSize) {
      this._evictLRU();
    }

    // Append new entry at the MRU end.
    this._cache.set(key, { value, timestamp: now });
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
   *
   * Because every access (get/set) promotes the entry to the MRU end via
   * delete-and-reinsert, the LRU entry is always the FIRST key in Map
   * insertion order — readable in O(1) via `keys().next()`.
   */
  private _evictLRU(): void {
    const lruKey = this._cache.keys().next().value;
    if (lruKey !== undefined) {
      this.delete(lruKey);
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

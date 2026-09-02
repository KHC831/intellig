/**
 * Persisted-state slots for the Commit tool window.
 *
 * The workspaceState keys, their type guards and the validated slots that read
 * them, kept together so a key, its guard and its slot cannot drift apart.
 */

import type { PersistedSlot } from '../utils/persistedState';
import { readBoolean, readEnum, readStringArray } from '../utils/persistedState';
import type {
  ChangesGroupingMode,
  CommitToolWindowTab,
  ShelfTabFilter,
} from './commitToolWindow.types';

/** workspaceState key for the currently-active tab (Local Changes / Shelf). */
export const ACTIVE_TAB_STATE_KEY = 'intellig.commitToolWindow.activeTab';

/** workspaceState key for the recent-commit-messages LRU. */
export const RECENT_MESSAGES_STATE_KEY = 'intellig.recentCommitMessages';

/**
 * workspaceState key for the Shelf-tab filter toggle.
 * One of `'shelves' | 'stashes' | 'both'` (default `'both'`).
 */
export const SHELF_TAB_FILTER_STATE_KEY = 'intellig.commitToolWindow.shelfFilter';

/** workspaceState key for the sticky Sign-off checkbox. */
export const SIGN_OFF_STATE_KEY = 'intellig.commitToolWindow.signOff';

/** workspaceState key persisting the Local Changes grouping mode. */
export const CHANGES_GROUPING_STATE_KEY = 'intellig.commitToolWindow.changesGrouping';

/**
 * Whitelist valid filter strings. Used when hydrating persisted filter
 * state so a corrupt workspaceState value falls back to `'both'`.
 */
export function isShelfTabFilter(value: unknown): value is ShelfTabFilter {
  return value === 'shelves' || value === 'stashes' || value === 'both';
}

/** Type-guard for a persisted grouping value. */
export function isChangesGroupingMode(value: unknown): value is ChangesGroupingMode {
  return value === 'flat' || value === 'directory';
}

/** Persisted slot for the active tab (Local Changes / Shelf). */
export const ACTIVE_TAB_SLOT: PersistedSlot<CommitToolWindowTab> = {
  key: ACTIVE_TAB_STATE_KEY,
  version: 1,
  validate: readEnum<CommitToolWindowTab>(['localChanges', 'shelf']),
};

/** Persisted slot for the Shelf-tab filter toggle. */
export const SHELF_TAB_FILTER_SLOT: PersistedSlot<ShelfTabFilter> = {
  key: SHELF_TAB_FILTER_STATE_KEY,
  version: 1,
  validate: (raw) => (isShelfTabFilter(raw) ? raw : undefined),
};

/** Persisted slot for the recent-commit-messages LRU (shared with CommitDialog). */
export const RECENT_MESSAGES_SLOT: PersistedSlot<string[]> = {
  key: RECENT_MESSAGES_STATE_KEY,
  version: 1,
  validate: readStringArray,
};

/**
 * Persisted slot for the Sign-off checkbox — a sticky preference like
 * IntelliJ's (GitCommitOptions persists it), not per-commit state.
 */
export const SIGN_OFF_SLOT: PersistedSlot<boolean> = {
  key: SIGN_OFF_STATE_KEY,
  version: 1,
  validate: readBoolean,
};

/** Persisted slot for the Local Changes grouping mode. */
export const CHANGES_GROUPING_SLOT: PersistedSlot<ChangesGroupingMode> = {
  key: CHANGES_GROUPING_STATE_KEY,
  version: 1,
  validate: (raw) => (isChangesGroupingMode(raw) ? raw : undefined),
};

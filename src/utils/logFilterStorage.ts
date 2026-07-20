/**
 * Log-filter persistence for the Git tool window: the active ILogFilter
 * survives a window reload instead of silently resetting to "all commits"
 * while the filter row still shows the old values.
 *
 * ADR-003 storage discipline: the stored payload is validated FIELD BY FIELD
 * on load (wrong types and unparseable dates load as "no filter", unknown
 * fields are dropped) through the shared {@link PersistedSlot} seam, which also
 * adds the version envelope and keeps legacy bare values loading.
 */

import type * as vscode from 'vscode';
import type { ILogFilter } from '../git-core/interfaces/IGitToolWindowProvider';
import {
  loadPersisted,
  savePersisted,
  readString,
  readBoolean,
  readNonNegativeInteger,
  readStringArray,
  readDate,
  type PersistedSlot,
} from './persistedState';

/** Validate a raw payload into an ILogFilter, keeping only well-typed fields. */
function validateLogFilter(raw: unknown): ILogFilter | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const src = raw as Record<string, unknown>;
  const filter: ILogFilter = {};

  const assign = <T>(key: keyof ILogFilter, value: T | undefined): void => {
    if (value !== undefined) {
      (filter as Record<string, unknown>)[key] = value;
    }
  };

  assign('branch', readString(src.branch));
  assign('branches', readStringArray(src.branches));
  assign('branchesNone', readBoolean(src.branchesNone));
  assign('author', readString(src.author));
  assign('authors', readStringArray(src.authors));
  assign('since', readDate(src.since));
  assign('until', readDate(src.until));
  assign('path', readString(src.path));
  assign('paths', readStringArray(src.paths));
  assign('searchText', readString(src.searchText));
  assign('searchRegex', readBoolean(src.searchRegex));
  assign('searchCaseSensitive', readBoolean(src.searchCaseSensitive));
  assign('noMerges', readBoolean(src.noMerges));
  assign('firstParent', readBoolean(src.firstParent));
  assign('simplifyMerges', readBoolean(src.simplifyMerges));
  assign('minParents', readNonNegativeInteger(src.minParents));
  assign('maxParents', readNonNegativeInteger(src.maxParents));
  assign('logRange', readString(src.logRange));
  // A preset only names the instant already stored in `since`; an unknown
  // value, or one with no `since`, leaves the range reading as custom.
  const datePreset = readString(src.datePreset);
  if (filter.since !== undefined && (datePreset === '24h' || datePreset === '7d')) {
    filter.datePreset = datePreset;
  }

  return Object.keys(filter).length > 0 ? filter : undefined;
}

/** Persisted slot for the active log filter (Dates serialized as ISO strings). */
export const LOG_FILTER_SLOT: PersistedSlot<ILogFilter> = {
  key: 'intellig.logFilter',
  version: 1,
  validate: validateLogFilter,
  serialize: (filter) => ({
    ...filter,
    since: filter.since?.toISOString(),
    until: filter.until?.toISOString(),
  }),
};

/** Persist the filter (Dates → ISO strings); `undefined` clears the slot. */
export function saveLogFilter(state: vscode.Memento, filter: ILogFilter | undefined): void {
  void savePersisted(state, LOG_FILTER_SLOT, filter);
}

/**
 * Load the persisted filter, or `undefined` when nothing valid is stored.
 * A payload that yields zero valid fields (junk, wrong types) is "no filter" —
 * the log must never fail to load because storage soured.
 */
export function loadLogFilter(state: vscode.Memento): ILogFilter | undefined {
  return loadPersisted(state, LOG_FILTER_SLOT);
}

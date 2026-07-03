/**
 * Log-filter persistence for the Git tool window: the active ILogFilter
 * survives a window reload instead of silently resetting to "all commits"
 * while the filter row still shows the old values.
 *
 * ADR-003 storage discipline: the stored payload is validated FIELD BY FIELD
 * on load — wrong types and unparseable dates load as "no filter", unknown
 * fields are dropped rather than resurrected into a future ILogFilter shape.
 */

import type * as vscode from 'vscode';
import type { ILogFilter } from '../git-core/interfaces/IGitToolWindowProvider';

const LOG_FILTER_KEY = 'intellig.logFilter';

/** Persist the filter (Dates → ISO strings); `undefined` clears the slot. */
export function saveLogFilter(state: vscode.Memento, filter: ILogFilter | undefined): void {
  if (!filter) {
    void state.update(LOG_FILTER_KEY, undefined);
    return;
  }
  void state.update(LOG_FILTER_KEY, {
    ...filter,
    since: filter.since?.toISOString(),
    until: filter.until?.toISOString(),
  });
}

function readString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function readBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function readNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function readStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string')) {
    return undefined;
  }
  return v;
}

function readDate(v: unknown): Date | undefined {
  if (typeof v !== 'string') {
    return undefined;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Load the persisted filter, or `undefined` when nothing valid is stored.
 * A payload that yields zero valid fields (junk, wrong types) is "no
 * filter" — the log must never fail to load because storage soured.
 */
export function loadLogFilter(state: vscode.Memento): ILogFilter | undefined {
  const stored = state.get<unknown>(LOG_FILTER_KEY);
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return undefined;
  }
  const raw = stored as Record<string, unknown>;
  const filter: ILogFilter = {};

  const assign = <T>(key: keyof ILogFilter, value: T | undefined): void => {
    if (value !== undefined) {
      (filter as Record<string, unknown>)[key] = value;
    }
  };

  assign('branch', readString(raw.branch));
  assign('branches', readStringArray(raw.branches));
  assign('branchesNone', readBoolean(raw.branchesNone));
  assign('author', readString(raw.author));
  assign('since', readDate(raw.since));
  assign('until', readDate(raw.until));
  assign('path', readString(raw.path));
  assign('paths', readStringArray(raw.paths));
  assign('searchText', readString(raw.searchText));
  assign('searchRegex', readBoolean(raw.searchRegex));
  assign('searchCaseSensitive', readBoolean(raw.searchCaseSensitive));
  assign('noMerges', readBoolean(raw.noMerges));
  assign('firstParent', readBoolean(raw.firstParent));
  assign('simplifyMerges', readBoolean(raw.simplifyMerges));
  assign('minParents', readNumber(raw.minParents));
  assign('maxParents', readNumber(raw.maxParents));
  assign('logRange', readString(raw.logRange));

  return Object.keys(filter).length > 0 ? filter : undefined;
}

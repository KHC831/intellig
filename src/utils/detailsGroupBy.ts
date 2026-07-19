/**
 * Group By mode for the Details Panel's changed-file list.
 *
 * IntelliJ's changes lists always offer a GroupBy; the choice is a UI
 * preference rather than per-commit state, so it persists per workspace and
 * survives a window reload.
 */

import type { DetailsGroupBy } from '../git-core/gitToolWindow/provider/detailsPanelModel.types';
import {
  loadPersisted,
  savePersisted,
  type MementoLike,
  type PersistedSlot,
} from './persistedState';

export type { DetailsGroupBy };

const DEFAULT_GROUP_BY: DetailsGroupBy = 'tree';

function isDetailsGroupBy(value: unknown): value is DetailsGroupBy {
  return value === 'tree' || value === 'flat';
}

/** Persisted slot for the changed-files Group By mode. */
export const DETAILS_GROUP_BY_SLOT: PersistedSlot<DetailsGroupBy> = {
  key: 'intellig.detailsGroupBy',
  version: 1,
  validate: (raw) => (isDetailsGroupBy(raw) ? raw : undefined),
};

/** Persist the Group By mode. */
export function saveDetailsGroupBy(state: MementoLike, mode: DetailsGroupBy): void {
  void savePersisted(state, DETAILS_GROUP_BY_SLOT, mode);
}

/** Load the Group By mode, falling back to the compacted tree. */
export function loadDetailsGroupBy(state: MementoLike): DetailsGroupBy {
  return loadPersisted(state, DETAILS_GROUP_BY_SLOT) ?? DEFAULT_GROUP_BY;
}

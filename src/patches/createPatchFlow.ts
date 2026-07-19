/**
 * Shared pieces of the Create Patch flows (repo-wide "Create Patch from Local
 * Changes", the explorer's per-file variant, and the commit context menu's
 * `format-patch` save), so the three surfaces can't drift in what they
 * persist or where they open the save dialog.
 *
 * Mirrors IntelliJ CreatePatchCommitExecutor
 * (platform/vcs-impl/src/com/intellij/openapi/vcs/changes/patch/
 * CreatePatchCommitExecutor.java): the destination path persists under
 * `vcs.patch.path` and defaults to the project base dir, while Reverse is
 * reset on every open (`myPanel.setReversePatch(false)`).
 */

import * as path from 'path';
import * as vscode from 'vscode';
import {
  loadPersisted,
  savePersisted,
  type MementoLike,
  type PersistedSlot,
} from '../utils/persistedState';

/** A destination row of the Create Patch pick. */
export type PatchDestination = 'file' | 'clipboard';

const DESTINATIONS: readonly string[] = ['file', 'clipboard'];

/**
 * Validate a persisted destination set: known ids only, at least one.
 *
 * A set carrying `reverse` is a pre-existing blob from when the option was
 * persisted; rejecting it (rather than filtering it out) drops the whole
 * stale entry so the pick reopens with the caller's default.
 */
export function validatePatchDestinations(raw: unknown): PatchDestination[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  if (!raw.every((v): v is PatchDestination => typeof v === 'string' && DESTINATIONS.includes(v))) {
    return undefined;
  }
  return [...new Set(raw)];
}

/** Persisted destinations for the Create Patch pick (never the Reverse tick). */
export const PATCH_DESTINATIONS_SLOT: PersistedSlot<PatchDestination[]> = {
  key: 'intellig.patch.createFromLocalPicks',
  version: 2,
  validate: validatePatchDestinations,
};

/** Persisted directory of the last saved patch — IntelliJ's `vcs.patch.path`. */
export const LAST_PATCH_DIR_SLOT: PersistedSlot<string> = {
  key: 'intellig.patch.lastDir',
  version: 1,
  validate: (raw) => (typeof raw === 'string' && raw.length > 0 ? raw : undefined),
};

/**
 * Seed URI for a patch save dialog: the last directory the user saved a patch
 * into, falling back to the repo root. A `undefined` store (a late-bound
 * ExtensionContext that hasn't landed yet) just means "no memory".
 */
export function patchSaveDefaultUri(
  state: MementoLike | undefined,
  repoRootUri: vscode.Uri,
  basename: string
): vscode.Uri {
  const lastDir = state === undefined ? undefined : loadPersisted(state, LAST_PATCH_DIR_SLOT);
  return lastDir === undefined
    ? vscode.Uri.joinPath(repoRootUri, basename)
    : vscode.Uri.file(path.join(lastDir, basename));
}

/** Remember the directory of a just-saved patch so the next dialog opens there. */
export async function rememberPatchDir(
  state: MementoLike | undefined,
  savedUri: vscode.Uri
): Promise<void> {
  if (state === undefined) {
    return;
  }
  await savePersisted(state, LAST_PATCH_DIR_SLOT, path.dirname(savedUri.fsPath));
}

/** One row of the Create Patch multi-pick. */
type PatchPickItem = vscode.QuickPickItem & { id: PatchDestination | 'reverse' };

/** What the user chose in the Create Patch pick. */
export interface ICreatePatchChoice {
  destinations: PatchDestination[];
  reverse: boolean;
}

/**
 * Show the shared Create Patch multi-pick (destinations + Reverse), reopened
 * with the last destinations and Reverse always unticked.
 *
 * Returns `undefined` when the user dismisses the pick or leaves it without a
 * destination — the caller treats both as "do nothing". `offerReverse` hides
 * the row for callers whose patch source has no meaningful reverse.
 */
export async function promptCreatePatchChoice(
  state: MementoLike,
  options: { offerReverse: boolean; placeHolder: string }
): Promise<ICreatePatchChoice | undefined> {
  const remembered = loadPersisted(state, PATCH_DESTINATIONS_SLOT) ?? ['file'];
  const items: PatchPickItem[] = [
    { label: '$(file) Save to file…', id: 'file', picked: remembered.includes('file') },
    {
      label: '$(clippy) Copy to clipboard',
      id: 'clipboard',
      picked: remembered.includes('clipboard'),
    },
  ];
  if (options.offerReverse) {
    // Never pre-picked: a remembered tick would silently invert the patch.
    items.push({
      label: '$(arrow-swap) Reverse (-R)',
      description: 'Applying the patch undoes the local changes',
      id: 'reverse',
      picked: false,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: options.placeHolder,
  });
  if (picked === undefined) {
    return undefined;
  }

  const ids = picked.map((item) => item.id);
  const destinations = ids.filter((id): id is PatchDestination => id !== 'reverse');
  if (destinations.length === 0) {
    void vscode.window.showInformationMessage('Pick at least one destination (file or clipboard).');
    return undefined;
  }

  await savePersisted(state, PATCH_DESTINATIONS_SLOT, destinations);
  return { destinations, reverse: ids.includes('reverse') };
}

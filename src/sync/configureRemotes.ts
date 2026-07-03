/**
 * Configure Remotes — IntelliJ's GitConfigureRemotesDialog expressed as a
 * looping QuickPick wizard (this repo's dialog idiom). The list shows every
 * remote origin-first with its fetch URL; actions are add / rename /
 * change-URL / remove, and the flow returns to the list after each action
 * (the IntelliJ dialog stays open until OK). Remove takes exactly ONE modal
 * confirm per the minimal destructive-op policy; a newly-defined remote is
 * fetched right away (GitDefineRemoteDialog's fetch checkbox defaults on).
 *
 * Dependency-injected so unit tests drive the whole flow headlessly; the
 * command wrapper in `commitRepoCoreCommands.ts` wires the real
 * `vscode.window` helpers.
 */

import * as vscode from 'vscode';
import { sanitizeGitError } from '../git-core/gitError';
import type { IGitService, IRemote, IRepository } from '../git-core/interfaces/IGitService';

/** Ordering used by IntelliJ's remotes table: origin first, then by name. */
export function sortRemotesOriginFirst(remotes: IRemote[]): IRemote[] {
  return [...remotes].sort((a, b) => {
    if (a.name === 'origin') {
      return b.name === 'origin' ? 0 : -1;
    }
    if (b.name === 'origin') {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * Remote-name validation for input boxes. Mirrors GitRefNameValidator's
 * rules (remotes share the ref-name charset) plus uniqueness against the
 * repo's existing remotes; `originalName` exempts an unchanged edit.
 */
export function validateRemoteName(
  name: string,
  existingNames: string[],
  originalName?: string
): string | undefined {
  if (!name || name.trim().length === 0) {
    return 'Remote name cannot be empty';
  }
  if (/\s/.test(name)) {
    return 'Remote name cannot contain whitespace';
  }
  if (/[~^:?*[\\]/.test(name)) {
    return 'Remote name cannot contain any of ~ ^ : ? * [ \\';
  }
  if (name.includes('..')) {
    return 'Remote name cannot contain consecutive dots';
  }
  if (name.startsWith('-') || name.startsWith('.') || name.startsWith('/')) {
    return 'Remote name cannot start with -, ., or /';
  }
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) {
    return 'Remote name cannot end with ., /, or .lock';
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return 'Remote name cannot contain control characters';
    }
  }
  if (name !== originalName && existingNames.includes(name)) {
    return `Remote '${name}' already exists`;
  }
  return undefined;
}

/** Remote-URL validation: non-blank and not option-shaped. */
export function validateRemoteUrl(url: string): string | undefined {
  if (!url || url.trim().length === 0) {
    return 'Remote URL cannot be empty';
  }
  if (url.startsWith('-')) {
    return 'Remote URL cannot start with -';
  }
  return undefined;
}

/** Injected seams for {@link runConfigureRemotesFlow}. */
export interface IConfigureRemotesDeps {
  repo: IRepository;
  gitService: IGitService;
  showQuickPick: (
    items: vscode.QuickPickItem[],
    options: vscode.QuickPickOptions
  ) => Thenable<vscode.QuickPickItem | undefined>;
  showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
  showInformationMessage: (message: string) => Thenable<string | undefined>;
  showErrorMessage: (message: string) => Thenable<string | undefined>;
  /** Modal confirm helper (`vscode.window.showWarningMessage` shape). */
  showWarningMessage: (
    message: string,
    options: { modal: boolean },
    ...items: string[]
  ) => Thenable<string | undefined>;
  /**
   * Fetch a just-added remote (IntelliJ fetches after define by default).
   * Failures throw; the flow downgrades them to a warning because the add
   * itself succeeded.
   */
  fetchRemote?: (remoteName: string) => Promise<void>;
  /** Refresh hook invoked after every successful mutation. */
  onRemotesChanged?: () => Promise<void> | void;
}

const ADD_LABEL = '$(add) Add Remote…';

/**
 * The Configure Remotes wizard. Loops the remotes list until the user
 * dismisses it; every mutation re-reads remotes from git so the list is
 * always current.
 */
export async function runConfigureRemotesFlow(deps: IConfigureRemotesDeps): Promise<void> {
  for (;;) {
    let remotes: IRemote[];
    try {
      remotes = await deps.gitService.getRemotes(deps.repo).match(
        (r) => r,
        (e) => {
          throw e;
        }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void deps.showErrorMessage(`Failed to list remotes: ${sanitizeGitError(msg)}`);
      return;
    }

    const sorted = sortRemotesOriginFirst(remotes);
    const remoteItems: vscode.QuickPickItem[] = sorted.map((r) => ({
      label: `$(cloud) ${r.name}`,
      description: r.fetchUrl ?? '',
    }));
    const items: vscode.QuickPickItem[] = [
      ...remoteItems,
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: ADD_LABEL },
    ];

    const picked = await deps.showQuickPick(items, {
      title: 'Configure Remotes',
      placeHolder: sorted.length === 0 ? 'No remotes defined — add one' : 'Select a remote to edit',
    });
    if (!picked) {
      return;
    }

    if (picked.label === ADD_LABEL) {
      await addRemoteFlow(deps, sorted);
      continue;
    }

    const remote = sorted.find((r) => `$(cloud) ${r.name}` === picked.label);
    if (!remote) {
      continue;
    }
    await editRemoteFlow(deps, sorted, remote);
  }
}

async function addRemoteFlow(deps: IConfigureRemotesDeps, existing: IRemote[]): Promise<void> {
  const existingNames = existing.map((r) => r.name);
  // GitConfigureRemotesDialog proposes "origin" when the repo has none.
  const proposedName = existingNames.includes('origin') ? '' : 'origin';
  const name = await deps.showInputBox({
    title: 'Add Remote',
    prompt: 'Remote name',
    value: proposedName,
    validateInput: (value: string) => validateRemoteName(value.trim(), existingNames),
  });
  if (!name || name.trim().length === 0) {
    return;
  }
  const url = await deps.showInputBox({
    title: 'Add Remote',
    prompt: 'Remote URL',
    placeHolder: 'e.g., https://example.com/repo.git',
    validateInput: (value: string) => validateRemoteUrl(value.trim()),
  });
  if (!url || url.trim().length === 0) {
    return;
  }

  const trimmedName = name.trim();
  const ok = await runRemoteOp(deps, `Failed to add remote '${trimmedName}'`, () =>
    deps.gitService.addRemote(deps.repo, trimmedName, url.trim())
  );
  if (!ok) {
    return;
  }
  void deps.showInformationMessage(`Added remote: ${trimmedName}`);
  await notifyChanged(deps);
  if (deps.fetchRemote) {
    try {
      await deps.fetchRemote(trimmedName);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      void deps.showWarningMessage(
        `Remote '${trimmedName}' was added, but the initial fetch failed: ${sanitizeGitError(msg)}`,
        { modal: false }
      );
    }
  }
}

async function editRemoteFlow(
  deps: IConfigureRemotesDeps,
  existing: IRemote[],
  remote: IRemote
): Promise<void> {
  const action = await deps.showQuickPick(
    [{ label: '$(edit) Rename…' }, { label: '$(link) Change URL…' }, { label: '$(trash) Remove' }],
    {
      title: `Remote '${remote.name}'`,
      placeHolder: remote.fetchUrl ?? '',
    }
  );
  if (!action) {
    return;
  }

  if (action.label.includes('Rename')) {
    const existingNames = existing.map((r) => r.name);
    const newName = await deps.showInputBox({
      title: `Rename Remote '${remote.name}'`,
      prompt: 'New remote name',
      value: remote.name,
      validateInput: (value: string) =>
        validateRemoteName(value.trim(), existingNames, remote.name),
    });
    if (!newName || newName.trim().length === 0 || newName.trim() === remote.name) {
      return;
    }
    const ok = await runRemoteOp(deps, `Failed to rename remote '${remote.name}'`, () =>
      deps.gitService.renameRemote(deps.repo, remote.name, newName.trim())
    );
    if (ok) {
      void deps.showInformationMessage(`Renamed remote: ${remote.name} → ${newName.trim()}`);
      await notifyChanged(deps);
    }
    return;
  }

  if (action.label.includes('Change URL')) {
    const newUrl = await deps.showInputBox({
      title: `Change URL of Remote '${remote.name}'`,
      prompt: 'Remote URL',
      value: remote.fetchUrl ?? '',
      validateInput: (value: string) => validateRemoteUrl(value.trim()),
    });
    if (!newUrl || newUrl.trim().length === 0 || newUrl.trim() === remote.fetchUrl) {
      return;
    }
    const ok = await runRemoteOp(deps, `Failed to change URL of remote '${remote.name}'`, () =>
      deps.gitService.setRemoteUrl(deps.repo, remote.name, newUrl.trim())
    );
    if (ok) {
      void deps.showInformationMessage(`Updated URL of remote: ${remote.name}`);
      await notifyChanged(deps);
    }
    return;
  }

  // Remove — exactly one modal confirm (minimal destructive-op policy).
  const confirm = await deps.showWarningMessage(
    `Remove remote '${remote.name}'${remote.fetchUrl ? ` (${remote.fetchUrl})` : ''}?`,
    { modal: true },
    'Remove'
  );
  if (confirm !== 'Remove') {
    return;
  }
  const ok = await runRemoteOp(deps, `Failed to remove remote '${remote.name}'`, () =>
    deps.gitService.removeRemote(deps.repo, remote.name)
  );
  if (ok) {
    void deps.showInformationMessage(`Removed remote: ${remote.name}`);
    await notifyChanged(deps);
  }
}

/** Run one remote mutation; toast a sanitized error and report success. */
async function runRemoteOp(
  deps: IConfigureRemotesDeps,
  failureTitle: string,
  op: () => ReturnType<IGitService['addRemote']>
): Promise<boolean> {
  try {
    await op().match(
      () => undefined,
      (e) => {
        throw e;
      }
    );
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    void deps.showErrorMessage(`${failureTitle}: ${sanitizeGitError(msg)}`);
    return false;
  }
}

async function notifyChanged(deps: IConfigureRemotesDeps): Promise<void> {
  if (deps.onRemotesChanged) {
    await deps.onRemotesChanged();
  }
}

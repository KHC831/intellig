/**
 * Configure Remotes — IntelliJ's GitConfigureRemotesDialog expressed as a
 * looping QuickPick list (this repo's dialog idiom) over the Define Remote
 * dialog. The list shows every remote origin-first with its fetch URL; actions
 * are add / edit / remove, and the flow returns to the list after each action
 * (the IntelliJ dialog stays open until OK). Name and URL are always collected
 * together in the define dialog, which also owns the reachability probe.
 * Remove takes exactly ONE modal confirm per the minimal destructive-op
 * policy; a newly-defined remote is fetched right away when the dialog's fetch
 * checkbox is left on.
 *
 * Dependency-injected so unit tests drive the whole flow headlessly; the
 * command wrapper in `commitRepoCoreCommands.ts` wires the real
 * `vscode.window` helpers and the define dialog.
 */

import * as vscode from 'vscode';
import { sanitizeGitError } from '../git-core/gitError';
import type { IGitService, IRemote, IRepository } from '../git-core/interfaces/IGitService';
import type { IDefineRemoteRequest, IDefineRemoteResult } from './defineRemoteDialog.protocol';

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

// Validation lives in a vscode-free module so the dialog's webview entry
// enforces the same rules the flow does.
export { validateRemoteName, validateRemoteUrl } from './remoteValidation';

/** Injected seams for {@link runConfigureRemotesFlow}. */
export interface IConfigureRemotesDeps {
  repo: IRepository;
  gitService: IGitService;
  showQuickPick: (
    items: vscode.QuickPickItem[],
    options: vscode.QuickPickOptions
  ) => Thenable<vscode.QuickPickItem | undefined>;
  /**
   * Collect a remote's name + URL in one dialog (GitDefineRemoteDialog). The
   * dialog owns validation and the `git ls-remote` reachability probe, so it
   * resolves only with values that are safe to hand to git.
   */
  defineRemote: (request: IDefineRemoteRequest) => Promise<IDefineRemoteResult | undefined>;
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
const EDIT_LABEL = '$(edit) Edit…';

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
  const defined = await deps.defineRemote({
    title: 'Define Remote',
    name: existingNames.includes('origin') ? '' : 'origin',
    url: '',
    existingNames,
  });
  if (!defined) {
    return;
  }

  const ok = await runRemoteOp(deps, `Failed to add remote '${defined.name}'`, () =>
    deps.gitService.addRemote(deps.repo, defined.name, defined.url)
  );
  if (!ok) {
    return;
  }
  void deps.showInformationMessage(`Added remote: ${defined.name}`);
  await notifyChanged(deps);
  await fetchIfRequested(deps, defined);
}

/**
 * Fetch a just-defined remote when the dialog's fetch checkbox stayed on. The
 * define itself already succeeded, so a fetch failure is only a warning.
 */
async function fetchIfRequested(
  deps: IConfigureRemotesDeps,
  defined: IDefineRemoteResult
): Promise<void> {
  if (!defined.fetch || !deps.fetchRemote) {
    return;
  }
  try {
    await deps.fetchRemote(defined.name);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    void deps.showWarningMessage(
      `Remote '${defined.name}' was defined, but the initial fetch failed: ${sanitizeGitError(msg)}`,
      { modal: false }
    );
  }
}

async function editRemoteFlow(
  deps: IConfigureRemotesDeps,
  existing: IRemote[],
  remote: IRemote
): Promise<void> {
  const action = await deps.showQuickPick([{ label: EDIT_LABEL }, { label: '$(trash) Remove' }], {
    title: `Remote '${remote.name}'`,
    placeHolder: remote.fetchUrl ?? '',
  });
  if (!action) {
    return;
  }

  if (action.label === EDIT_LABEL) {
    await applyRemoteEdit(deps, existing, remote);
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

/**
 * Apply an edit from the define dialog: rename first, then re-point the URL
 * under the NEW name (GitConfigureRemotesDialog.changeRemote). A failed rename
 * leaves the URL alone so the remote never ends up half-updated.
 */
async function applyRemoteEdit(
  deps: IConfigureRemotesDeps,
  existing: IRemote[],
  remote: IRemote
): Promise<void> {
  const oldUrl = remote.fetchUrl ?? '';
  const defined = await deps.defineRemote({
    title: `Edit Remote '${remote.name}'`,
    name: remote.name,
    url: oldUrl,
    existingNames: existing.map((r) => r.name),
    originalName: remote.name,
  });
  if (!defined || (defined.name === remote.name && defined.url === oldUrl)) {
    return;
  }

  if (defined.name !== remote.name) {
    const renamed = await runRemoteOp(deps, `Failed to rename remote '${remote.name}'`, () =>
      deps.gitService.renameRemote(deps.repo, remote.name, defined.name)
    );
    if (!renamed) {
      return;
    }
  }
  if (defined.url !== oldUrl) {
    const repointed = await runRemoteOp(
      deps,
      `Failed to change URL of remote '${defined.name}'`,
      () => deps.gitService.setRemoteUrl(deps.repo, defined.name, defined.url)
    );
    if (!repointed) {
      return;
    }
  }
  void deps.showInformationMessage(`Updated remote: ${defined.name}`);
  await notifyChanged(deps);
  await fetchIfRequested(deps, defined);
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

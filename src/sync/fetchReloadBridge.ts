/**
 * Fetch → reload bridge.
 *
 * A fetch advances remote-tracking refs on disk, but the views that render
 * them (branch tree, graph, ahead/behind badges) refresh on
 * `onDidChangeRepository`, which only fires after a repository reload.
 * Normally the `.git/refs` watcher closes that gap; this bridge closes it at
 * the source instead, so every fetch surface — auto-fetch ticks, dialogs,
 * future callers — heals the views even when the watcher misses the writes
 * (network drives, user watcher excludes, watcher backend failures).
 *
 * One subscriber on `onDidFetch` rather than a reload call at each fetch
 * site: call sites that need reload-before-toast ordering still await their
 * own `reloadRepository`; the in-flight reload dedupe coalesces the overlap.
 */

import * as vscode from 'vscode';
import { IFetchResult, IRepository } from '../git-core/interfaces/IGitService';
import { safeFireAndForget } from '../utils/safeFireAndForget';

/** The two GitService capabilities the bridge needs. */
export interface IFetchReloadGitService {
  onDidFetch: vscode.Event<{ repo: IRepository; result: IFetchResult }>;
  reloadRepository(repo: IRepository): Promise<IRepository | undefined>;
}

/**
 * Reload a repository's cached state whenever a fetch advanced its refs.
 * A fetch that updated nothing is skipped so quiet auto-fetch ticks stay
 * quiet (no reload churn, no spurious repository-changed events).
 */
export function wireFetchReload(gitService: IFetchReloadGitService): vscode.Disposable {
  return gitService.onDidFetch(({ repo, result }) => {
    if (result.updatedRefs.length === 0) {
      return;
    }
    safeFireAndForget(
      gitService.reloadRepository(repo).then(() => undefined),
      `fetchReloadBridge: reload after fetch for ${repo.rootUri.fsPath}`
    );
  });
}

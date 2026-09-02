/**
 * Window-focus refs reconcile.
 *
 * The `.git` watchers are the primary signal for external repository changes,
 * but they can miss writes (user `files.watcherExclude` covering `.git`,
 * network drives, watcher backend failures) — and when they do, the branch
 * tree and graph stay stale until a window reload. IntelliJ self-heals this
 * class: `SaveAndSyncHandlerImpl` (platform/configuration-store-impl)
 * subscribes to `ApplicationActivationListener` and VFS-refreshes all known
 * roots on activation, which git4idea's `GitRepositoryUpdater` consumes. This
 * service is that behavior's equivalent: on window focus, compare a live ref
 * listing per repository against the last known snapshot and reload on drift.
 *
 * Quietness invariants:
 *  - A probe that finds no drift issues no reload and fires no events.
 *  - Any `onDidChangeRepository` drops the snapshot, so changes the watcher
 *    already delivered never cause a redundant focus reload — the next probe
 *    just re-primes.
 *  - Probes are rate-limited so cmd-tab flapping doesn't spawn git processes.
 *
 * Residuals (deliberate): a detached-HEAD move with no ref change is not in
 * the listing, and tags are not probed; both still heal through the watcher
 * or any subsequent branch-tip drift.
 */

import * as vscode from 'vscode';
import { readConfig } from '../config/configKeys';
import { IBranch, IRepository } from '../git-core/interfaces/IGitService';
import { safeFireAndForget } from '../utils/safeFireAndForget';
import { getLogger, type Logger } from '../utils/logger';

/** Minimum quiet time between two focus probes. */
const MIN_PROBE_INTERVAL_MS = 5_000;

/** The GitService capabilities the reconcile probe needs. */
export interface IFocusReconcileGitService {
  getRepositories(): IRepository[];
  getBranches(repo: IRepository): Promise<IBranch[]>;
  reloadRepository(repo: IRepository): Promise<IRepository | undefined>;
  onDidChangeRepository: vscode.Event<IRepository>;
}

/**
 * Options object for the constructor. Exposed so tests can inject the config
 * reader, the focus event, and the clock.
 */
export interface IFocusReconcileOptions {
  /** Override the enabled reader (primarily for tests). */
  readEnabled?: () => boolean;
  /** Override the focus-regained subscription (primarily for tests). */
  onDidFocus?: (listener: () => void) => vscode.Disposable;
  /** Override the clock (primarily for tests). */
  now?: () => number;
}

export class FocusReconcileService implements vscode.Disposable {
  private readonly _gitService: IFocusReconcileGitService;
  private readonly _readEnabled: () => boolean;
  private readonly _now: () => number;
  private readonly _logger: Logger;
  private readonly _subscriptions: vscode.Disposable[] = [];

  /**
   * Last known ref listing per repository root, in probe-comparable form.
   * `undefined` (absent) means "unknown": the next probe primes it silently
   * instead of reloading, so only drift against an actually-known state
   * triggers work.
   */
  private readonly _snapshots = new Map<string, string>();

  private _lastProbeAt = 0;
  private _probeInFlight = false;
  private _disposed = false;

  constructor(gitService: IFocusReconcileGitService, options?: IFocusReconcileOptions) {
    this._gitService = gitService;
    this._readEnabled = options?.readEnabled ?? ((): boolean => readConfig('autorefresh'));
    this._now = options?.now ?? ((): number => Date.now());
    this._logger = getLogger().child({ component: 'FocusReconcileService' });

    const onDidFocus =
      options?.onDidFocus ??
      ((listener: () => void): vscode.Disposable =>
        vscode.window.onDidChangeWindowState((e) => {
          if (e.focused) {
            listener();
          }
        }));

    this._subscriptions.push(
      onDidFocus(() => {
        safeFireAndForget(this._probe(), 'FocusReconcileService: focus probe');
      })
    );
    this._subscriptions.push(
      this._gitService.onDidChangeRepository((repo) => {
        // The change already reached every subscriber through this event;
        // whatever the next probe reads is the delivered state, not drift.
        this._snapshots.delete(repo.rootUri.fsPath);
      })
    );
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    for (const sub of this._subscriptions) {
      sub.dispose();
    }
    this._subscriptions.length = 0;
    this._snapshots.clear();
  }

  private async _probe(): Promise<void> {
    if (this._disposed || this._probeInFlight || !this._readEnabled()) {
      return;
    }
    const now = this._now();
    if (now - this._lastProbeAt < MIN_PROBE_INTERVAL_MS) {
      return;
    }
    this._lastProbeAt = now;
    this._probeInFlight = true;
    try {
      for (const repo of this._gitService.getRepositories()) {
        if (this._disposed) {
          return;
        }
        const rootPath = repo.rootUri.fsPath;
        const listing = await this._gitService.getBranches(repo);
        // Empty is ambiguous: a brand-new repo without commits, or the
        // facade's degraded [] after a failed listing. Neither is a baseline
        // worth comparing against, so leave the snapshot unknown.
        if (listing.length === 0) {
          continue;
        }
        const key = FocusReconcileService._listingKey(listing);
        const prev = this._snapshots.get(rootPath);
        if (prev === undefined) {
          this._snapshots.set(rootPath, key);
          continue;
        }
        if (prev !== key) {
          this._logger.info('refs drifted while unfocused; reloading', { rootPath });
          this._snapshots.set(rootPath, key);
          // The reload fires onDidChangeRepository, whose subscriber above
          // drops this snapshot again — the next probe re-primes.
          await this._gitService.reloadRepository(repo);
        }
      }
    } finally {
      this._probeInFlight = false;
    }
  }

  /** Order-insensitive comparable form of a ref listing. */
  private static _listingKey(listing: IBranch[]): string {
    return listing
      .map((b) => `${b.type}\x1f${b.name}\x1f${b.commit}\x1f${b.isHead ? 1 : 0}`)
      .sort() // ref-sort-exempt: an opaque comparison key, never displayed
      .join('\n');
  }
}

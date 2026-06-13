/**
 * Blame options source.
 *
 * Single source of truth for the three persistent blame flags (Ignore
 * Whitespace / Detect Movements Within File / Detect Movements Across Files)
 * and the set of commits the user has chosen to "Hide Revision" for.
 *
 * - The three boolean flags live in VS Code settings (`intellig.blame.*`) so
 *   they sync across workspaces and can be controlled via
 *   `editor/lineNumber/context` toggle commands.
 * - The hidden-revision set is workspace-state scoped (per-repo wouldn't add
 *   value here — a given hash only appears in one repo).
 *
 * Fires `onDidChange` whenever any of the flags or the hidden set changes so
 * providers can re-blame + re-render.
 */

import * as vscode from 'vscode';
import { IBlameOptions } from './interfaces/IBlameService';

/** Config keys (namespaced under `intellig.blame.*`). */
const CONFIG_SECTION = 'intellig.blame';
const CONFIG_IGNORE_WS = 'ignoreWhitespace';
const CONFIG_DETECT_WITHIN = 'detectMovementsWithinFile';
const CONFIG_DETECT_ACROSS = 'detectMovementsAcrossFiles';

/** Workspace-state key for the hidden-revision set. */
const WS_STATE_HIDDEN = 'intellig.blame.hiddenRevisions';

/**
 * Snapshot of all persistent blame state.
 */
export interface IBlameOptionsSnapshot extends Required<IBlameOptions> {
  /** Full SHAs the user has hidden via "Hide Revision". */
  hiddenRevisions: ReadonlySet<string>;
}

/**
 * Reactive source of blame options + hidden-revision set. Exported for the
 * InlineBlame / GutterBlame providers and for the menu-command handlers.
 */
export class BlameOptionsSource {
  private readonly _onDidChange = new vscode.EventEmitter<IBlameOptionsSnapshot>();
  readonly onDidChange = this._onDidChange.event;

  private _hidden: Set<string>;

  private readonly _disposables: vscode.Disposable[] = [];

  constructor(private readonly _workspaceState?: vscode.Memento) {
    const stored = _workspaceState?.get<string[]>(WS_STATE_HIDDEN, []) ?? [];
    this._hidden = new Set(stored);

    // Re-fire whenever the relevant config keys flip so subscribers can
    // debounce re-blaming without having to own onDidChangeConfiguration
    // themselves.
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_IGNORE_WS}`) ||
          event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_DETECT_WITHIN}`) ||
          event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_DETECT_ACROSS}`)
        ) {
          this._onDidChange.fire(this.snapshot());
        }
      })
    );
  }

  /**
   * Current snapshot. Cheap — reads the config freshly on every call since
   * `getConfiguration` is memoized internally by VS Code.
   */
  snapshot(): IBlameOptionsSnapshot {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
      ignoreWhitespace: cfg.get<boolean>(CONFIG_IGNORE_WS, false),
      detectMovementsWithinFile: cfg.get<boolean>(CONFIG_DETECT_WITHIN, false),
      detectMovementsAcrossFiles: cfg.get<boolean>(CONFIG_DETECT_ACROSS, false),
      hiddenRevisions: new Set(this._hidden),
    };
  }

  /**
   * Project the snapshot as a plain {@link IBlameOptions} for BlameService.
   */
  asBlameOptions(): IBlameOptions {
    const s = this.snapshot();
    return {
      ignoreWhitespace: s.ignoreWhitespace,
      detectMovementsWithinFile: s.detectMovementsWithinFile,
      detectMovementsAcrossFiles: s.detectMovementsAcrossFiles,
    };
  }

  /**
   * Toggle a single flag, persisting to workspace configuration. Flips the
   * effective config target based on where the key is already set (defaults
   * to Workspace).
   */
  async toggleFlag(
    key: 'ignoreWhitespace' | 'detectMovementsWithinFile' | 'detectMovementsAcrossFiles'
  ): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const current = cfg.get<boolean>(key, false);
    const next = !current;
    // Prefer Workspace target so per-project preference sticks; falls back to
    // Global if there's no open workspace.
    const target = vscode.workspace.workspaceFolders
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await cfg.update(key, next, target);
    return next;
  }

  /**
   * Add a revision to the hidden set. No-op if already hidden.
   */
  async hideRevision(sha: string): Promise<void> {
    if (!sha || sha.startsWith('0000000')) {
      return;
    }
    if (this._hidden.has(sha)) {
      return;
    }
    this._hidden.add(sha);
    await this._persistHidden();
    this._onDidChange.fire(this.snapshot());
  }

  /**
   * Remove a revision from the hidden set.
   */
  async showRevision(sha: string): Promise<void> {
    if (!this._hidden.has(sha)) {
      return;
    }
    this._hidden.delete(sha);
    await this._persistHidden();
    this._onDidChange.fire(this.snapshot());
  }

  /**
   * Clear the entire hidden set.
   */
  async clearHiddenRevisions(): Promise<void> {
    if (this._hidden.size === 0) {
      return;
    }
    this._hidden.clear();
    await this._persistHidden();
    this._onDidChange.fire(this.snapshot());
  }

  /**
   * Is `sha` hidden?
   */
  isHidden(sha: string): boolean {
    return this._hidden.has(sha);
  }

  /**
   * Dispose the underlying event subscriptions. Idempotent.
   */
  dispose(): void {
    this._onDidChange.dispose();
    while (this._disposables.length > 0) {
      const d = this._disposables.pop();
      try {
        d?.dispose();
      } catch {
        // ignore
      }
    }
  }

  /** Flush the hidden-revision set to workspace state. */
  private async _persistHidden(): Promise<void> {
    if (!this._workspaceState) {
      return;
    }
    await this._workspaceState.update(WS_STATE_HIDDEN, Array.from(this._hidden));
  }
}

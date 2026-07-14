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
import { readConfig, updateConfig } from '../config/configKeys';
import { IBlameOptions } from './interfaces/IBlameService';
import { AuthorNameFormat, normalizeAuthorNameFormat } from './authorNameFormat';

/** Config keys (namespaced under `intellig.blame.*`). */
const CONFIG_SECTION = 'intellig.blame';
const CONFIG_IGNORE_WS = 'ignoreWhitespace';
const CONFIG_DETECT_WITHIN = 'detectMovementsWithinFile';
const CONFIG_DETECT_ACROSS = 'detectMovementsAcrossFiles';
const CONFIG_COLOR_MODE = 'colorMode';
const CONFIG_SHOW_AUTHOR = 'showAuthor';
const CONFIG_SHOW_DATE = 'showDate';
const CONFIG_SHOW_REVISION = 'showRevision';
const CONFIG_AUTHOR_NAME_FORMAT = 'authorNameFormat';

/**
 * The three annotation aspects whose visibility the user can toggle
 * independently. Mirrors IntelliJ's `LineAnnotationAspect` IDs
 * (`AUTHOR` / `DATE` / `REVISION`) and the per-aspect show/hide entries the
 * `AnnotateActionGroup` builds via `ShowHideAspectAction`.
 */
export type BlameAspectId = 'author' | 'date' | 'revision';

/** Visibility of each toggleable annotation aspect column. */
export interface IBlameAspectVisibility {
  author: boolean;
  date: boolean;
  revision: boolean;
}

/** Maps each aspect onto its backing config key. */
const ASPECT_CONFIG_KEY = {
  author: CONFIG_SHOW_AUTHOR,
  date: CONFIG_SHOW_DATE,
  revision: CONFIG_SHOW_REVISION,
} as const satisfies Record<BlameAspectId, string>;

/** Workspace-state key for the hidden-revision set. */
const WS_STATE_HIDDEN = 'intellig.blame.hiddenRevisions';

/**
 * Blame annotation background color mode. Mirrors IntelliJ's
 * `com.intellij.openapi.vcs.actions.ColorMode`: ORDER tints lines by commit
 * age (heat gradient), AUTHOR tints them by a stable per-author color.
 */
export type BlameColorMode = 'order' | 'author';

/** Default color mode when the setting is unset or invalid. */
const DEFAULT_COLOR_MODE: BlameColorMode = 'order';

/** Coerce an arbitrary config string to a valid {@link BlameColorMode}. */
function normalizeColorMode(value: string | undefined): BlameColorMode {
  return value === 'author' ? 'author' : DEFAULT_COLOR_MODE;
}

/**
 * Snapshot of all persistent blame state.
 */
export interface IBlameOptionsSnapshot extends Required<IBlameOptions> {
  /** Full SHAs the user has hidden via "Hide Revision". */
  hiddenRevisions: ReadonlySet<string>;
  /** Active background color mode for blame annotations. */
  colorMode: BlameColorMode;
  /** Which annotation aspect columns are currently shown. */
  aspects: IBlameAspectVisibility;
  /** How the author identity is rendered in the annotation text. */
  authorNameFormat: AuthorNameFormat;
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
          event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_DETECT_ACROSS}`) ||
          event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_COLOR_MODE}`) ||
          event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_SHOW_AUTHOR}`) ||
          event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_SHOW_DATE}`) ||
          event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_SHOW_REVISION}`) ||
          event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_AUTHOR_NAME_FORMAT}`)
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
    return {
      ignoreWhitespace: readConfig('blame.ignoreWhitespace'),
      detectMovementsWithinFile: readConfig('blame.detectMovementsWithinFile'),
      detectMovementsAcrossFiles: readConfig('blame.detectMovementsAcrossFiles'),
      hiddenRevisions: new Set(this._hidden),
      colorMode: normalizeColorMode(readConfig('blame.colorMode')),
      aspects: {
        author: readConfig('blame.showAuthor'),
        date: readConfig('blame.showDate'),
        revision: readConfig('blame.showRevision'),
      },
      authorNameFormat: normalizeAuthorNameFormat(readConfig('blame.authorNameFormat')),
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
    const next = !readConfig(`blame.${key}`);
    // Prefer Workspace target so per-project preference sticks; falls back to
    // Global if there's no open workspace.
    const target = vscode.workspace.workspaceFolders
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await updateConfig(`blame.${key}`, next, target);
    return next;
  }

  /**
   * Toggle the visibility of a single annotation aspect column, persisting to
   * workspace configuration. Mirrors IntelliJ's per-aspect `ShowHideAspectAction`.
   *
   * @returns the aspect's new visibility.
   */
  async toggleAspect(aspect: BlameAspectId): Promise<boolean> {
    const key = `blame.${ASPECT_CONFIG_KEY[aspect]}` as const;
    const next = !readConfig(key);
    const target = vscode.workspace.workspaceFolders
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await updateConfig(key, next, target);
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
        // eslint-disable-next-line no-restricted-syntax -- swallow disposal errors so one bad disposable doesn't block cleanup of the rest; nothing actionable during teardown.
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

/// <reference lib="dom" />
// Webview entry for the IntelliG merge window (bundled by esbuild into
// media/mergeWindow.js; `monaco` is the AMD global loaded by the panel HTML).
//
// The merge model runs entirely in this webview. The document of record is
// the model's StringMergeDocument — the Monaco result editor is a controlled
// mirror: user edits are replayed onto the document (each batch as one undo
// command), programmatic changes (apply/ignore/undo) flow back to Monaco
// under a suppression flag, and a divergence guard resyncs if they ever
// disagree. Monaco's own undo is bypassed; Ctrl+Z/Ctrl+Shift+Z/Ctrl+Y route
// to the model's MergeUndoManager so text and change states restore together.
//
// Per-change actions hug the dividers, like IntelliJ: IntelliJ mirrors the
// left editor's gutter to its right edge (scrollbar orientation LEFT →
// EditorGutterComponentImpl.isMirrored), so every icon column sits against a
// divider. Monaco cannot mirror its margin, so each side editor gets a
// dedicated action strip at its divider edge, painting a per-change colored
// band plus an apply/ignore icon pair per unresolved change and a revert icon
// per resolved one; the result editor carries the magic-resolve wand in its
// glyph margin. The dividers themselves hold only the curved canvas
// connectors.

import type * as Monaco from 'monaco-editor';
import type {
  MergeWindowInitMessage,
  MergeWindowInbound,
  MergeWindowConfirmAction,
  MergeWindowConfirmResultMessage,
} from '../mergeWindow.protocol';
import { ComparisonPolicy } from '../../../diff-engine/comparison/ComparisonPolicy';
import { MergeConflictTypeKind } from '../../../diff-engine/util/MergeConflictType';
import { Side } from '../../../diff-engine/util/Side';
import { ThreeSide } from '../../../diff-engine/util/ThreeSide';
import { ITextMergeRequest, MergeConflictModel } from '../../merge-model/MergeConflictModel';
import { StringMergeDocument } from '../../merge-model/MergeDocument';
import { MergeUndoManager } from '../../merge-model/MergeUndoManager';
import { TextMergeChange } from '../../merge-model/TextMergeChange';
import { replayMonacoChanges } from '../editReplay';
import { IAlignAnchor, invertAnchors, mapLine } from '../scrollMapping';
import { IMergeInnerDifferences, compareThreesideInner } from '../innerDiff';
import {
  MERGE_KIND_CONNECTOR_COLORS,
  MergeChangeKind,
  buildMergeWindowDom,
} from '../mergeWindowHtml';

/** Inner word diffs are skipped for chunks beyond this size (IntelliJ runs
 * them in the background; here they are synchronous per render). */
const INNER_DIFF_MAX_CHUNK = 10000;

declare const monaco: typeof Monaco;
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

// The init shape is the shared host↔webview contract (no more duplication).
type IInitMessage = MergeWindowInitMessage;

const vscodeApi = acquireVsCodeApi();

// Send path is on-contract too: the helper narrows to the union of what the
// webview may post, so a renamed field breaks compile in BOTH directions.
function post(message: MergeWindowInbound): void {
  vscodeApi.postMessage(message);
}

function logToHost(level: 'warn' | 'error' | 'fatal', text: string): void {
  post({ type: 'log', level, text });
}

/**
 * One global net for everything that throws outside a call this file already
 * wraps: event listeners, MutationObserver callbacks, Monaco's onMouseDown,
 * scheduled callbacks, and rejected promises. Without it a half-built or
 * mid-session failure leaves a tab the user can neither Apply nor Abort, with
 * nothing reported. Per-call-site guards can only ever cover the sites someone
 * remembered; this covers the ones nobody did.
 *
 * Installed first thing in boot(), before any DOM work can throw. Fenced by
 * `check:webview-fatal-reporter`.
 *
 * "Something threw" and "the panel cannot continue" are DIFFERENT facts, and
 * only the second may close the window: reporting everything as fatal would
 * destroy a live merge over a stray page error. So the net reports at 'error'
 * and escalates only when the panel is provably unusable. The explicit
 * construction failure in boot() stays fatal on its own account.
 */

/** Chromium dispatches this benign layout notice as a window ErrorEvent, and
 * `automaticLayout` puts a ResizeObserver on all three editors. */
const BENIGN_ERROR = /^ResizeObserver loop/;

/**
 * Severities already reported. Repeats at one severity are noise, but a later
 * ESCALATION must still get through: a blanket once-per-session latch would
 * swallow the fatal that closes a dead panel just because something benign
 * threw earlier.
 */
const reportedLevels = new Set<'error' | 'fatal'>();

/**
 * Set while posting, so an error raised BY the post cannot re-enter this
 * handler as it unwinds. It is cleared even on that path: `reportedLevels`
 * already stops the re-entrant call (its severity is in the set by then), so
 * clearing costs nothing and keeps a transient post failure from wedging the
 * reporter shut for the rest of the session.
 */
let reportingUncaught = false;

/**
 * Provably unusable: without Apply the user cannot act on the merge at all,
 * so the tab is dead weight. Anything short of that stays recoverable — the
 * result text is intact and Apply/Abort still work.
 */
function panelIsUnusable(): boolean {
  return document.getElementById('btn-apply') === null;
}

function reportUncaught(text: string): void {
  if (reportingUncaught) {
    return;
  }
  const level = panelIsUnusable() ? 'fatal' : 'error';
  if (reportedLevels.has(level)) {
    return;
  }
  reportedLevels.add(level);
  reportingUncaught = true;
  try {
    logToHost(level, text);
  } finally {
    reportingUncaught = false;
  }
}

function installFatalReporter(): void {
  window.addEventListener('error', (event: ErrorEvent): void => {
    const message = event.message || String(event.error);
    if (BENIGN_ERROR.test(message)) {
      return;
    }
    reportUncaught(`merge window: ${message}`);
  });
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent): void => {
    reportUncaught(`merge window: unhandled rejection: ${String(event.reason)}`);
  });
}

/**
 * Belt-and-braces over the global reporter: wrapping a scheduled callback
 * names the failing operation in the message, which a bare stack does not.
 */
function guardContinuation(label: string, fn: () => void): () => void {
  return (): void => {
    try {
      fn();
      // eslint-disable-next-line no-restricted-syntax -- the whole point is to report an otherwise-silent async failure to the host.
    } catch (err) {
      // Same severity decision as the global net: a failed render leaves the
      // view stale, not the panel dead, so it must not close a live merge.
      reportUncaught(`merge window: ${label} failed: ${String(err)}`);
    }
  };
}

function languageForFile(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
  if (ext === '') {
    return 'plaintext';
  }
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.extensions && lang.extensions.indexOf(ext) >= 0) {
      return lang.id;
    }
  }
  return 'plaintext';
}

/** IntelliJ diff semantics: green = inserted, blue = modified, red =
 * conflict, grey = deleted. */
function kindOf(change: TextMergeChange): MergeChangeKind {
  switch (change.conflictType.type) {
    case MergeConflictTypeKind.CONFLICT:
      return 'conflict';
    case MergeConflictTypeKind.MODIFIED:
      return 'modified';
    case MergeConflictTypeKind.INSERTED:
      return 'inserted';
    case MergeConflictTypeKind.DELETED:
      return 'deleted';
  }
}

function mustGet(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`merge window: missing element #${id}`);
  }
  return el;
}

/** The vertical pixel span of a block of lines, in a pane's viewport. */
interface IBlockSpan {
  readonly top: number;
  readonly bottom: number;
}

class MergeWindow {
  private readonly undoManager = new MergeUndoManager();
  private readonly resultDoc: StringMergeDocument;
  private readonly model: MergeConflictModel;

  private readonly leftEditor: Monaco.editor.IStandaloneCodeEditor;
  private readonly resultEditor: Monaco.editor.IStandaloneCodeEditor;
  private readonly rightEditor: Monaco.editor.IStandaloneCodeEditor;

  /** True while programmatic edits are applied to the Monaco result model. */
  private applyingToMonaco = false;
  /** True while Monaco user edits are replayed onto the result document. */
  private replayingFromMonaco = false;
  private syncingScroll = false;
  private renderQueued = false;
  /** Result-editor lines carrying a magic-resolve wand → change index. */
  private readonly magicGlyphLines = new Map<number, number>();
  /** Conflicts sorted by result line, memoized until the next mutation, so the
   * caret-driven counter/navigation don't re-scan and re-sort per keystroke. */
  private conflictsMemo: TextMergeChange[] | undefined;
  /**
   * A result restored from a closed window seeds Monaco as one whole-document
   * replacement, which collapses every model change range to zero length at
   * EOF. Change-driven actions would then target ranges that no longer
   * describe anything, so the session degrades to free-text editing plus
   * Apply/Abort.
   */
  private restoredTextOnly = false;
  /** The result as the window first produced it (base + any auto-apply). */
  private pristineText: string | undefined;

  constructor(init: IInitMessage) {
    const language = languageForFile(init.fileName);
    this.resultDoc = new StringMergeDocument('', this.undoManager);
    const request: ITextMergeRequest = {
      contents: [
        new StringMergeDocument(init.left),
        new StringMergeDocument(init.base),
        new StringMergeDocument(init.right),
      ],
      outputContent: this.resultDoc,
    };
    this.model = new MergeConflictModel(request, this.undoManager);
    this.model.rediff(ComparisonPolicy.DEFAULT);

    // Match the user's editor font — Monaco's own default renders smaller
    // than the surrounding VS Code editors.
    const bodyStyle = window.getComputedStyle(document.body);
    const fontFamily = bodyStyle.getPropertyValue('--vscode-editor-font-family').trim();
    const fontSize = parseFloat(bodyStyle.getPropertyValue('--vscode-editor-font-size'));

    const commonOptions: Monaco.editor.IStandaloneEditorConstructionOptions = {
      language,
      fontFamily: fontFamily !== '' ? fontFamily : undefined,
      fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : undefined,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      renderLineHighlight: 'none',
      folding: false,
      lineNumbersMinChars: 3,
      glyphMargin: false,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      theme: document.body.classList.contains('vscode-light') ? 'vs' : 'vs-dark',
    };

    this.leftEditor = monaco.editor.create(mustGet('left-editor'), {
      ...commonOptions,
      value: init.left,
      readOnly: true,
    });
    this.resultEditor = monaco.editor.create(mustGet('result-editor'), {
      ...commonOptions,
      value: this.resultDoc.getText(),
      readOnly: false,
      // Hosts the magic-resolve wand for auto-resolvable conflicts.
      glyphMargin: true,
    });
    this.rightEditor = monaco.editor.create(mustGet('right-editor'), {
      ...commonOptions,
      value: init.right,
      readOnly: true,
    });
    for (const editor of [this.leftEditor, this.resultEditor, this.rightEditor]) {
      editor.getModel()?.setEOL(monaco.editor.EndOfLineSequence.LF);
    }

    mustGet('left-title').textContent = init.leftLabel;
    mustGet('right-title').textContent = init.rightLabel;

    this.wireResultSync();
    this.wireUndoKeys();
    this.wireScrollSync();
    this.wireToolbar();
    this.wireMagicGlyph();
    this.wireThemeSync();
    this.wireConfirmResults();
    // The "Conflict i / n" ordinal follows the caret.
    this.resultEditor.onDidChangeCursorPosition(() => this.updateCounter());
    window.addEventListener('resize', () => this.layoutGutters());

    this.model.addListener(() => this.scheduleRender());

    // Like IntelliJ's default, nothing is applied on open: the result starts
    // as the base with every change highlighted and waiting for the user.
    // With the auto-apply option on (IntelliJ's "Automatically apply
    // non-conflicting changes", off by default), the non-conflicting changes
    // land immediately; conflicts always wait for the user.
    if (init.autoApplyNonConflicting === true) {
      this.applyNonConflicted();
    }
    // What the window produced on its own. Auto-apply runs through the same
    // command path a user edit does, so `contentModified` is already true here
    // and cannot tell "untouched" from "the user merged something". Captured
    // before the first render so every state post carries the right answer.
    this.pristineText = this.resultDoc.getText();
    this.renderAll();
    // A result left behind by a closed window rides in through the regular
    // Monaco→document replay, so it lands as one undoable user edit and
    // flags the content modified (Abort confirms before discarding it). The
    // whole-document replacement leaves the change ranges meaningless, so the
    // session continues as text-only.
    if (
      typeof init.restoredResult === 'string' &&
      init.restoredResult !== this.resultDoc.getText()
    ) {
      this.restoredTextOnly = true;
      this.resultEditor.getModel()?.setValue(init.restoredResult);
      this.renderAll();
    }
  }

  //
  // Result document <-> Monaco mirroring
  //

  private wireResultSync(): void {
    const resultModel = this.resultEditor.getModel();
    if (!resultModel) {
      return;
    }

    // Programmatic changes (apply/ignore/undo/reset) → mirror into Monaco.
    this.resultDoc.addDocumentListener({
      documentChanged: (event) => {
        if (this.replayingFromMonaco) {
          return;
        }
        // The Monaco model still holds the pre-change text here, so the
        // event's old-text offsets convert directly to positions.
        const start = resultModel.getPositionAt(event.offset);
        const end = resultModel.getPositionAt(event.offset + event.oldFragment.length);
        this.applyingToMonaco = true;
        try {
          resultModel.applyEdits([
            {
              range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
              text: event.newFragment,
            },
          ]);
        } finally {
          this.applyingToMonaco = false;
        }
      },
    });

    // User edits in the result editor → replay onto the document of record,
    // one undo command per change batch.
    this.resultEditor.onDidChangeModelContent((e) => {
      if (this.applyingToMonaco) {
        return;
      }
      this.replayingFromMonaco = true;
      try {
        this.undoManager.executeCommand(() => {
          replayMonacoChanges(this.resultDoc, e.changes);
        });
      } finally {
        this.replayingFromMonaco = false;
      }
      // IntelliJ marks the model on every result-document change
      // (MergeThreesideViewer.onBeforeDocumentChange), so hand-typed edits
      // count as discardable work for the Abort/Accept confirms.
      this.model.contentModified = true;
      this.assertInSync();
      this.scheduleRender();
    });
  }

  private assertInSync(): void {
    const resultModel = this.resultEditor.getModel();
    if (!resultModel) {
      return;
    }
    const monacoText = resultModel.getValue(monaco.editor.EndOfLinePreference.LF);
    const docText = this.resultDoc.getText();
    if (monacoText !== docText) {
      logToHost('warn', 'merge window: result editor diverged from the model; resynced');
      this.applyingToMonaco = true;
      try {
        resultModel.setValue(docText);
      } finally {
        this.applyingToMonaco = false;
      }
    }
  }

  //
  // Undo/redo
  //

  private wireUndoKeys(): void {
    const undo = (): void => this.undo();
    const redo = (): void => this.redo();
    for (const editor of [this.leftEditor, this.resultEditor, this.rightEditor]) {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, undo);
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ, redo);
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, redo);
    }
  }

  private undo(): void {
    if (this.undoManager.isUndoAvailable()) {
      this.undoManager.undo();
      this.assertInSync();
      this.scheduleRender();
    }
  }

  private redo(): void {
    if (this.undoManager.isRedoAvailable()) {
      this.undoManager.redo();
      this.assertInSync();
      this.scheduleRender();
    }
  }

  //
  // Change actions
  //

  private applySide(index: number, side: Side): void {
    const change = this.model.changeByIndex(index);
    this.model.executeMergeCommand([change.index], () => {
      this.model.replaceChange(change.index, side, false);
      return true;
    });
    this.scheduleRender();
  }

  private ignoreSide(index: number, side: Side): void {
    const change = this.model.changeByIndex(index);
    this.model.executeMergeCommand([change.index], () => {
      this.model.ignoreChange(change.index, side, false);
      return true;
    });
    this.scheduleRender();
  }

  /**
   * IntelliJ's Revert Conflict Resolution toolbar action: every resolved
   * change goes back to unresolved/base as ONE undoable command, so
   * Cmd/Ctrl+Z restores the pre-reset state.
   */
  private resetChanges(): void {
    const resolved = this.model.getAllChanges().filter((c) => c.isResolved());
    if (resolved.length === 0) {
      return;
    }
    this.model.executeMergeCommand(
      resolved.map((c) => c.index),
      () => {
        for (const change of resolved) {
          this.model.resetResolvedChange(change.index);
        }
        return true;
      }
    );
    this.scheduleRender();
  }

  /** Puts a resolved change back to its base content, unresolved. */
  private revertChange(index: number): void {
    const change = this.model.changeByIndex(index);
    this.model.executeMergeCommand([change.index], () => {
      this.model.resetResolvedChange(change.index);
      return true;
    });
    this.scheduleRender();
  }

  /**
   * IntelliJ's Apply Non-Conflicting Changes (left / all / right): the
   * side's non-conflicting changes land in the result as one undo step;
   * conflicts stay untouched. Scrolls to the first change still
   * unresolved, like IntelliJ.
   */
  private applyNonConflicted(side: ThreeSide = ThreeSide.BASE): void {
    this.model.applyNonConflictedChanges(side);
    const model = this.resultEditor.getModel();
    const lineCount = model ? model.getLineCount() : 1;
    const first = this.model.getUnresolvedChanges()[0];
    if (first) {
      this.resultEditor.revealLineInCenter(Math.min(first.resultStartLine + 1, lineCount));
    }
    this.scheduleRender();
  }

  private nextConfirmRequestId = 1;
  private readonly pendingConfirms = new Map<number, (confirmed: boolean) => void>();

  /** Resolves pending host-modal confirmations as their answers arrive. */
  private wireConfirmResults(): void {
    window.addEventListener('message', (event: MessageEvent) => {
      const msg = event.data as Partial<MergeWindowConfirmResultMessage> | undefined;
      if (!msg || msg.type !== 'confirmResult' || typeof msg.requestId !== 'number') {
        return;
      }
      const resolve = this.pendingConfirms.get(msg.requestId);
      if (resolve) {
        this.pendingConfirms.delete(msg.requestId);
        resolve(msg.confirmed === true);
      }
    });
  }

  /** Round-trips a destructive-action confirmation through a host modal. */
  private confirmWithHost(
    action: MergeWindowConfirmAction,
    counts?: { changes: number; conflicts: number }
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const requestId = this.nextConfirmRequestId++;
      this.pendingConfirms.set(requestId, resolve);
      post({ type: 'confirm', requestId, action, ...counts });
    });
  }

  /**
   * IntelliJ's handleResolvedCase: Apply is always offered; with changes
   * still unresolved it confirms with counts, then marks everything
   * resolved and saves the result exactly as shown.
   */
  private async applyResult(): Promise<void> {
    if (this.restoredTextOnly) {
      // The change ranges collapsed when the restored text replaced the whole
      // document, so any count taken from them describes nothing. The text IS
      // the result here; send it as shown.
      post({ type: 'apply', resultText: this.resultDoc.getText() });
      return;
    }
    const unresolved = this.model.getUnresolvedChanges();
    if (unresolved.length > 0) {
      const conflicts = unresolved.filter((c) => c.isConflict).length;
      const changes = unresolved.length - conflicts;
      if (!(await this.confirmWithHost('applyUnresolved', { changes, conflicts }))) {
        return;
      }
      this.model.executeMergeCommand(
        unresolved.map((c) => c.index),
        () => {
          this.model.markAllChangesResolved();
          return true;
        }
      );
      this.scheduleRender();
    }
    post({ type: 'apply', resultText: this.resultDoc.getText() });
  }

  /**
   * IntelliJ's handleAcceptSide: replacing the result with a whole side is
   * destructive, so a modified result needs an explicit discard confirm
   * first (MergeUtil.showConfirmDiscardChangesDialog).
   */
  private async acceptWholeSide(side: Side): Promise<void> {
    if (this.model.contentModified) {
      const action = side === Side.LEFT ? 'acceptLeft' : 'acceptRight';
      if (!(await this.confirmWithHost(action))) {
        return;
      }
    }
    this.model.acceptRevisionForSide(side);
    this.scheduleRender();
  }

  private wireToolbar(): void {
    const on = (id: string, handler: () => void): void => {
      mustGet(id).addEventListener('click', handler);
    };
    on('btn-accept-left', () => void this.acceptWholeSide(Side.LEFT));
    on('btn-accept-right', () => void this.acceptWholeSide(Side.RIGHT));
    on('btn-reset', () => this.resetChanges());
    on('btn-nc-left', () => this.applyNonConflicted(ThreeSide.LEFT));
    on('btn-nc-all', () => this.applyNonConflicted());
    on('btn-nc-right', () => this.applyNonConflicted(ThreeSide.RIGHT));
    // IntelliJ's MagicResolvedConflictsAction: bulk-resolve every conflict
    // whose side changes do not overlap, in one undo step.
    on('btn-magic-all', () => {
      this.model.resolveAllChangesAutomatically();
      this.scheduleRender();
    });
    on('btn-prev', () => this.navigate(-1));
    on('btn-next', () => this.navigate(1));
    on('btn-apply', () => void this.applyResult());
    on('btn-abort', () => {
      post({ type: 'abort', modified: this.model.contentModified });
    });
  }

  /**
   * Follow VS Code theme switches while the window is open. Monaco's theme
   * and the cached connector colors are both derived at construction. VS Code
   * signals a switch on the body via the `vscode-light`/`vscode-dark` class
   * and the `data-vscode-theme-*` markers; a switch between two themes of the
   * same light/dark polarity changes the CSS variables but not the class, so
   * ANY of those attribute changes must invalidate the connector cache. Monaco
   * only carries two base themes, so re-set it only when the polarity flips.
   */
  private wireThemeSync(): void {
    let polarity = document.body.classList.contains('vscode-light') ? 'vs' : 'vs-dark';
    const observer = new MutationObserver(() => {
      // Connector fills read theme CSS variables, which may have changed under
      // any theme marker; drop the cache and re-lay the gutters unconditionally.
      this.connectorColorCache.clear();
      this.layoutGutters();
      const next = document.body.classList.contains('vscode-light') ? 'vs' : 'vs-dark';
      if (next !== polarity) {
        polarity = next;
        monaco.editor.setTheme(next);
      }
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: [
        'class',
        'data-vscode-theme-kind',
        'data-vscode-theme-name',
        'data-vscode-theme-id',
      ],
    });
  }

  /** Clicking the wand in the result gutter magic-resolves that conflict. */
  private wireMagicGlyph(): void {
    this.resultEditor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        return;
      }
      const line = e.target.position?.lineNumber;
      if (line === undefined) {
        return;
      }
      const index = this.magicGlyphLines.get(line);
      if (index === undefined) {
        return;
      }
      this.model.executeMergeCommand([index], () => {
        return this.model.resolveChangeAutomatically(index, ThreeSide.BASE) !== undefined;
      });
      this.scheduleRender();
    });
  }

  /**
   * Jump the result editor to the previous/next unresolved change relative to
   * the caret (IntelliJ navigates from the caret too). While any conflict is
   * unresolved, Prev/Next walk conflicts only — the bulk action and per-change
   * icons own the non-conflicting changes; once every conflict is resolved the
   * stops fall back to whatever non-conflicting changes remain, so there is
   * always a keyboard/toolbar path to an unresolved change. A stored cursor
   * would desync as changes resolve and the unresolved list re-indexes.
   */
  private navigate(direction: -1 | 1): void {
    const model = this.resultEditor.getModel();
    const lineCount = model ? model.getLineCount() : 1;
    const unresolvedConflicts = this.conflictsByResultLine().filter((c) => !c.isResolved());
    const targets =
      unresolvedConflicts.length > 0 ? unresolvedConflicts : this.model.getUnresolvedChanges();
    const lines = targets
      .map((c) => Math.min(c.resultStartLine + 1, lineCount))
      .sort((a, b) => a - b);
    if (lines.length === 0) {
      return;
    }
    const caret = this.resultEditor.getPosition()?.lineNumber ?? 1;
    const line =
      direction === 1
        ? (lines.find((l) => l > caret) ?? lines[0])
        : ([...lines].reverse().find((l) => l < caret) ?? lines[lines.length - 1]);
    this.resultEditor.revealLineInCenter(line);
    this.resultEditor.setPosition({ lineNumber: line, column: 1 });
  }

  /**
   * Conflict-centric progress ("Conflict i / n"): n counts every conflict in
   * the file; i follows the result-editor caret (the conflict at or before
   * it; 1 before the first). Non-conflicting changes report only a remainder
   * so the user is never staring at a disabled Apply with no explanation.
   */
  private updateCounter(): void {
    const conflicts = this.conflictsByResultLine();
    const total = this.model.getAllChanges().length;
    const unresolvedConflicts = conflicts.filter((c) => !c.isResolved()).length;
    const unresolvedOthers = this.model.getUnresolvedChanges().length - unresolvedConflicts;

    let text: string;
    if (total === 0) {
      text = 'No changes';
    } else if (unresolvedConflicts > 0) {
      text = `Conflict ${this.conflictOrdinal(conflicts)} / ${conflicts.length}`;
    } else if (unresolvedOthers > 0) {
      text =
        conflicts.length === 0
          ? `${unresolvedOthers} non-conflicting left`
          : `All conflicts resolved · ${unresolvedOthers} non-conflicting left`;
    } else {
      // Nothing unresolved: one phrase for the done state, matching the banner.
      text = 'All changes processed';
    }
    const counter = mustGet('counter');
    if (counter.textContent !== text) {
      counter.textContent = text;
    }
  }

  /**
   * Every conflict in the file, sorted ascending by result line, so the
   * "Conflict i / n" ordinal and Prev/Next navigation share one ordering
   * rather than each re-deriving (and re-assuming) getAllChanges() order.
   */
  private conflictsByResultLine(): TextMergeChange[] {
    if (this.conflictsMemo === undefined) {
      this.conflictsMemo = this.model
        .getAllChanges()
        .filter((c) => c.isConflict)
        .sort((a, b) => a.resultStartLine - b.resultStartLine);
    }
    return this.conflictsMemo;
  }

  /** 1-based index of the conflict at or before the result caret. */
  private conflictOrdinal(conflicts: TextMergeChange[]): number {
    const caret = this.resultEditor.getPosition()?.lineNumber ?? 1;
    let ordinal = 1;
    for (let i = 0; i < conflicts.length; i++) {
      if (conflicts[i].resultStartLine + 1 <= caret) {
        ordinal = i + 1;
      }
    }
    return ordinal;
  }

  //
  // Scroll sync
  //

  private anchorsToResult(side: ThreeSide): IAlignAnchor[] {
    return this.model.getAllChanges().map((c) => ({
      start1: c.getStartLine(side),
      end1: c.getEndLine(side),
      start2: c.resultStartLine,
      end2: c.resultEndLine,
    }));
  }

  private wireScrollSync(): void {
    // The scrolled pane drives BOTH other panes directly: relaying through
    // the result would be suppressed by the reentrancy guard, leaving the
    // third pane behind.
    const sync = (
      from: Monaco.editor.IStandaloneCodeEditor,
      targets: ReadonlyArray<{
        to: Monaco.editor.IStandaloneCodeEditor;
        map: (line: number) => number;
      }>
    ): void => {
      from.onDidScrollChange((e) => {
        // Horizontal scroll mirrors verbatim: the three panes share one column
        // grid, so no anchor mapping is needed.
        if (e.scrollLeftChanged && !this.syncingScroll) {
          const scrollLeft = from.getScrollLeft();
          this.syncingScroll = true;
          try {
            for (const { to } of targets) {
              to.setScrollLeft(scrollLeft, monaco.editor.ScrollType.Immediate);
            }
          } finally {
            this.syncingScroll = false;
          }
        }
        if (!e.scrollTopChanged) {
          return;
        }
        if (!this.syncingScroll) {
          const ranges = from.getVisibleRanges();
          if (ranges.length > 0) {
            // Map a FRACTIONAL source line so the driven panes glide with the
            // scroll instead of snapping when the top line index changes.
            const topLine = ranges[0].startLineNumber;
            const lineHeight = from.getOption(monaco.editor.EditorOption.lineHeight);
            const offsetWithinLine = from.getScrollTop() - from.getTopForLineNumber(topLine);
            const sourceLine = topLine - 1 + offsetWithinLine / lineHeight;
            this.syncingScroll = true;
            try {
              for (const { to, map } of targets) {
                const target = map(sourceLine);
                const whole = Math.max(0, Math.floor(target));
                const fraction = target - whole;
                const toLineHeight = to.getOption(monaco.editor.EditorOption.lineHeight);
                to.setScrollTop(
                  Math.max(0, to.getTopForLineNumber(whole + 1) + fraction * toLineHeight),
                  monaco.editor.ScrollType.Immediate
                );
              }
            } finally {
              this.syncingScroll = false;
            }
          }
        }
        this.layoutGutters();
      });
    };

    const toResult =
      (side: ThreeSide): ((line: number) => number) =>
      (line) =>
        mapLine(this.anchorsToResult(side), line);
    const fromResult =
      (side: ThreeSide): ((line: number) => number) =>
      (line) =>
        mapLine(invertAnchors(this.anchorsToResult(side)), line);

    sync(this.leftEditor, [
      { to: this.resultEditor, map: toResult(ThreeSide.LEFT) },
      {
        to: this.rightEditor,
        map: (l) => fromResult(ThreeSide.RIGHT)(toResult(ThreeSide.LEFT)(l)),
      },
    ]);
    sync(this.rightEditor, [
      { to: this.resultEditor, map: toResult(ThreeSide.RIGHT) },
      { to: this.leftEditor, map: (l) => fromResult(ThreeSide.LEFT)(toResult(ThreeSide.RIGHT)(l)) },
    ]);
    sync(this.resultEditor, [
      { to: this.leftEditor, map: fromResult(ThreeSide.LEFT) },
      { to: this.rightEditor, map: fromResult(ThreeSide.RIGHT) },
    ]);
  }

  //
  // Rendering
  //

  private scheduleRender(): void {
    // Every mutation path funnels through here; drop the conflict memo so the
    // next counter/navigation read rebuilds against the changed model.
    this.conflictsMemo = undefined;
    if (this.renderQueued) {
      return;
    }
    this.renderQueued = true;
    queueMicrotask(
      guardContinuation('render', () => {
        this.renderQueued = false;
        this.renderAll();
      })
    );
  }

  /** The chunk text of a side of a change, or null when the side is empty.
   * `fullText` is the pane's LF text, materialized once per render. */
  private chunkText(
    editor: Monaco.editor.IStandaloneCodeEditor,
    fullText: string | null,
    side: ThreeSide,
    change: TextMergeChange
  ): string | null {
    const model = editor.getModel();
    if (!model || fullText === null) {
      return null;
    }
    const start = change.getStartLine(side);
    const end = change.getEndLine(side);
    if (start === end) {
      return null;
    }
    const startOffset = model.getOffsetAt({ lineNumber: start + 1, column: 1 });
    const endOffset =
      end >= model.getLineCount()
        ? fullText.length
        : model.getOffsetAt({ lineNumber: end + 1, column: 1 }) - 1;
    return fullText.substring(startOffset, Math.max(startOffset, endOffset));
  }

  /** The three panes' LF texts, materialized once per render pass. */
  private paneTexts(): [string | null, string | null, string | null] {
    const text = (editor: Monaco.editor.IStandaloneCodeEditor): string | null =>
      editor.getModel()?.getValue(monaco.editor.EndOfLinePreference.LF) ?? null;
    return [text(this.leftEditor), text(this.resultEditor), text(this.rightEditor)];
  }

  /** Word-level highlights inside an unresolved change, per IntelliJ. */
  private innerDifferencesOf(
    change: TextMergeChange,
    texts: [string | null, string | null, string | null]
  ): IMergeInnerDifferences | null {
    const chunks: [string | null, string | null, string | null] = [
      this.chunkText(this.leftEditor, texts[0], ThreeSide.LEFT, change),
      this.chunkText(this.resultEditor, texts[1], ThreeSide.BASE, change),
      this.chunkText(this.rightEditor, texts[2], ThreeSide.RIGHT, change),
    ];
    if (chunks.some((c) => c !== null && c.length > INNER_DIFF_MAX_CHUNK)) {
      return null;
    }
    return compareThreesideInner(chunks, ComparisonPolicy.DEFAULT);
  }

  /**
   * The single ownership predicate: a side paints and acts on only the changes
   * it made, while BASE (the result) owns every change (isChange(BASE) is
   * always true). Pane decorations, the strip band, the strip revert, and the
   * gutter connector all gate on this — the unchanged side of a one-sided
   * change paints nothing (no block, band, revert, or connector).
   */
  private paintsOn(change: TextMergeChange, side: ThreeSide): boolean {
    return change.isChange(side);
  }

  private paneDecorations(
    editor: Monaco.editor.IStandaloneCodeEditor,
    side: ThreeSide,
    innerBySide: Map<number, IMergeInnerDifferences | null>
  ): Monaco.editor.IModelDeltaDecoration[] {
    const model = editor.getModel();
    if (!model) {
      return [];
    }
    const decorations: Monaco.editor.IModelDeltaDecoration[] = [];
    for (const change of this.model.getAllChanges()) {
      if (!this.paintsOn(change, side)) {
        continue;
      }
      const start = change.getStartLine(side);
      const end = change.getEndLine(side);
      const kind = kindOf(change);

      // Whole-line highlights also decorate the line-number margin (same
      // class), so the change band spans the number column instead of leaving
      // a dark gap through it.
      const wholeLine = (
        range: Monaco.Range,
        className: string
      ): Monaco.editor.IModelDeltaDecoration => ({
        range,
        options: { isWholeLine: true, className, marginClassName: className },
      });

      if (change.isResolved()) {
        // IntelliJ paints resolved changes without a fill: just dotted
        // boundary lines in the change color (PaintMode.RESOLVED).
        if (start === end) {
          const line = Math.min(start + 1, model.getLineCount());
          decorations.push(
            wholeLine(new monaco.Range(line, 1, line, 1), `merge-resolved-top k-${kind}`)
          );
        } else if (end - start === 1) {
          decorations.push(
            wholeLine(
              new monaco.Range(start + 1, 1, start + 1, 1),
              `merge-resolved-top merge-resolved-bottom k-${kind}`
            )
          );
        } else {
          decorations.push(
            wholeLine(new monaco.Range(start + 1, 1, start + 1, 1), `merge-resolved-top k-${kind}`)
          );
          decorations.push(
            wholeLine(new monaco.Range(end, 1, end, 1), `merge-resolved-bottom k-${kind}`)
          );
        }
        continue;
      }

      if (start === end) {
        const line = Math.min(start + 1, model.getLineCount());
        decorations.push(wholeLine(new monaco.Range(line, 1, line, 1), `merge-empty k-${kind}`));
      } else {
        decorations.push(wholeLine(new monaco.Range(start + 1, 1, end, 1), `merge-${kind}`));
      }

      // Word-level inner highlights within the block.
      const inner = innerBySide.get(change.index);
      const spans =
        inner === null || inner === undefined
          ? null
          : side === ThreeSide.LEFT
            ? inner.left
            : side === ThreeSide.BASE
              ? inner.base
              : inner.right;
      if (spans && start !== end) {
        const chunkStart = model.getOffsetAt({ lineNumber: start + 1, column: 1 });
        for (const span of spans) {
          if (span.start === span.end) {
            continue;
          }
          const from = model.getPositionAt(chunkStart + span.start);
          const to = model.getPositionAt(chunkStart + span.end);
          decorations.push({
            range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
            options: { className: `merge-word k-${kind}` },
          });
        }
      }

      // Magic-resolve wand in the result gutter for auto-resolvable conflicts.
      if (
        side === ThreeSide.BASE &&
        change.isConflict &&
        this.model.canResolveChangeAutomatically(change.index, ThreeSide.BASE)
      ) {
        const line = Math.min(start + 1, model.getLineCount());
        this.magicGlyphLines.set(line, change.index);
        decorations.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            glyphMarginClassName: 'merge-glyph-magic',
            glyphMarginHoverMessage: { value: 'Resolve this conflict automatically' },
          },
        });
      }
    }
    return decorations;
  }

  private renderAll(): void {
    if (this.restoredTextOnly) {
      this.renderRestoredTextOnly();
      return;
    }
    const texts = this.paneTexts();
    const innerBySide = new Map<number, IMergeInnerDifferences | null>();
    for (const change of this.model.getAllChanges()) {
      if (!change.isResolved()) {
        innerBySide.set(change.index, this.innerDifferencesOf(change, texts));
      }
    }
    this.magicGlyphLines.clear();

    const collections = this.decorationsCollections();
    collections[0].set(this.paneDecorations(this.leftEditor, ThreeSide.LEFT, innerBySide));
    collections[1].set(this.paneDecorations(this.resultEditor, ThreeSide.BASE, innerBySide));
    collections[2].set(this.paneDecorations(this.rightEditor, ThreeSide.RIGHT, innerBySide));

    const unresolved = this.model.getUnresolvedChanges().length;
    const total = this.model.getAllChanges().length;
    this.updateCounter();
    const banner = mustGet('banner');
    banner.textContent =
      total > 0 && unresolved === 0 ? 'All changes processed — press Apply to save and stage.' : '';
    banner.classList.toggle('visible', total > 0 && unresolved === 0);

    (mustGet('btn-reset') as HTMLButtonElement).disabled = unresolved === total || total === 0;
    // Prev/Next fall back to non-conflicting changes once conflicts are gone,
    // so they only grey out when nothing unresolved remains at all.
    (mustGet('btn-prev') as HTMLButtonElement).disabled = unresolved === 0;
    (mustGet('btn-next') as HTMLButtonElement).disabled = unresolved === 0;
    (mustGet('btn-nc-left') as HTMLButtonElement).disabled = !this.model.hasNonConflictedChanges(
      ThreeSide.LEFT
    );
    (mustGet('btn-nc-all') as HTMLButtonElement).disabled = !this.model.hasNonConflictedChanges(
      ThreeSide.BASE
    );
    (mustGet('btn-nc-right') as HTMLButtonElement).disabled = !this.model.hasNonConflictedChanges(
      ThreeSide.RIGHT
    );
    (mustGet('btn-magic-all') as HTMLButtonElement).disabled =
      !this.model.hasAutoResolvableConflictedChanges();

    this.layoutGutters();

    // The text rides along while modified so the host can persist it — a
    // closed tab (which VS Code cannot veto) is then restorable on reopen.
    post({
      type: 'state',
      unresolved,
      total,
      modified: this.model.contentModified,
      pristine: this.pristineText !== undefined && this.resultDoc.getText() === this.pristineText,
      ...(this.model.contentModified ? { resultText: this.resultDoc.getText() } : {}),
    });
  }

  /** Change-driven toolbar actions, all unavailable in a restored session. */
  private static readonly CHANGE_ACTION_BUTTONS = [
    'btn-accept-left',
    'btn-accept-right',
    'btn-reset',
    'btn-prev',
    'btn-next',
    'btn-nc-left',
    'btn-nc-all',
    'btn-nc-right',
    'btn-magic-all',
  ];

  /**
   * Render for a restored result: no highlights, no connectors, no per-change
   * icons, every change-driven action greyed out, and a banner saying why.
   * Apply and Abort stay live — they are the reason the window reopened.
   */
  private renderRestoredTextOnly(): void {
    this.magicGlyphLines.clear();
    for (const collection of this.decorationsCollections()) {
      collection.set([]);
    }
    for (const id of MergeWindow.CHANGE_ACTION_BUTTONS) {
      (mustGet(id) as HTMLButtonElement).disabled = true;
    }
    mustGet('counter').textContent = '';
    const banner = mustGet('banner');
    banner.textContent =
      'Restored merge result — edit the text directly, then press Apply. ' +
      'Per-change actions are unavailable for a restored result.';
    banner.classList.add('visible');

    this.layoutGutters();

    post({
      type: 'state',
      unresolved: 0,
      total: 0,
      modified: true,
      resultText: this.resultDoc.getText(),
    });
  }

  //
  // Divider gutters: connectors + per-change action buttons
  //

  private connectorColorCache = new Map<string, string>();

  /** Theme-derived connector fill for a change kind (matches the highlights). */
  private connectorColor(kind: MergeChangeKind): string {
    const cached = this.connectorColorCache.get(kind);
    if (cached !== undefined) {
      return cached;
    }
    const entry = MERGE_KIND_CONNECTOR_COLORS[kind];
    let color = entry ? entry.fallback : 'rgba(140, 145, 150, 0.45)';
    if (entry) {
      const resolved = window
        .getComputedStyle(document.documentElement)
        .getPropertyValue(entry.cssVar)
        .trim();
      if (resolved !== '') {
        color = resolved;
      }
    }
    this.connectorColorCache.set(kind, color);
    return color;
  }

  /** Pixel span of the line block [startLine, endLine) in a pane's viewport. */
  private blockSpan(
    editor: Monaco.editor.IStandaloneCodeEditor,
    startLine: number,
    endLine: number
  ): IBlockSpan {
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    const scrollTop = editor.getScrollTop();
    const top = editor.getTopForLineNumber(startLine + 1) - scrollTop;
    const bottom =
      startLine === endLine ? top : editor.getTopForLineNumber(endLine) - scrollTop + lineHeight;
    return { top, bottom };
  }

  /** Curve control-point pull, per IntelliJ DiffDrawUtil.CTRL_PROXIMITY_X. */
  private static readonly CTRL_PROXIMITY_X = 0.3;

  private layoutGutters(): void {
    this.layoutGutter(mustGet('gutter-left'), this.leftEditor, ThreeSide.LEFT, false);
    this.layoutGutter(mustGet('gutter-right'), this.rightEditor, ThreeSide.RIGHT, true);
    this.layoutActionStrip(
      mustGet('action-left'),
      this.leftEditor,
      ThreeSide.LEFT,
      Side.LEFT,
      'toward-result-right'
    );
    this.layoutActionStrip(
      mustGet('action-right'),
      this.rightEditor,
      ThreeSide.RIGHT,
      Side.RIGHT,
      'toward-result-left'
    );
  }

  /**
   * One divider-hugging action strip: an apply/ignore pair per unresolved
   * actionable change and a revert icon per resolved one, at the change's
   * first line in the side editor. This stands in for IntelliJ's mirrored
   * editor gutter, which Monaco cannot do.
   */
  private layoutActionStrip(
    stripBody: HTMLElement,
    editor: Monaco.editor.IStandaloneCodeEditor,
    side: ThreeSide,
    actionSide: Side,
    applyDirectionClass: string
  ): void {
    for (const old of Array.from(stripBody.querySelectorAll('.action-btn, .action-band'))) {
      old.remove();
    }

    if (this.restoredTextOnly) {
      return;
    }
    for (const change of this.model.getAllChanges()) {
      // A strip paints and acts on only the changes its own side owns. The
      // unchanged side of a one-sided change paints nothing (no pane block,
      // band, connector, or button), so skip the whole row up front; the
      // result editor always shows the block on its own gutters.
      if (!this.paintsOn(change, side)) {
        continue;
      }
      const span = this.blockSpan(editor, change.getStartLine(side), change.getEndLine(side));
      const y = span.top;

      if (change.isResolved()) {
        const revertBtn = document.createElement('button');
        revertBtn.className = 'action-btn revert';
        revertBtn.title = 'Revert this change back to the base version';
        revertBtn.style.top = `${y}px`;
        revertBtn.addEventListener('click', () => this.revertChange(change.index));
        stripBody.appendChild(revertBtn);
        continue;
      }

      // An unresolved change this side made carries its highlight color across
      // the strip, so the pane band, the icons, and the connector read as one
      // channel.
      const band = document.createElement('div');
      band.className = `action-band k-${kindOf(change)}`;
      band.style.top = `${y}px`;
      band.style.height = `${Math.max(span.bottom - y, 2)}px`;
      stripBody.appendChild(band);

      // A conflict side already resolved individually keeps its band but drops
      // the apply/ignore pair.
      if (change.isResolved(actionSide)) {
        continue;
      }
      const applyBtn = document.createElement('button');
      applyBtn.className = `action-btn apply ${applyDirectionClass}`;
      applyBtn.title = 'Apply this change to the result';
      applyBtn.style.top = `${y}px`;
      applyBtn.addEventListener('click', () => this.applySide(change.index, actionSide));
      stripBody.appendChild(applyBtn);

      const ignoreBtn = document.createElement('button');
      ignoreBtn.className = 'action-btn ignore';
      ignoreBtn.title = 'Ignore this change (mark resolved without applying)';
      ignoreBtn.style.top = `${y}px`;
      ignoreBtn.addEventListener('click', () => this.ignoreSide(change.index, actionSide));
      stripBody.appendChild(ignoreBtn);
    }
  }

  /**
   * One divider gutter: curved canvas connectors linking each change's side
   * block to its result block (IntelliJ's curve trapezium). `sideOnRight`
   * flips the connector: the left gutter has the side editor on its left and
   * the result on its right; the right gutter is mirrored.
   */
  private layoutGutter(
    gutterBody: HTMLElement,
    editor: Monaco.editor.IStandaloneCodeEditor,
    side: ThreeSide,
    sideOnRight: boolean
  ): void {
    const canvas = gutterBody.querySelector('canvas');
    const width = gutterBody.clientWidth || 30;
    const height = gutterBody.clientHeight || 0;
    let ctx: CanvasRenderingContext2D | null = null;
    if (canvas) {
      canvas.width = width;
      canvas.height = height;
      try {
        ctx = canvas.getContext('2d');
        // eslint-disable-next-line no-restricted-syntax -- jsdom (harness) has no canvas implementation; connectors are progressive enhancement there.
      } catch {
        ctx = null;
      }
      ctx?.clearRect(0, 0, width, height);
    }

    if (this.restoredTextOnly) {
      return;
    }

    for (const change of this.model.getAllChanges()) {
      // The side pane paints nothing for the unchanged side of a one-sided
      // change, so its connector would float from a blank block — skip it.
      if (!this.paintsOn(change, side)) {
        continue;
      }
      const sideSpan = this.blockSpan(editor, change.getStartLine(side), change.getEndLine(side));
      const resultSpan = this.blockSpan(
        this.resultEditor,
        change.resultStartLine,
        change.resultEndLine
      );
      // The left gutter touches the side editor at x=0 and the result at
      // x=width; the right gutter is mirrored.
      const atLeftEdge = sideOnRight ? resultSpan : sideSpan;
      const atRightEdge = sideOnRight ? sideSpan : resultSpan;

      if (
        ctx &&
        Math.max(atLeftEdge.bottom, atRightEdge.bottom) >= 0 &&
        Math.min(atLeftEdge.top, atRightEdge.top) <= height
      ) {
        const pull = width * MergeWindow.CTRL_PROXIMITY_X;
        const leftTop = atLeftEdge.top;
        const rightTop = atRightEdge.top;
        const leftBottom = Math.max(atLeftEdge.bottom, atLeftEdge.top + 2);
        const rightBottom = Math.max(atRightEdge.bottom, atRightEdge.top + 2);
        ctx.globalAlpha = change.isResolved() ? 0.25 : 1;
        const color = change.isResolved()
          ? 'rgba(140, 140, 140, 0.45)'
          : this.connectorColor(kindOf(change));

        ctx.beginPath();
        ctx.moveTo(0, leftTop);
        ctx.bezierCurveTo(pull, leftTop, width - pull, rightTop, width, rightTop);
        ctx.lineTo(width, rightBottom);
        ctx.bezierCurveTo(width - pull, rightBottom, pull, leftBottom, 0, leftBottom);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();

        // Center hairline so steep, thin bands never vanish (IntelliJ does
        // the same inside drawCurveTrapezium).
        ctx.beginPath();
        ctx.moveTo(0, (leftTop + leftBottom) / 2);
        ctx.bezierCurveTo(
          pull,
          (leftTop + leftBottom) / 2,
          width - pull,
          (rightTop + rightBottom) / 2,
          width,
          (rightTop + rightBottom) / 2
        );
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  private decorationsLazy: Monaco.editor.IEditorDecorationsCollection[] | undefined;

  private decorationsCollections(): Monaco.editor.IEditorDecorationsCollection[] {
    if (!this.decorationsLazy) {
      this.decorationsLazy = [
        this.leftEditor.createDecorationsCollection(),
        this.resultEditor.createDecorationsCollection(),
        this.rightEditor.createDecorationsCollection(),
      ];
    }
    return this.decorationsLazy;
  }
}

/**
 * Test-only handle onto the live MergeWindow. Theme-sync invalidation has no
 * DOM-observable effect under jsdom (no canvas → connectors never paint), so
 * the webview suite reaches through this to assert the connector-color cache
 * clears. Production code MUST NOT read it.
 * @internal
 */
let mergeWindowForTest: MergeWindow | undefined;

/** @internal — see {@link mergeWindowForTest}. Production MUST NOT call this. */
export function __getMergeWindowForTest(): unknown {
  return mergeWindowForTest;
}

export function boot(): void {
  // Before any DOM work: a throw during skeleton construction must report too.
  installFatalReporter();
  // The panel ships an empty body; the whole skeleton is DOM-built here
  // (createElement, the repo-wide webview convention).
  buildMergeWindowDom(document);

  window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as Partial<IInitMessage> | undefined;
    if (message && message.type === 'init') {
      try {
        mergeWindowForTest = new MergeWindow(message as IInitMessage);
      } catch (err) {
        logToHost('fatal', `merge window failed to initialize: ${String(err)}`);
      }
    }
  });
  post({ type: 'ready' });
}

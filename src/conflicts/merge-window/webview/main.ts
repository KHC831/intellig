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
// dedicated action strip at its divider edge carrying an apply/ignore icon
// pair per unresolved change and a revert icon per resolved one; the result
// editor carries the magic-resolve wand in its glyph margin. The dividers
// themselves hold only the curved canvas connectors.

import type * as Monaco from 'monaco-editor';
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

interface IInitMessage {
  readonly type: 'init';
  readonly left: string;
  readonly base: string;
  readonly right: string;
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly fileName: string;
}

const vscodeApi = acquireVsCodeApi();

function post(message: unknown): void {
  vscodeApi.postMessage(message);
}

function logToHost(level: 'warn' | 'error', text: string): void {
  post({ type: 'log', level, text });
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
    window.addEventListener('resize', () => this.layoutGutters());

    this.model.addListener(() => this.scheduleRender());

    // Like IntelliJ's default, nothing is applied on open: the result starts
    // as the base with every change highlighted and waiting for the user.
    // Every change is resolved individually (side arrows, ignore, wand, or
    // hand edits) — there is deliberately no bulk-apply action.
    this.renderAll();
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
    });
    this.scheduleRender();
  }

  private ignoreSide(index: number, side: Side): void {
    const change = this.model.changeByIndex(index);
    this.model.executeMergeCommand([change.index], () => {
      this.model.ignoreChange(change.index, side, false);
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
      }
    );
    this.scheduleRender();
  }

  /** Puts a resolved change back to its base content, unresolved. */
  private revertChange(index: number): void {
    const change = this.model.changeByIndex(index);
    this.model.executeMergeCommand([change.index], () => {
      this.model.resetResolvedChange(change.index);
    });
    this.scheduleRender();
  }

  private wireToolbar(): void {
    const on = (id: string, handler: () => void): void => {
      mustGet(id).addEventListener('click', handler);
    };
    on('btn-accept-left', () => {
      this.model.acceptRevisionForSide(Side.LEFT);
      this.scheduleRender();
    });
    on('btn-accept-right', () => {
      this.model.acceptRevisionForSide(Side.RIGHT);
      this.scheduleRender();
    });
    on('btn-reset', () => this.resetChanges());
    on('btn-prev', () => this.navigate(-1));
    on('btn-next', () => this.navigate(1));
    on('btn-apply', () => {
      // Greyed out until every change is resolved; guard against
      // programmatic clicks on the disabled button too.
      if ((mustGet('btn-apply') as HTMLButtonElement).disabled) {
        return;
      }
      post({ type: 'apply', resultText: this.resultDoc.getText() });
    });
    on('btn-abort', () => {
      post({ type: 'abort', modified: this.model.contentModified });
    });
  }

  /**
   * Follow VS Code theme switches while the window is open. Monaco's theme
   * and the cached connector colors are both derived at construction; VS Code
   * signals a switch by swapping the body's `vscode-light`/`vscode-dark`
   * class, so observe it and re-derive both.
   */
  private wireThemeSync(): void {
    let applied = document.body.classList.contains('vscode-light') ? 'vs' : 'vs-dark';
    const observer = new MutationObserver(() => {
      const theme = document.body.classList.contains('vscode-light') ? 'vs' : 'vs-dark';
      if (theme === applied) {
        return;
      }
      applied = theme;
      monaco.editor.setTheme(theme);
      // Connector fills read theme CSS variables; drop the cache so the next
      // layout samples the new theme's values.
      this.connectorColorCache.clear();
      this.layoutGutters();
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
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
        this.model.resolveChangeAutomatically(index, ThreeSide.BASE);
      });
      this.scheduleRender();
    });
  }

  /**
   * Jump the result editor to the previous/next unresolved change relative
   * to the caret (IntelliJ navigates from the caret too). A stored cursor
   * would desync as changes resolve and the unresolved list re-indexes.
   */
  private navigate(direction: -1 | 1): void {
    const model = this.resultEditor.getModel();
    const lineCount = model ? model.getLineCount() : 1;
    const lines = this.model
      .getUnresolvedChanges()
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
    if (this.renderQueued) {
      return;
    }
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.renderAll();
    });
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
      const start = change.getStartLine(side);
      const end = change.getEndLine(side);
      const kind = kindOf(change);

      if (change.isResolved()) {
        // IntelliJ paints resolved changes without a fill: just dotted
        // boundary lines in the change color (PaintMode.RESOLVED).
        if (start === end) {
          const line = Math.min(start + 1, model.getLineCount());
          decorations.push({
            range: new monaco.Range(line, 1, line, 1),
            options: { isWholeLine: true, className: `merge-resolved-top k-${kind}` },
          });
        } else if (end - start === 1) {
          decorations.push({
            range: new monaco.Range(start + 1, 1, start + 1, 1),
            options: {
              isWholeLine: true,
              className: `merge-resolved-top merge-resolved-bottom k-${kind}`,
            },
          });
        } else {
          decorations.push({
            range: new monaco.Range(start + 1, 1, start + 1, 1),
            options: { isWholeLine: true, className: `merge-resolved-top k-${kind}` },
          });
          decorations.push({
            range: new monaco.Range(end, 1, end, 1),
            options: { isWholeLine: true, className: `merge-resolved-bottom k-${kind}` },
          });
        }
        continue;
      }

      if (start === end) {
        const line = Math.min(start + 1, model.getLineCount());
        decorations.push({
          range: new monaco.Range(line, 1, line, 1),
          options: { isWholeLine: true, className: `merge-empty merge-${kind}` },
        });
      } else {
        decorations.push({
          range: new monaco.Range(start + 1, 1, end, 1),
          options: { isWholeLine: true, className: `merge-${kind}` },
        });
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
    mustGet('counter').textContent =
      total === 0
        ? 'No changes'
        : unresolved === 0
          ? 'All changes processed'
          : `${unresolved} of ${total} changes remaining`;
    const banner = mustGet('banner');
    banner.textContent =
      total > 0 && unresolved === 0 ? 'All changes processed — press Apply to save and stage.' : '';
    banner.classList.toggle('visible', total > 0 && unresolved === 0);

    (mustGet('btn-reset') as HTMLButtonElement).disabled = unresolved === total || total === 0;
    (mustGet('btn-apply') as HTMLButtonElement).disabled = unresolved > 0;

    this.layoutGutters();

    post({ type: 'state', unresolved, total, modified: this.model.contentModified });
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
    for (const old of Array.from(stripBody.querySelectorAll('.action-btn'))) {
      old.remove();
    }
    for (const change of this.model.getAllChanges()) {
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

      if (!change.isChange(actionSide) || change.isResolved(actionSide)) {
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

    for (const change of this.model.getAllChanges()) {
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

export function boot(): void {
  // The panel ships an empty body; the whole skeleton is DOM-built here
  // (createElement, the repo-wide webview convention).
  buildMergeWindowDom(document);

  window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as Partial<IInitMessage> | undefined;
    if (message && message.type === 'init') {
      try {
        new MergeWindow(message as IInitMessage);
      } catch (err) {
        logToHost('error', `merge window failed to initialize: ${String(err)}`);
      }
    }
  });
  post({ type: 'ready' });
}

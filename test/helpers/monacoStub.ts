/**
 * Minimal Monaco stub for driving the merge window's webview script
 * (src/conflicts/merge-window/webview/main.ts) under jsdom. Implements just
 * the surface the script touches: editor creation, a text model with real
 * offset/position math (over LF text, via LineOffsetsImpl), content-change
 * events in Monaco's pre-change coordinates, scroll/geometry getters, and
 * the enums/namespaces referenced. No layout, no painting.
 */

import { LineOffsetsImpl } from '../../src/diff-engine/text/LineOffsets';

export interface IStubContentChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

export class StubRange {
  constructor(
    readonly startLineNumber: number,
    readonly startColumn: number,
    readonly endLineNumber: number,
    readonly endColumn: number
  ) {}
}

export class StubTextModel {
  private value: string;
  readonly contentListeners: Array<(e: { changes: IStubContentChange[] }) => void> = [];

  constructor(value: string) {
    this.value = value;
  }

  private offsets(): LineOffsetsImpl {
    return LineOffsetsImpl.create(this.value) as LineOffsetsImpl;
  }

  getValue(_preference?: unknown): string {
    return this.value;
  }

  setValue(newValue: string): void {
    this.applyRawEdits([{ offset: 0, end: this.value.length, text: newValue }]);
  }

  getPositionAt(offset: number): { lineNumber: number; column: number } {
    const clamped = Math.max(0, Math.min(offset, this.value.length));
    const lineOffsets = this.offsets();
    const line = lineOffsets.getLineNumber(clamped);
    return { lineNumber: line + 1, column: clamped - lineOffsets.getLineStart(line) + 1 };
  }

  offsetAt(position: { lineNumber: number; column: number }): number {
    return this.offsets().getLineStart(position.lineNumber - 1) + position.column - 1;
  }

  getOffsetAt(position: { lineNumber: number; column: number }): number {
    return this.offsetAt(position);
  }

  getLineCount(): number {
    return this.offsets().lineCount;
  }

  setEOL(_sequence: unknown): void {}

  applyEdits(edits: Array<{ range: StubRange; text: string }>): void {
    this.applyRawEdits(
      edits.map((e) => ({
        offset: this.offsetAt({ lineNumber: e.range.startLineNumber, column: e.range.startColumn }),
        end: this.offsetAt({ lineNumber: e.range.endLineNumber, column: e.range.endColumn }),
        text: e.text,
      }))
    );
  }

  /** Applies edits given in current-text offsets and fires one change event. */
  applyRawEdits(edits: Array<{ offset: number; end: number; text: string }>): void {
    const ordered = [...edits].sort((a, b) => b.offset - a.offset);
    const changes: IStubContentChange[] = [];
    for (const edit of ordered) {
      changes.push({
        rangeOffset: edit.offset,
        rangeLength: edit.end - edit.offset,
        text: edit.text,
      });
      this.value =
        this.value.substring(0, edit.offset) + edit.text + this.value.substring(edit.end);
    }
    const event = { changes };
    for (const listener of [...this.contentListeners]) {
      listener(event);
    }
  }
}

export interface IStubDecorationsCollection {
  decorations: unknown[];
  set(decorations: unknown[]): void;
}

export interface IStubMouseEvent {
  target: {
    type: number;
    position?: { lineNumber: number };
    detail?: unknown;
  };
}

export class StubEditor {
  private scrollTop = 0;
  readonly collections: IStubDecorationsCollection[] = [];
  readonly scrollListeners: Array<(e: { scrollTopChanged: boolean }) => void> = [];
  readonly mouseDownListeners: Array<(e: IStubMouseEvent) => void> = [];
  revealedLine: number | undefined;

  constructor(
    readonly model: StubTextModel,
    readonly options: Record<string, unknown>
  ) {}

  getModel(): StubTextModel {
    return this.model;
  }

  onDidChangeModelContent(cb: (e: { changes: IStubContentChange[] }) => void): {
    dispose(): void;
  } {
    this.model.contentListeners.push(cb);
    return { dispose: (): void => undefined };
  }

  onDidScrollChange(cb: (e: { scrollTopChanged: boolean }) => void): { dispose(): void } {
    this.scrollListeners.push(cb);
    return { dispose: (): void => undefined };
  }

  /** Keybinding → handler, as registered via addCommand. */
  readonly commands = new Map<number, () => void>();

  addCommand(keybinding: number, handler: () => void): string | null {
    this.commands.set(keybinding, handler);
    return null;
  }

  /** Test helper: invoke a command registered for a keybinding. */
  runCommand(keybinding: number): void {
    this.commands.get(keybinding)?.();
  }

  onMouseDown(cb: (e: IStubMouseEvent) => void): { dispose(): void } {
    this.mouseDownListeners.push(cb);
    return { dispose: (): void => undefined };
  }

  /** Test helper: simulate a glyph-margin click on a 1-based line. */
  clickGlyphMargin(lineNumber: number): void {
    for (const listener of [...this.mouseDownListeners]) {
      listener({ target: { type: 2, position: { lineNumber } } });
    }
  }

  revealLineInCenter(lineNumber: number): void {
    this.revealedLine = lineNumber;
  }

  private position = { lineNumber: 1, column: 1 };

  setPosition(position: { lineNumber: number; column: number }): void {
    this.position = position;
  }

  getPosition(): { lineNumber: number; column: number } {
    return this.position;
  }

  createDecorationsCollection(): IStubDecorationsCollection {
    const collection: IStubDecorationsCollection = {
      decorations: [],
      set(decorations: unknown[]): void {
        this.decorations = decorations;
      },
    };
    this.collections.push(collection);
    return collection;
  }

  getVisibleRanges(): Array<{ startLineNumber: number }> {
    return [{ startLineNumber: 1 }];
  }

  getScrollTop(): number {
    return this.scrollTop;
  }

  setScrollTop(value: number, _type?: unknown): void {
    this.scrollTop = value;
    for (const listener of [...this.scrollListeners]) {
      listener({ scrollTopChanged: true });
    }
  }

  getTopForLineNumber(lineNumber: number): number {
    return (lineNumber - 1) * 18;
  }

  getOption(_id: unknown): number {
    return 18; // lineHeight
  }
}

export interface IMonacoStub {
  stub: Record<string, unknown>;
  /** Editors in creation order: [left, result, right]. */
  editors: StubEditor[];
}

export function createMonacoStub(): IMonacoStub {
  const editors: StubEditor[] = [];
  const stub = {
    editor: {
      create(_el: unknown, options: Record<string, unknown>): StubEditor {
        const editor = new StubEditor(new StubTextModel(String(options.value ?? '')), options);
        editors.push(editor);
        return editor;
      },
      EndOfLineSequence: { LF: 0 },
      EndOfLinePreference: { LF: 1 },
      ScrollType: { Smooth: 0, Immediate: 1 },
      EditorOption: { lineHeight: 66 },
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
    },
    languages: {
      getLanguages(): Array<{ id: string; extensions?: string[] }> {
        return [{ id: 'plaintext', extensions: ['.txt'] }];
      },
    },
    Range: StubRange,
    KeyMod: { CtrlCmd: 2048, Shift: 1024 },
    KeyCode: { KeyZ: 56, KeyY: 55 },
  };
  return { stub, editors };
}

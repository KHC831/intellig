// The in-memory document the merge model works against, replacing IntelliJ's
// com.intellij.openapi.editor.Document. Change events carry the same
// information as DocumentEvent (offset, old fragment, new fragment), and
// replaceString trims the common prefix/suffix and ignores no-op replacements
// like DocumentImpl does, so range-shifting math sees minimal regions.

import { ILineOffsets, LineOffsetsImpl } from '../../diff-engine/text/LineOffsets';
import type { MergeUndoManager } from './MergeUndoManager';

export interface IDocumentEvent {
  readonly offset: number;
  readonly oldFragment: string;
  readonly newFragment: string;
}

export interface IMergeDocumentListener {
  beforeDocumentChange?(event: IDocumentEvent): void;
  documentChanged?(event: IDocumentEvent): void;
}

export interface IMergeDocument {
  getText(): string;
  readonly textLength: number;
  getLineOffsets(): ILineOffsets;
  replaceString(startOffset: number, endOffset: number, newText: string): void;
  setText(text: string): void;
  /** Replaces the whole text without recording an undo step (initial merge content). */
  setTextNonUndoable(text: string): void;
  addDocumentListener(listener: IMergeDocumentListener): void;
  removeDocumentListener(listener: IMergeDocumentListener): void;
}

export class StringMergeDocument implements IMergeDocument {
  private text: string;
  private lineOffsets: ILineOffsets | undefined;
  private readonly listeners: IMergeDocumentListener[] = [];
  private suppressUndo = false;

  constructor(
    text: string = '',
    private readonly undoManager?: MergeUndoManager
  ) {
    this.text = text;
  }

  getText(): string {
    return this.text;
  }

  get textLength(): number {
    return this.text.length;
  }

  getLineOffsets(): ILineOffsets {
    if (this.lineOffsets === undefined) {
      this.lineOffsets = LineOffsetsImpl.create(this.text);
    }
    return this.lineOffsets;
  }

  replaceString(startOffset: number, endOffset: number, newText: string): void {
    if (startOffset < 0 || startOffset > endOffset || endOffset > this.text.length) {
      throw new RangeError(
        `Wrong replace range: [${startOffset}, ${endOffset}); text length: ${this.text.length}`
      );
    }
    const oldText = this.text.substring(startOffset, endOffset);

    let prefix = 0;
    const maxPrefix = Math.min(oldText.length, newText.length);
    while (prefix < maxPrefix && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
      prefix++;
    }
    let suffix = 0;
    const maxSuffix = Math.min(oldText.length, newText.length) - prefix;
    while (
      suffix < maxSuffix &&
      oldText.charCodeAt(oldText.length - 1 - suffix) ===
        newText.charCodeAt(newText.length - 1 - suffix)
    ) {
      suffix++;
    }

    const oldFragment = oldText.substring(prefix, oldText.length - suffix);
    const newFragment = newText.substring(prefix, newText.length - suffix);
    if (oldFragment === newFragment) {
      return;
    }

    const event: IDocumentEvent = { offset: startOffset + prefix, oldFragment, newFragment };
    for (const listener of [...this.listeners]) {
      listener.beforeDocumentChange?.(event);
    }

    this.text =
      this.text.substring(0, event.offset) +
      newFragment +
      this.text.substring(event.offset + oldFragment.length);
    this.lineOffsets = undefined;

    if (!this.suppressUndo) {
      this.undoManager?.documentChangePerformed(this, event);
    }

    for (const listener of [...this.listeners]) {
      listener.documentChanged?.(event);
    }
  }

  setText(text: string): void {
    this.replaceString(0, this.text.length, text);
  }

  setTextNonUndoable(text: string): void {
    this.suppressUndo = true;
    try {
      this.replaceString(0, this.text.length, text);
    } finally {
      this.suppressUndo = false;
    }
  }

  addDocumentListener(listener: IMergeDocumentListener): void {
    this.listeners.push(listener);
  }

  removeDocumentListener(listener: IMergeDocumentListener): void {
    const index = this.listeners.indexOf(listener);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }
}

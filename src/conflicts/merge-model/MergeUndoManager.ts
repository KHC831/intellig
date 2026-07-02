// Headless replacement for IntelliJ's UndoManager as the merge model uses it:
// commands group undoable actions, undo runs a group's actions in reverse
// order (so document text is restored before the model's saved change states
// are re-applied), and actions performed while an undo/redo is in progress
// are ignored.

import type { IDocumentEvent, IMergeDocument } from './MergeDocument';

export interface IUndoableAction {
  undo(): void;
  redo(): void;
}

class DocumentChangeAction implements IUndoableAction {
  constructor(
    private readonly document: IMergeDocument,
    private readonly event: IDocumentEvent
  ) {}

  undo(): void {
    const { offset, oldFragment, newFragment } = this.event;
    this.document.replaceString(offset, offset + newFragment.length, oldFragment);
  }

  redo(): void {
    const { offset, oldFragment, newFragment } = this.event;
    this.document.replaceString(offset, offset + oldFragment.length, newFragment);
  }
}

export class MergeUndoManager {
  private readonly undoStack: IUndoableAction[][] = [];
  private readonly redoStack: IUndoableAction[][] = [];
  private currentGroup: IUndoableAction[] | undefined;
  private undoRedoInProgress = false;

  get isUndoOrRedoInProgress(): boolean {
    return this.undoRedoInProgress;
  }

  /** Runs the task as one undo step; nested commands merge into the outer one. */
  executeCommand(task: () => void): void {
    if (this.currentGroup !== undefined) {
      task();
      return;
    }
    const group: IUndoableAction[] = [];
    this.currentGroup = group;
    try {
      task();
    } finally {
      this.currentGroup = undefined;
      if (group.length > 0) {
        this.undoStack.push(group);
        this.redoStack.length = 0;
      }
    }
  }

  undoableActionPerformed(action: IUndoableAction): void {
    if (this.undoRedoInProgress) {
      return;
    }
    if (this.currentGroup !== undefined) {
      this.currentGroup.push(action);
    } else {
      this.undoStack.push([action]);
      this.redoStack.length = 0;
    }
  }

  documentChangePerformed(document: IMergeDocument, event: IDocumentEvent): void {
    this.undoableActionPerformed(new DocumentChangeAction(document, event));
  }

  isUndoAvailable(): boolean {
    return this.undoStack.length > 0;
  }

  isRedoAvailable(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const group = this.undoStack.pop();
    if (group === undefined) {
      throw new Error('nothing to undo');
    }
    this.undoRedoInProgress = true;
    try {
      for (let i = group.length - 1; i >= 0; i--) {
        group[i].undo();
      }
    } finally {
      this.undoRedoInProgress = false;
    }
    this.redoStack.push(group);
  }

  redo(): void {
    const group = this.redoStack.pop();
    if (group === undefined) {
      throw new Error('nothing to redo');
    }
    this.undoRedoInProgress = true;
    try {
      for (const action of group) {
        action.redo();
      }
    } finally {
      this.undoRedoInProgress = false;
    }
    this.undoStack.push(group);
  }
}

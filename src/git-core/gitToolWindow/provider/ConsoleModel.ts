/**
 * The Git tool window's Console tab entries: a bounded append ring with
 * in-place streaming updates. Owned by GitToolWindowProvider as
 * `provider.console`; renders and the state event go through
 * {@link IConsoleHost}, gated on the Console tab being the visible one.
 */

import type { IConsoleEntry } from '../../interfaces/IGitToolWindowProvider';
import type { TabId } from '../tabIds';

const DEFAULT_MAX_CONSOLE_ENTRIES = 1000;

/**
 * The provider-side effects this model is allowed to cause. Function-typed
 * call-time lambdas (live reads), built once in the provider constructor.
 */
export interface IConsoleHost {
  render: () => void;
  fireStateChange: () => void;
  getActiveTab: () => TabId;
}

export class ConsoleModel {
  private _consoleEntries: IConsoleEntry[] = [];
  private _maxConsoleEntries: number = DEFAULT_MAX_CONSOLE_ENTRIES;

  constructor(private readonly _host: IConsoleHost) {}

  /** The entries as currently held, for the Console tab body render. */
  public getEntries(): readonly IConsoleEntry[] {
    return this._consoleEntries;
  }

  /**
   * Add a console entry
   */
  public addConsoleEntry(entry: Omit<IConsoleEntry, 'timestamp'>): void {
    // render-unconditional: appends. Two identical calls produce two different
    // console states, so repainting for the second one is correct.
    const fullEntry: IConsoleEntry = {
      ...entry,
      timestamp: new Date(),
    };

    this._consoleEntries.push(fullEntry);

    // Trim entries if exceeding max
    while (this._consoleEntries.length > this._maxConsoleEntries) {
      this._consoleEntries.shift();
    }

    // Only re-render when the Console tab is actually visible — mirrors the
    // History/Incoming tabs. Every git command logs an entry here, including
    // the `git show` a commit selection fires; an unconditional re-render
    // rebuilt the whole graph+details DOM on every git command, discarding the
    // user's live-dragged divider/column widths and scroll (the "graph resizes
    // on every click" bug) and producing a startup re-render storm. The Console
    // tab re-reads the entries from in-memory state on its next render.
    if (this._host.getActiveTab() === 'console') {
      this._host.render();
    }
    this._host.fireStateChange();
  }

  /**
   * Update a streaming entry in place.
   *
   * Deliberately narrower than `addConsoleEntry`: it re-renders only while the
   * Console tab is showing and fires no refresh, because a chatty clone emits
   * thousands of chunks and a full data reload per chunk is the refresh storm
   * this view already paid for once.
   *
   * That closes the data half only. The render itself still reassigns
   * `webview.html`, so a visible Console tab reloads the document on each
   * flush and console scroll still resets mid-clone. Appending streamed bytes
   * over `postMessage` is the remaining half.
   */
  public updateConsoleEntry(update: {
    id: string;
    output: string;
    exitCode?: number;
    isError?: boolean;
  }): void {
    // render-unconditional: writing identical values still repaints. That is a
    // real defect and this annotation is where it stays visible; fixing it
    // means comparing against the stored entry and moving this name into
    // RENDER_IDEMPOTENCE_CASES.
    const entry = this._consoleEntries.find((e) => e.id === update.id);
    if (!entry) {
      return;
    }
    entry.output = update.output;
    if (update.exitCode !== undefined) {
      entry.exitCode = update.exitCode;
    }
    if (update.isError !== undefined) {
      entry.isError = update.isError;
    }
    if (this._host.getActiveTab() === 'console') {
      this._host.render();
    }
    this._host.fireStateChange();
  }

  /**
   * Clear console entries.
   *
   * Gated the same way as its two siblings, for the same reason: the render
   * reassigns `webview.html`, so clearing the console while the Log tab is
   * showing would destroy the log document — including a filter draft, which
   * lives only in the DOM. An already-empty list is not a change at all, so it
   * returns before both the render and the state event.
   */
  public clearConsole(): void {
    if (this._consoleEntries.length === 0) {
      return;
    }
    this._consoleEntries = [];
    if (this._host.getActiveTab() === 'console') {
      this._host.render();
    }
    this._host.fireStateChange();
  }
}

/**
 * Typed helpers for stubbing `vscode.window` message / quick-pick / input
 * functions in unit + property tests.
 *
 * The real `vscode.window` is typed as `readonly` namespace; overriding its
 * functions requires writing through an index signature. These helpers wrap
 * that in a small, explicit `WritableWindow` interface so call sites don't
 * have to `(vscode.window as any).showXxx = …`, which produces
 * `@typescript-eslint/no-unsafe-member-access` errors.
 *
 * Use via:
 *
 *     const tracker = installErrorMessageTracker();
 *     ...
 *     restoreMessageFunctions();
 */

import * as vscode from 'vscode';

/** One recorded invocation of a `show*Message` function. */
export interface MessageCall {
  message: string;
  items: string[];
}

/**
 * Mutable slice of `vscode.window` whose functions we override in tests.
 *
 * TL-28 tightening: VS Code option bags are modelled as their real types
 * where that doesn't break the existing call shape, so IntelliSense shows
 * real fields instead of `unknown`. The variadic `items: unknown[]` shape
 * on `showWarningMessage` / `showQuickPick` is intentional — call sites
 * pass an options object or a list of labels interchangeably, matching
 * the real `vscode.window` overload set.
 */
export interface WritableWindow {
  showInformationMessage: (message: string, ...items: string[]) => Promise<string | undefined>;
  showErrorMessage: (message: string, ...items: string[]) => Promise<string | undefined>;
  showWarningMessage: (message: string, ...items: unknown[]) => Promise<string | undefined>;
  showQuickPick: (items: unknown[], options?: unknown) => Promise<unknown>;
  showInputBox: (options?: vscode.InputBoxOptions) => Promise<string | undefined>;
  showSaveDialog: (options?: vscode.SaveDialogOptions) => Promise<vscode.Uri | undefined>;
  showOpenDialog: (options?: vscode.OpenDialogOptions) => Promise<vscode.Uri[] | undefined>;
  /**
   * Typed as `vscode.TextEditor | undefined` so tests that stub the active
   * editor get the real VS Code shape via IntelliSense rather than `unknown`.
   */
  activeTextEditor?: vscode.TextEditor;
}

/** Mutable slice of `vscode.env` whose fields we override in tests. */
export interface WritableEnv {
  clipboard: {
    writeText: (text: string) => Promise<void>;
    readText: () => Promise<string>;
  };
}

/** Mutable slice of `vscode.commands` whose functions we override in tests. */
export interface WritableCommands {
  executeCommand: (command: string, ...rest: unknown[]) => Promise<unknown>;
  registerCommand: (
    command: string,
    callback: (...args: unknown[]) => unknown
  ) => { dispose(): void };
}

/** Mutable slice of `vscode.workspace` whose fields we override in tests. */
export interface WritableWorkspace {
  fs: {
    writeFile: (uri: vscode.Uri, content: Uint8Array) => Promise<void>;
    readFile: (uri: vscode.Uri) => Promise<Uint8Array>;
    [k: string]: unknown;
  };
}

/**
 * Return the `vscode.window` object typed as a `WritableWindow` so callers
 * can reassign its methods without tripping `no-unsafe-member-access`.
 */
export function writableWindow(): WritableWindow {
  return vscode.window as unknown as WritableWindow;
}

/** Like `writableWindow` but for `vscode.env`. */
export function writableEnv(): WritableEnv {
  return vscode.env as unknown as WritableEnv;
}

/** Like `writableWindow` but for `vscode.commands`. */
export function writableCommands(): WritableCommands {
  return vscode.commands as unknown as WritableCommands;
}

/** Like `writableWindow` but for `vscode.workspace`. */
export function writableWorkspace(): WritableWorkspace {
  return vscode.workspace as unknown as WritableWorkspace;
}

/** Tracker with a list of recorded calls + reset helper. */
export interface MessageTracker {
  calls: MessageCall[];
  reset(): void;
}

function makeTracker(): MessageTracker {
  const tracker: MessageTracker = {
    calls: [],
    reset() {
      this.calls = [];
    },
  };
  return tracker;
}

/** Install a tracking stub on `vscode.window.showErrorMessage`. */
export function installErrorMessageTracker(): MessageTracker {
  const tracker = makeTracker();
  writableWindow().showErrorMessage = (
    message: string,
    ...items: string[]
  ): Promise<string | undefined> => {
    tracker.calls.push({ message, items });
    return Promise.resolve(undefined);
  };
  return tracker;
}

/**
 * Install a tracking stub on `vscode.window.showWarningMessage`. An optional
 * `returnChoice` may be supplied, in which case every call resolves to that
 * choice (used to simulate user confirmation dialogs).
 */
export function installWarningMessageTracker(returnChoice?: string): MessageTracker {
  const tracker = makeTracker();
  writableWindow().showWarningMessage = (
    message: string,
    ...items: unknown[]
  ): Promise<string | undefined> => {
    // Filter out option objects (like `{ modal: true }`) so trackers record
    // only the string labels the user would see.
    const stringItems = items.filter((i): i is string => typeof i === 'string');
    tracker.calls.push({ message, items: stringItems });
    return Promise.resolve(returnChoice);
  };
  return tracker;
}

/** Install a tracking stub on `vscode.window.showInformationMessage`. */
export function installInfoMessageTracker(): MessageTracker {
  const tracker = makeTracker();
  writableWindow().showInformationMessage = (
    message: string,
    ...items: string[]
  ): Promise<string | undefined> => {
    tracker.calls.push({ message, items });
    return Promise.resolve(undefined);
  };
  return tracker;
}

/** Reset the three message functions to no-op stubs. */
export function restoreMessageFunctions(): void {
  const w = writableWindow();
  w.showErrorMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
  w.showWarningMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
  w.showInformationMessage = (): Promise<string | undefined> => Promise.resolve(undefined);
}

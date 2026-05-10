/**
 * Tier-2 command E2E — user-prompt stubs.
 *
 * Many commands short-circuit without their quickpick / input / save-dialog
 * answer. We stub those namespace methods for the duration of a single test
 * so the extension sees a deterministic user choice, then restore the
 * original implementation in `afterEach`. Tests MUST call `restore()` — a
 * try/finally wrapper in the test is the safest pattern.
 */

import * as vscode from 'vscode';

type QuickPickFn = typeof vscode.window.showQuickPick;
type InputBoxFn = typeof vscode.window.showInputBox;
type SaveDialogFn = typeof vscode.window.showSaveDialog;
type WarningMessageFn = typeof vscode.window.showWarningMessage;
type InformationMessageFn = typeof vscode.window.showInformationMessage;
type ErrorMessageFn = typeof vscode.window.showErrorMessage;

/** Handles returned from {@link stubPrompts}. Call `.restore()` in afterEach. */
export interface PromptStubs {
  /** Per-call args recorded on every intercepted call. */
  quickPickCalls: Array<unknown>;
  inputBoxCalls: Array<vscode.InputBoxOptions | undefined>;
  saveDialogCalls: Array<vscode.SaveDialogOptions | undefined>;
  warningMessageCalls: Array<{ message: string; options?: unknown; items: unknown[] }>;
  restore: () => void;
}

/**
 * Options for {@link stubPrompts}. Each field supplies the answer the test
 * wants the corresponding vscode.window method to return. An `undefined`
 * answer means "the user cancelled the prompt" — matches vscode's own
 * semantics.
 *
 * `quickPick` and `warningMessage` receive the full args (`items`/`message`)
 * so the test can choose its return based on what the extension asked.
 */
export interface StubPromptOptions {
  quickPick?: (items: unknown, opts?: unknown) => unknown;
  inputBox?: (opts?: vscode.InputBoxOptions) => string | undefined;
  saveDialog?: (opts?: vscode.SaveDialogOptions) => vscode.Uri | undefined;
  warningMessage?: (
    message: string,
    optionsOrItems: unknown,
    ...items: unknown[]
  ) => string | undefined;
  /**
   * Suppress information toasts entirely (they're chatty in test output).
   * Default: true.
   */
  silenceInfoMessages?: boolean;
  /**
   * Suppress error toasts. Default: true, because we assert on outcomes via
   * git state rather than toast text.
   */
  silenceErrorMessages?: boolean;
}

export function stubPrompts(options: StubPromptOptions = {}): PromptStubs {
  const orig = {
    quickPick: vscode.window.showQuickPick,
    inputBox: vscode.window.showInputBox,
    saveDialog: vscode.window.showSaveDialog,
    warningMessage: vscode.window.showWarningMessage,
    informationMessage: vscode.window.showInformationMessage,
    errorMessage: vscode.window.showErrorMessage,
  };

  const stubs: PromptStubs = {
    quickPickCalls: [],
    inputBoxCalls: [],
    saveDialogCalls: [],
    warningMessageCalls: [],
    restore: () => {
      vscode.window.showQuickPick = orig.quickPick;
      vscode.window.showInputBox = orig.inputBox;
      vscode.window.showSaveDialog = orig.saveDialog;
      vscode.window.showWarningMessage = orig.warningMessage;
      vscode.window.showInformationMessage = orig.informationMessage;
      vscode.window.showErrorMessage = orig.errorMessage;
    },
  };

  // Typed as `any` here because vscode.window.showQuickPick has several
  // overloads we'd otherwise have to enumerate for the mock; the test code
  // stays strongly typed through the `options.quickPick` parameter.
  // Bodies are sync but must return a Thenable to satisfy the vscode API
  // contract consumers rely on — hence `Promise.resolve(...)` rather than
  // `async` (no `await` expressions inside).
  (vscode.window as unknown as { showQuickPick: QuickPickFn }).showQuickPick = ((
    items: unknown,
    opts?: unknown
  ) => {
    stubs.quickPickCalls.push(items);
    return Promise.resolve(options.quickPick ? options.quickPick(items, opts) : undefined);
  }) as unknown as QuickPickFn;

  (vscode.window as unknown as { showInputBox: InputBoxFn }).showInputBox = ((
    opts?: vscode.InputBoxOptions
  ) => {
    stubs.inputBoxCalls.push(opts);
    return Promise.resolve(options.inputBox ? options.inputBox(opts) : undefined);
  }) as unknown as InputBoxFn;

  (vscode.window as unknown as { showSaveDialog: SaveDialogFn }).showSaveDialog = ((
    opts?: vscode.SaveDialogOptions
  ) => {
    stubs.saveDialogCalls.push(opts);
    return Promise.resolve(options.saveDialog ? options.saveDialog(opts) : undefined);
  }) as unknown as SaveDialogFn;

  (vscode.window as unknown as { showWarningMessage: WarningMessageFn }).showWarningMessage = ((
    message: string,
    optionsOrItems: unknown,
    ...items: unknown[]
  ) => {
    stubs.warningMessageCalls.push({ message, options: optionsOrItems, items });
    return Promise.resolve(
      options.warningMessage ? options.warningMessage(message, optionsOrItems, ...items) : undefined
    );
  }) as unknown as WarningMessageFn;

  const silenceInfo = options.silenceInfoMessages !== false;
  if (silenceInfo) {
    (
      vscode.window as unknown as { showInformationMessage: InformationMessageFn }
    ).showInformationMessage = ((_message: string, ..._rest: unknown[]) =>
      Promise.resolve(undefined)) as unknown as InformationMessageFn;
  }

  const silenceError = options.silenceErrorMessages !== false;
  if (silenceError) {
    (vscode.window as unknown as { showErrorMessage: ErrorMessageFn }).showErrorMessage = ((
      _message: string,
      ..._rest: unknown[]
    ) => Promise.resolve(undefined)) as unknown as ErrorMessageFn;
  }

  return stubs;
}

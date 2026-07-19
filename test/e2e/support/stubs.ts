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
  /**
   * Error toasts recorded even when silenced from the user. Tests
   * asserting on git-state outcomes can include this in their failure
   * messages so a regressing handler's error is visible in CI logs
   * instead of vanishing into a silenced toast. The handler's error
   * message is the primary diagnostic for "command did nothing"
   * symptoms — without this list, we have no observable trail.
   */
  errorMessageCalls: Array<{ message: string; items: unknown[] }>;
  /**
   * Information toasts recorded even when silenced. Same rationale as
   * `errorMessageCalls`: the user's silenced toast may be the only
   * evidence the handler emitted SOMETHING.
   */
  informationMessageCalls: Array<{ message: string; items: unknown[] }>;
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
 *
 * A `quickPick` answerer runs under the REAL platform contract: when the
 * extension passes `canPickMany: true`, VS Code resolves an ARRAY. The stub
 * normalises to that shape (see {@link resolveQuickPickAnswer}), so a spec that
 * returns a single item from a multi-pick still hands the extension what the
 * platform would — a single-item array, not a bare item.
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
   * Answer information toasts that carry action items (offers like "Delete
   * Tracked Branch"). When omitted, info toasts resolve `undefined` (recorded
   * but unanswered) — the long-standing default.
   */
  informationMessage?: (message: string, ...items: unknown[]) => string | undefined;
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

/**
 * Shape a quick-pick answer to the platform's contract.
 *
 * `canPickMany: true` resolves an ARRAY in real VS Code; a stub that returns a
 * bare item makes `.map`/`.filter` on the extension side throw under the
 * harness ONLY — a false failure that says nothing about production. Rules:
 *
 *  - single-select: pass the answer through unchanged;
 *  - multi-select, answerer returned undefined: undefined, i.e. the user
 *    dismissed the pick (vscode's own semantics — NOT an empty selection);
 *  - multi-select, answerer returned one item: wrap it;
 *
 * An unscripted multi-pick (no answerer at all) is handled at the call site by
 * {@link defaultMultiPickAnswer}: the pre-picked items, else the first, so it
 * behaves like a user who accepted the defaults rather than exploding.
 */
function resolveQuickPickAnswer(answer: unknown, canPickMany: boolean): unknown {
  if (!canPickMany) {
    return answer;
  }
  if (Array.isArray(answer)) {
    return answer;
  }
  if (answer !== undefined) {
    return [answer];
  }
  return undefined;
}

/** The selection an unscripted multi-pick should resolve to. */
function defaultMultiPickAnswer(items: unknown): unknown[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const prePicked = items.filter((item) => (item as { picked?: boolean })?.picked === true);
  return prePicked.length > 0 ? prePicked : [items[0]];
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
    errorMessageCalls: [],
    informationMessageCalls: [],
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
    const canPickMany = (opts as { canPickMany?: boolean } | undefined)?.canPickMany === true;
    if (!options.quickPick) {
      return Promise.resolve(canPickMany ? defaultMultiPickAnswer(items) : undefined);
    }
    return Promise.resolve(resolveQuickPickAnswer(options.quickPick(items, opts), canPickMany));
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

  // Information + error toasts are recorded EVEN when silenced. The
  // recording is the primary diagnostic for "command did nothing" /
  // "test asserts a side-effect that didn't happen" failures: the
  // silenced toast may be the only signal that the handler emitted
  // anything at all. Tests asserting git-state can include the
  // recorded text in their failure messages, turning a silent
  // regression into a readable error.
  //
  // We always record; info toasts resolve `undefined` unless the test
  // supplies an `informationMessage` answerer (needed for offers carried on
  // info toasts, e.g. the tracked-branch delete cascade). The
  // `silenceInfoMessages` / `silenceErrorMessages` options are retained for
  // future expansion but currently no-ops — recording alone gives us
  // everything we need without polluting test output with toast text.
  void options.silenceInfoMessages;
  void options.silenceErrorMessages;
  (
    vscode.window as unknown as { showInformationMessage: InformationMessageFn }
  ).showInformationMessage = ((message: string, ...rest: unknown[]) => {
    stubs.informationMessageCalls.push({ message, items: rest });
    return Promise.resolve(
      options.informationMessage ? options.informationMessage(message, ...rest) : undefined
    );
  }) as unknown as InformationMessageFn;

  (vscode.window as unknown as { showErrorMessage: ErrorMessageFn }).showErrorMessage = ((
    message: string,
    ...rest: unknown[]
  ) => {
    stubs.errorMessageCalls.push({ message, items: rest });
    return Promise.resolve(undefined);
  }) as unknown as ErrorMessageFn;

  return stubs;
}

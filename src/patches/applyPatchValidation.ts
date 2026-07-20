/**
 * Pure Apply-Patch form validation. NO vscode import — the webview entry
 * bundles this so the dialog's inline gating and the host's defence-in-depth
 * check can't disagree about what a valid form is.
 */

/**
 * Validate an `IApplyPatchOptions.stripLevel` input.
 *
 * Rules: must be a finite non-negative integer, and reasonably small
 * (`≤ 20`) so a typo doesn't turn into `git apply -p999999` which strips the
 * whole path and silently no-ops. Returns `undefined` when valid, an error
 * message when invalid.
 */
export function validateStripLevel(stripLevel: number | undefined): string | undefined {
  if (stripLevel === undefined) {
    return undefined;
  }
  if (typeof stripLevel !== 'number' || !Number.isFinite(stripLevel)) {
    return 'stripLevel must be a finite number';
  }
  if (!Number.isInteger(stripLevel)) {
    return 'stripLevel must be an integer';
  }
  if (stripLevel < 0) {
    return 'stripLevel must be >= 0';
  }
  if (stripLevel > 20) {
    return 'stripLevel must be <= 20';
  }
  return undefined;
}

/**
 * Why Apply must stay disabled, or `undefined` when the form is applyable.
 * Rendered inline next to the button rather than surfacing as a post-hoc
 * toast once the user has already committed to the action.
 */
export function applyBlockedReason(form: {
  useClipboard: boolean;
  patchPath?: string;
  stripLevel?: number;
  useAm?: boolean;
  /**
   * Whether the loaded patch opens with a mailbox envelope. `undefined` while
   * the host has not read the patch yet — an unknown fact cannot block.
   */
  hasMailboxEnvelope?: boolean;
}): string | undefined {
  if (!form.useClipboard && !form.patchPath) {
    return 'Choose a patch file to apply.';
  }
  const stripError = validateStripLevel(form.stripLevel);
  if (stripError) {
    return `Strip level: ${stripError}`;
  }
  // `git am` reads its author/date/message from a mailbox envelope and exits
  // 128 with "Patch format detection failed." without one. The preview cannot
  // catch this: `git am` has no dry run, so check mode falls back to
  // `git apply`, which happily reports a plain diff as appliable.
  if (form.useAm === true && form.hasMailboxEnvelope === false) {
    return 'This patch has no mailbox envelope, so “Use git am” cannot apply it. Uncheck it, or choose a patch produced by git format-patch.';
  }
  return undefined;
}

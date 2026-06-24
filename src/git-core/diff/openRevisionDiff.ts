import * as vscode from 'vscode';
import { sanitizeGitError } from '../gitError';

/**
 * The two sides and title of a diff editor tab.
 *
 * Building the URIs stays at the call site because the left/right schemes and
 * ref semantics are genuinely site-specific (the `intellig-git:` content
 * provider for a git ref, `vscode.Uri.file` / `joinPath` for the working
 * tree, `shelf-diff:` for a shelved patch). What every site shares — the
 * `vscode.diff` invocation and the sanitised failure toast — is funnelled
 * here so a change to how diffs open (options, telemetry, scheme migration)
 * touches one place, and so the on-failure UX is identical everywhere.
 */
export interface IRevisionDiffSpec {
  leftUri: vscode.Uri;
  rightUri: vscode.Uri;
  title: string;
}

/**
 * Open a two-sided diff editor — the single seam through which every
 * imperative `vscode.diff` is invoked.
 *
 * Error handling has two modes so the seam fits both call-site styles
 * without changing their behaviour:
 *
 *  - Pass `failureMessage` and a `vscode.diff` failure is caught here and
 *    reported as `${failureMessage}: ${sanitizeGitError(message)}` (byte
 *    identical to the inline `sanitizeGitError` toasts and to
 *    `formatActionFailureToast` the swept sites previously used).
 *  - Omit `failureMessage` and failures re-throw, so callers that need a
 *    fallback (a virtual-document diff) or a tab-scoped error surface keep
 *    their own `try/catch`.
 *
 * @param spec left/right URIs + tab title.
 * @param failureMessage optional user-facing prefix; when given, failures are
 *   toasted here instead of thrown.
 */
export async function openRevisionDiff(
  spec: IRevisionDiffSpec,
  failureMessage?: string
): Promise<void> {
  try {
    await vscode.commands.executeCommand('vscode.diff', spec.leftUri, spec.rightUri, spec.title);
  } catch (error) {
    if (failureMessage === undefined) {
      throw error;
    }
    const raw = error instanceof Error ? error.message : 'Unknown error';
    void vscode.window.showErrorMessage(`${failureMessage}: ${sanitizeGitError(raw)}`);
  }
}

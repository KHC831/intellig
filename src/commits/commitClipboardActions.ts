/**
 * Copy-to-clipboard action for the commit context menu.
 */

import * as vscode from 'vscode';
import { formatActionFailureToast } from '../git-core/gitError';

/**
 * Copy the full SHA(s) to the system clipboard.
 *
 * N=1: one hash. N>=2: OLDEST-first, joined with a single space —
 * CopyRevisionNumberAction parity ("we want hashes from old to new,
 * e.g., to pass to native client in terminal"), so a paste lands in
 * `git cherry-pick` replay order. `commitHashes` arrives newest-first
 * (webview DOM order); the reverse here is the canonical direction
 * point, mirroring the cherry-pick replay-order reversal.
 */
export async function copyHash(commitHashes: string[]): Promise<void> {
  if (commitHashes.length === 0) {
    return;
  }

  try {
    const text =
      commitHashes.length === 1 ? commitHashes[0] : [...commitHashes].reverse().join(' ');
    await vscode.env.clipboard.writeText(text);
    const message =
      commitHashes.length === 1
        ? `Copied commit hash: ${commitHashes[0]}`
        : `Copied ${commitHashes.length} commit hashes to clipboard`;
    void vscode.window.showInformationMessage(message);
  } catch (error) {
    void vscode.window.showErrorMessage(formatActionFailureToast('Failed to copy hash', error));
  }
}

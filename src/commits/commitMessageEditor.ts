/**
 * Editor-hosted commit-message prompt shared by the squash and reword flows:
 * opens a tempfile in a Beside editor, resolves on save, and falls back to a
 * plain input box when the editor cannot open.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

/**
 * Open an editor for the squash commit
 * message and resolve when the user saves or closes it.
 *
 * Previously used `vscode.window.showInputBox`, which is a single-line
 * affordance that renders multi-line seeds with literal `\n`
 * characters — a real UX bug for any squash spanning a commit with a
 * body. Switches to an editor opened on a tempfile inside
 * `os.tmpdir()` so:
 *   - multi-line editing is natural (no `\n` literals).
 *   - language `'git-commit'` triggers VS Code's commit-message
 *     syntax highlighting (subject vs body).
 *   - the URI has a backing file path, so `Cmd/Ctrl-S` lands silently
 *     (no "Save As" dialog like an untitled doc would surface).
 *
 * Resolution contract:
 *   - Save → resolve with the saved text.
 *   - Close without save → resolve `undefined` (cancel).
 *   - Save with empty / whitespace-only content
 *     is treated as cancel: returning `undefined` rather than
 *     re-opening or toasting an error matches IntelliJ's "user
 *     changed their mind" semantics.
 *
 * After resolution the helper closes the editor and best-effort
 * deletes the tempfile so the user doesn't see stale artifacts.
 */
export async function promptForMessageInEditor(
  seedMessage: string,
  opts: { tmpInfix: string; opName: string; fallbackPrompt: string }
): Promise<string | undefined> {
  // Build the tempfile path. The `.git/COMMIT_EDITMSG`-style suffix
  // makes some VS Code installs apply git-commit highlighting
  // automatically.
  //
  // Append 8 random hex chars to the name so two
  // dialogs opened in the same millisecond on the same PID
  // (background flow + user re-trigger) don't collide on the
  // tempfile path.
  const tmpDir = os.tmpdir();
  const rand = crypto.randomBytes(4).toString('hex');
  const tmpPath = path.join(
    tmpDir,
    `intellig-${opts.tmpInfix}-${process.pid}-${Date.now()}-${rand}-COMMIT_EDITMSG`
  );

  // Pre-write the seed so the editor opens with content already on
  // disk — saves a `setText` step and keeps the file content in sync
  // with what the user sees on first frame.
  try {
    fs.writeFileSync(tmpPath, seedMessage, { encoding: 'utf8' });
  } catch {
    // Degraded fallback now surfaces a heads-up
    // toast so the user knows the multi-line editor was attempted.
    void vscode.window.showInformationMessage(
      'Multi-line message editor unavailable; using single-line fallback.'
    );
    return messageInputBoxFallback(seedMessage, opts.fallbackPrompt);
  }

  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(vscode.Uri.file(tmpPath));
  } catch {
    // Same fallback as above — VS Code refused to open the tempfile.
    try {
      fs.unlinkSync(tmpPath);
      // eslint-disable-next-line no-restricted-syntax -- best-effort cleanup of a temp file; a stale temp file is harmless and there is no recovery worth surfacing.
    } catch {
      // ignore
    }
    void vscode.window.showInformationMessage(
      'Multi-line message editor unavailable; using single-line fallback.'
    );
    return messageInputBoxFallback(seedMessage, opts.fallbackPrompt);
  }

  // Open beside the active column so the message
  // editor doesn't cover the log the user was looking at.
  await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside,
  });

  const expectedFsPath = document.uri.fsPath;

  const message = await new Promise<string | undefined>((resolve) => {
    let resolved = false;
    const disposables: vscode.Disposable[] = [];

    const finish = (value: string | undefined): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      for (const d of disposables) {
        d.dispose();
      }
      resolve(value);
    };

    disposables.push(
      vscode.workspace.onDidSaveTextDocument((saved) => {
        if (saved.uri.toString() === document.uri.toString()) {
          finish(saved.getText());
          return;
        }
        // Save-As silent abort. When the user
        // hits Save-As, VS Code fires `onDidSaveTextDocument` with
        // the NEW URI (not the original tempfile's URI). The matching
        // close event fires for the original — without this branch
        // we'd treat it as cancel and the user's edited message
        // disappears. Detect and surface a clarifying toast instead.
        if (saved.uri.fsPath !== expectedFsPath) {
          void vscode.window.showWarningMessage(
            `${opts.opName} cancelled — message was saved to ${saved.uri.fsPath} instead of being applied. Re-run ${opts.opName} if you want to use that text.`
          );
          finish(undefined);
        }
      })
    );
    disposables.push(
      vscode.workspace.onDidCloseTextDocument((closed) => {
        if (closed.uri.toString() === document.uri.toString()) {
          // close-without-save = cancel.
          finish(undefined);
        }
      })
    );
  });

  // Best-effort cleanup.: closing the active
  // editor is a footgun when focus has shifted — it would close
  // whatever the user moved on to. Use the tab API to target the
  // message tab specifically; falls through gracefully when the tab
  // is already gone (e.g. user closed it manually).
  try {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const messageTab = tabs.find(
      (t) =>
        t.input instanceof vscode.TabInputText && t.input.uri.toString() === document.uri.toString()
    );
    if (messageTab) {
      await vscode.window.tabGroups.close(messageTab);
    }
    // eslint-disable-next-line no-restricted-syntax -- closing an already-closed tab throws; that is the expected outcome here, nothing to recover.
  } catch {
    // Tab already gone — fine.
  }
  try {
    fs.unlinkSync(tmpPath);
    // eslint-disable-next-line no-restricted-syntax -- best-effort cleanup of a temp file; a stale temp file is harmless and there is no recovery worth surfacing.
  } catch {
    // ignore
  }

  if (message === undefined) {
    return undefined;
  }
  if (message.trim().length === 0) {
    // Empty save = cancel. User changed their mind
    // mid-edit; treat that as a cancel rather than an error toast.
    return undefined;
  }
  return message;
}

/**
 * single-line `showInputBox` fallback for
 * `_promptForMessageInEditor`. Extracted so the two failure sites
 * (tempfile write fail, openTextDocument fail) share one implementation.
 * The caller is expected to surface the heads-up info toast before
 * delegating here. Note this fallback is inherently single-line — a
 * multi-line body cannot be entered here; it is only reached when the
 * tempfile editor itself is unavailable.
 */
async function messageInputBoxFallback(
  seedMessage: string,
  prompt: string
): Promise<string | undefined> {
  const fallback = await vscode.window.showInputBox({
    value: seedMessage,
    prompt,
    ignoreFocusOut: true,
    valueSelection: [0, 0],
  });
  if (fallback === undefined || fallback.trim().length === 0) {
    return undefined;
  }
  return fallback;
}

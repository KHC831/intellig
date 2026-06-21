/**
 * Dialog-framework conventions audit (spec 5.1).
 *
 * Every IntelliG webview dialog that extends `BaseWebviewPanel` and carries
 * its own inline `<script>` MUST honor the shared dialog contract:
 *
 *   1. A CSP `<meta http-equiv="Content-Security-Policy">` tag whose
 *      `script-src` is gated by a `'nonce-...'` (no `'unsafe-inline'` on
 *      scripts).
 *   2. Exactly one inline `<script nonce="${nonce}">` tag, so the page's
 *      one script block is the nonced one the CSP authorizes.
 *   3. A keyboard contract: Cmd+Enter / Ctrl+Enter triggers the primary
 *      action and Esc triggers cancel. This is the IntelliJ-parity muscle
 *      memory users rely on — a dialog that only responds to mouse clicks
 *      is the regression this audit forbids.
 *
 * Why a STATIC source audit (not a behavioral one): the seven dialogs have
 * divergent constructor dependency graphs (GitService stubs, op-context,
 * patch IO, conflict file lists). Standing all seven up in a single test to
 * diff their rendered HTML is brittle and high-maintenance. The conventions
 * being pinned are textual properties of each dialog's render path, so a
 * source sweep is both sufficient and stable. The behavioral coverage for
 * each dialog's submit/cancel wiring lives in its own dedicated suite
 * (resetDialog.test.ts, pushDialog.test.ts, mergeDialog.test.ts, ...); this
 * audit guards against a refactor silently dropping the shared contract from
 * any one of them.
 *
 * ResolveConflictsDialog is a DELIBERATE exception to the keyboard contract.
 * Its only non-primary action is `abort`, which aborts an in-flight
 * rebase/merge/cherry-pick — a destructive operation. Binding Esc to abort
 * would turn an accidental keypress into lost work, so that dialog relies on
 * the native panel-close affordance instead. It is still held to the
 * CSP + single-nonce rules (1 and 2).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function repoRoot(): string {
  // test/unit/audit/dialogFrameworkConventions.audit.test.ts -> repo root.
  return path.resolve(__dirname, '../../..');
}

interface DialogUnderAudit {
  /** Human-readable dialog name (for assertion messages). */
  name: string;
  /** Repo-relative POSIX source path. */
  file: string;
  /**
   * Whether the dialog is held to the keyboard contract. False only for
   * ResolveConflictsDialog (destructive-abort exception, see file header).
   */
  keyboardContract: boolean;
}

const DIALOGS: DialogUnderAudit[] = [
  {
    name: 'SquashMessageDialog',
    file: 'src/commits/SquashMessageDialog.ts',
    keyboardContract: true,
  },
  { name: 'ApplyPatchDialog', file: 'src/patches/ApplyPatchDialog.ts', keyboardContract: true },
  { name: 'MergeDialog', file: 'src/conflicts/MergeDialog.ts', keyboardContract: true },
  { name: 'ResetDialog', file: 'src/ui-shell/ResetDialog.ts', keyboardContract: true },
  { name: 'NewBranchDialog', file: 'src/branches/NewBranchDialog.ts', keyboardContract: true },
  { name: 'PushDialog', file: 'src/sync/PushDialog.ts', keyboardContract: true },
  {
    name: 'ResolveConflictsDialog',
    file: 'src/conflicts/ResolveConflictsDialog.ts',
    keyboardContract: false,
  },
];

function read(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot(), relPath), 'utf-8');
}

describe('Dialog-framework conventions audit (spec 5.1)', () => {
  for (const dialog of DIALOGS) {
    describe(dialog.name, () => {
      let source: string;

      before(() => {
        source = read(dialog.file);
      });

      it('emits a CSP meta tag with a nonce-gated script-src', () => {
        // The dialog either inlines the CSP meta tag (dialogs that override
        // _render) or delegates to BaseWebviewPanel._buildCsp(nonce) (which
        // builds `script-src 'nonce-...'`). Accept either spelling: a
        // literal meta tag, or a _buildCsp(nonce) call that routes through
        // the shared builder.
        const hasInlineCspMeta = /http-equiv="Content-Security-Policy"/.test(source);
        const usesSharedCspBuilder = /_buildCsp\(\s*nonce\s*\)/.test(source);
        assert.ok(
          hasInlineCspMeta || usesSharedCspBuilder,
          `${dialog.name} must emit a CSP meta tag (inline or via _buildCsp(nonce)). See spec 5.1.`
        );
      });

      it('gates its inline script with a nonce (script-src nonce, not unsafe-inline)', () => {
        // Every dialog with an interactive script renders exactly one
        // `<script nonce="${nonce}">`. The literal `nonce="${nonce}"`
        // substring is the load-bearing token: it proves the script tag is
        // wired to the CSP nonce rather than left un-nonced (which CSP would
        // block) or opened up with 'unsafe-inline' (which the contract
        // forbids).
        const noncedScriptCount = (source.match(/<script nonce="\$\{nonce\}">/g) ?? []).length;
        assert.strictEqual(
          noncedScriptCount,
          1,
          `${dialog.name} must render exactly one nonced inline <script> tag; ` +
            `found ${noncedScriptCount}. See spec 5.1.`
        );
        assert.ok(
          !/script-src[^;]*'unsafe-inline'/.test(source),
          `${dialog.name} must NOT allow 'unsafe-inline' in script-src. See spec 5.1.`
        );
      });

      if (dialog.keyboardContract) {
        it('binds Cmd+Enter / Ctrl+Enter to the primary action', () => {
          // The canonical guard expression in every dialog's keydown
          // handler. metaKey covers macOS Cmd, ctrlKey covers Win/Linux.
          assert.ok(
            /e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)/.test(source),
            `${dialog.name} must bind Cmd+Enter / Ctrl+Enter to its primary action. See spec 5.1.`
          );
        });

        it('binds Esc to cancel', () => {
          assert.ok(
            /e\.key === 'Escape'/.test(source),
            `${dialog.name} must bind Esc to cancel. See spec 5.1.`
          );
        });
      } else {
        it('is the documented destructive-abort exception to the keyboard contract', () => {
          // ResolveConflictsDialog intentionally does NOT bind Esc, because
          // its non-primary action (abort) is destructive. Pin that it has
          // an abort action so the exception stays meaningful: if abort ever
          // becomes non-destructive, revisit whether the contract should
          // apply.
          assert.ok(
            /data-action="abort"/.test(source),
            `${dialog.name} is the keyboard-contract exception because its only ` +
              `non-primary action is the destructive 'abort'. See spec 5.1 + this file's header.`
          );
        });
      }
    });
  }
});

/**
 * Dialog-framework conventions audit (spec 5.1).
 *
 * Every IntelliG webview dialog that extends `BaseWebviewPanel` MUST honor the
 * shared dialog contract, whether its script is an inline block or (Phase 5) a
 * bundled TS entry loaded via an external `<script nonce src>` tag:
 *
 *   1. A CSP `<meta http-equiv="Content-Security-Policy">` tag whose
 *      `script-src` is gated by a `'nonce-...'` (no `'unsafe-inline'` on
 *      scripts).
 *   2. Exactly one `<script nonce="${nonce}">` tag — the inline block, or the
 *      external bundle tag `<script nonce="${nonce}" src="...">` — so the page's
 *      one script is the nonced one the CSP authorizes.
 *   3. A keyboard contract: Cmd+Enter / Ctrl+Enter triggers the primary
 *      action and Esc triggers cancel. This is the IntelliJ-parity muscle
 *      memory users rely on — a dialog that only responds to mouse clicks
 *      is the regression this audit forbids. For a ported dialog this lives in
 *      its bundled entry (`entryFile`), not the host string.
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
  /** Repo-relative POSIX source path (the host panel). */
  file: string;
  /**
   * Repo-relative path to the bundled TS webview entry, for dialogs ported to
   * an external bundle (Phase 5). When set, the keyboard contract is checked
   * against the entry (the script no longer lives in the host string); when
   * absent, the host still carries the inline script.
   */
  entryFile?: string;
  /**
   * Whether the dialog is held to the keyboard contract. False only for
   * ResolveConflictsDialog (destructive-abort exception, see file header).
   */
  keyboardContract: boolean;
}

const DIALOGS: DialogUnderAudit[] = [
  {
    // SquashMessageDialog + the reword edit dialog are presets of this base,
    // which carries the shared keyboard contract in its bundled entry.
    name: 'CommitMessageDialog',
    file: 'src/commits/CommitMessageDialog.ts',
    entryFile: 'src/commits/webview/commitMessageDialog.ts',
    keyboardContract: true,
  },
  {
    name: 'ApplyPatchDialog',
    file: 'src/patches/ApplyPatchDialog.ts',
    entryFile: 'src/patches/webview/applyPatchDialog.ts',
    keyboardContract: true,
  },
  {
    name: 'MergeDialog',
    file: 'src/conflicts/MergeDialog.ts',
    entryFile: 'src/conflicts/webview/main.ts',
    keyboardContract: true,
  },
  {
    name: 'ResetDialog',
    file: 'src/ui-shell/ResetDialog.ts',
    entryFile: 'src/ui-shell/webview/resetDialog.ts',
    keyboardContract: true,
  },
  {
    name: 'NewBranchDialog',
    file: 'src/branches/NewBranchDialog.ts',
    entryFile: 'src/branches/webview/main.ts',
    keyboardContract: true,
  },
  { name: 'PushDialog', file: 'src/sync/PushDialog.ts', keyboardContract: true },
  {
    name: 'ResolveConflictsDialog',
    file: 'src/conflicts/ResolveConflictsDialog.ts',
    entryFile: 'src/conflicts/webview/resolveConflictsDialog.ts',
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

      it('gates its script with a nonce (script-src nonce, not unsafe-inline)', () => {
        // Every dialog renders exactly one `<script nonce="${nonce}">` — either
        // the inline block (dialogs still carrying their script) or the external
        // bundle tag `<script nonce="${nonce}" src="...">` (Phase-5 ports). The
        // `nonce="${nonce}"` token is load-bearing: it proves the script tag is
        // wired to the CSP nonce, not left un-nonced (CSP would block it) or
        // opened up with 'unsafe-inline' (the contract forbids it).
        const noncedScriptCount = (
          source.match(/<script nonce="\$\{nonce\}"(?:\s+src="[^"]*")?>/g) ?? []
        ).length;
        assert.strictEqual(
          noncedScriptCount,
          1,
          `${dialog.name} must render exactly one nonced <script> tag (inline or external bundle); ` +
            `found ${noncedScriptCount}. See spec 5.1.`
        );
        assert.ok(
          !/script-src[^;]*'unsafe-inline'/.test(source),
          `${dialog.name} must NOT allow 'unsafe-inline' in script-src. See spec 5.1.`
        );
      });

      // The interactive script lives in the host string for inline dialogs, or
      // the bundled entry for Phase-5 ports. The keyboard/abort contracts are
      // asserted against whichever holds it.
      const scriptOf = (): string => (dialog.entryFile ? read(dialog.entryFile) : source);

      if (dialog.keyboardContract) {
        it('binds Cmd+Enter / Ctrl+Enter to the primary action', () => {
          // The canonical guard expression in every dialog's keydown
          // handler. metaKey covers macOS Cmd, ctrlKey covers Win/Linux.
          assert.ok(
            /e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)/.test(scriptOf()),
            `${dialog.name} must bind Cmd+Enter / Ctrl+Enter to its primary action. See spec 5.1.`
          );
        });

        it('binds Esc to cancel', () => {
          assert.ok(
            /e\.key === 'Escape'/.test(scriptOf()),
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
          // Accept either spelling of the abort action: the legacy
          // `data-action="abort"` markup attribute, or the createElement form
          // `setAttribute('data-action', 'abort')` used after the string→DOM
          // migration.
          const scriptText = scriptOf();
          const hasAbortAction =
            /data-action="abort"/.test(scriptText) ||
            /setAttribute\(\s*['"]data-action['"]\s*,\s*['"]abort['"]\s*\)/.test(scriptText);
          assert.ok(
            hasAbortAction,
            `${dialog.name} is the keyboard-contract exception because its only ` +
              `non-primary action is the destructive 'abort'. See spec 5.1 + this file's header.`
          );
        });
      }
    });
  }
});

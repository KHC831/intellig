/**
 * Command-handler transparency audit (spec 8 L3 + L13).
 *
 * L3: every IntelliG command handler must do at least one of three things
 * the user can observe — emit a toast, refresh a panel, or log to the
 * IntelliG OutputChannel via logger.info. A handler that does none is a
 * silent no-op ("I clicked X and nothing happened"), the most-filed bug
 * class in this codebase (T54 silent dropdown, T52 silent rebase-skip).
 *
 * SCOPE OF THIS AUDIT — read before extending. The spec names a BEHAVIORAL
 * spy harness as the PRIMARY L3 guard: it drives each handler (including
 * early-return guard paths) with mocked dependencies and asserts a
 * toast/refresh/info actually fired. That harness is a large, separate
 * effort across 40+ handlers with divergent dependency graphs and is NOT
 * what this file is. This file is the STATIC companion the plan calls "6a
 * audit infrastructure": it extracts each `registerLoggedCommand` handler
 * body from extension.ts and asserts the body contains at least one
 * transparency signal OR delegates to a named helper that owns the
 * feedback. It catches the gross regression — a handler wired up with an
 * empty or feedback-free body — and pins every handler to an explicit
 * classification so a NEW silent handler can't land unnoticed. It does NOT
 * prove the early-return paths are covered; that's the behavioral harness's
 * job (tracked as Phase 6 follow-up).
 *
 * L13: registerLoggedCommand itself wraps every handler body in a
 * correlation frame (see src/utils/logger/correlation.ts) so every log
 * record emitted during the handler carries the commandId + correlationId.
 * The per-handler `getLogger().child({component, action})` binding is
 * verified structurally here (handlers that log do so through a bound
 * child) and behaviorally in the dedicated logger suites.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function repoRoot(): string {
  return path.resolve(__dirname, '..', '..', '..', '..');
}

// Command handlers used to live exclusively in `src/extension.ts`. The
// Phase 2.2 split relocated cohesive handler groups into domain modules under
// `src/commands/registration/` while extension.ts stays the orchestrator that
// builds the shared context + registers each module. The audit therefore
// scans the UNION of extension.ts and every registration module so a handler
// is seen no matter which file owns it (the same single-file-assumption fix
// the GitService watcher-families TARGET_FILE needed). Each file is extracted
// independently and the per-file handler arrays are unioned (guards against
// brace-matching across a file boundary).
const EXT_FILE = 'src/extension.ts';
const REGISTRATION_DIR = 'src/commands/registration';

/**
 * Resolve the full set of source files that may contain
 * `registerLoggedCommand(...)` handlers: extension.ts plus every `*.ts` under
 * the registration module directory.
 */
function handlerSourceFiles(): string[] {
  const files = [path.join(repoRoot(), EXT_FILE)];
  const regDir = path.join(repoRoot(), REGISTRATION_DIR);
  if (fs.existsSync(regDir)) {
    for (const entry of fs.readdirSync(regDir)) {
      if (entry.endsWith('.ts')) {
        files.push(path.join(regDir, entry));
      }
    }
  }
  return files;
}

/**
 * A transparency signal is any substring whose presence in a handler body
 * proves the handler produces an observable effect. Grouped by L3 category.
 */
const TRANSPARENCY_SIGNALS: RegExp[] = [
  // 1. Toast — the three user-visible message channels.
  /showInformationMessage/,
  /showWarningMessage/,
  /showErrorMessage/,
  /showQuickPick/,
  /showInputBox/,
  /showOpenDialog/,
  /showSaveDialog/,
  // 2. Refresh / state change — the user sees new state.
  /\.fire\(/,
  /\.refresh\(/,
  /_updateWebview/,
  /executeCommand\(/,
  /\.reveal\(/,
  // 3. Logging — bound logger info/warn/error (debug does NOT count: it's
  //    silenced in default user output, so a debug-only handler is still a
  //    silent no-op from the user's perspective — see spec L3).
  /logger\.(info|warn|error)\(/,
  /\.child\(\s*\{/,
];

/**
 * Handlers whose body delegates to a named helper / dialog / command class
 * that OWNS the user feedback. Each entry cites the delegation target so a
 * reviewer can confirm the feedback lives there. The audit treats these as
 * transparent: the body itself may not contain a signal, but the named
 * callee does (and is covered by that callee's own tests).
 *
 * This is the L3 allowlist the spec calls for. Adding an id here is a
 * deliberate statement: "this handler is a thin delegator; feedback is in
 * <target>." A handler that is genuinely silent must NOT be added.
 */
const DELEGATOR_ALLOWLIST: Record<string, string> = {
  // openGitToolWindow uses executeCommand(focus) — already a signal, listed
  // for completeness if the focus call is ever refactored out.
  'intellig.openGitToolWindow': 'executeCommand(view.focus) reveals the panel',
  // Dialog-opening delegators: the dialog renders (observable) + owns its
  // own success/error toasts.
  'intellig.push': '_openPushDialog() opens PushDialog which renders + toasts',
  'intellig.pull': 'pull flow opens a dialog / progress + toasts on result',
  'intellig.tag.new': '_runNewTagFlow() prompts via showInputBox + toasts',
  // Conflict-navigation delegators: mergeView.nextConflict/previousConflict
  // move the editor selection (observable) and are covered by MergeView
  // tests. The handler body is a guarded one-line delegation.
  'intellig.merge.nextConflict': 'mergeView.nextConflict() moves editor selection',
  'intellig.merge.previousConflict': 'mergeView.previousConflict() moves editor selection',
  // Merge accept-* delegators: each is a guarded one-line
  // `mergeView.acceptX()` call. MergeView re-renders the diff (observable)
  // and is covered by MergeView.test.ts / mergeView.nonConflicting.test.ts.
  'intellig.merge.acceptCurrent': 'mergeView.acceptCurrent() re-renders the merge editor',
  'intellig.merge.acceptIncoming': 'mergeView.acceptIncoming() re-renders the merge editor',
  'intellig.merge.acceptBoth': 'mergeView.acceptBoth() re-renders the merge editor',
  'intellig.merge.acceptAllCurrent': 'mergeView.acceptAllCurrent() re-renders the merge editor',
  'intellig.merge.acceptAllIncoming': 'mergeView.acceptAllIncoming() re-renders the merge editor',
  'intellig.merge.markResolved': 'mergeView.markResolved() updates state + closes the editor',
  // Stash delegators: _pickStashForAction shows a QuickPick (observable),
  // then delegates to the stash view which toasts on result.
  'intellig.stash.rename': '_pickStashForAction QuickPick → view.renameStash() toasts',
  'intellig.stash.branchFromStash': '_pickStashForAction QuickPick → view.branchFromStash() toasts',
  // Shelf delegator: _getShelfContext + ctx.view.importPatches() shows a
  // file picker + toasts on result (ShelfView-owned feedback).
  'intellig.shelve.importPatches': '_getShelfContext → view.importPatches() picker + toasts',
  // Commit-context delegators: each routes to a named flow/dialog helper
  // that prompts (showInputBox / dialog) and toasts on result.
  'intellig.commit.newTag': '_runNewTagFlow() prompts via showInputBox + toasts',
  'intellig.commit.newBranch': '_openNewBranchDialog() opens NewBranchDialog (renders + toasts)',
  'intellig.commit.cherryPickWithoutCommit': '_runCherryPickVariant() toasts on result',
  'intellig.commit.applyFilesToBranch': '_runApplyFilesToBranchFlow() prompts + toasts',
};

interface ExtractedHandler {
  id: string;
  body: string;
}

/**
 * Extract every `registerLoggedCommand('<id>', <fn>)` handler body from the
 * source by brace-matching from the arrow/function opening `{` to its
 * matching close. Returns id + body text for each.
 */
function extractHandlers(source: string): ExtractedHandler[] {
  const out: ExtractedHandler[] = [];
  const callRe = /registerLoggedCommand\(\s*['"]([^'"]+)['"]\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    const id = m[1];
    // Find the first `{` after the comma that opens the handler body. The
    // handler is an arrow `(...) => {` or `function (...) {`; in both cases
    // the body's opening brace is the first unmatched `{` after the match
    // end (parameter lists here never contain a `{`).
    const open = source.indexOf('{', callRe.lastIndex);
    if (open === -1) {
      continue;
    }
    // Brace-match to find the body close.
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          break;
        }
      }
    }
    out.push({ id, body: source.slice(open, i + 1) });
  }
  return out;
}

describe('Command-handler transparency audit (spec 8 L3 + L13)', () => {
  let handlers: ExtractedHandler[];

  before(() => {
    // Extract per-file, then union — never brace-match across a file
    // boundary. extension.ts + every registration module are scanned so a
    // handler is found wherever it lives post-split.
    handlers = [];
    for (const file of handlerSourceFiles()) {
      const source = fs.readFileSync(file, 'utf-8');
      handlers.push(...extractHandlers(source));
    }
  });

  it('extracts a meaningful number of command handlers (scan reaches the file)', () => {
    // Negative-control: if the extractor finds ~0 handlers, every per-handler
    // assertion below would vacuously pass. extension.ts registers dozens.
    assert.ok(
      handlers.length >= 30,
      `expected >= 30 registerLoggedCommand handlers across ${EXT_FILE} + ${REGISTRATION_DIR}/*.ts; ` +
        `found ${handlers.length}. The extractor may have broken, or the files moved.`
    );
  });

  it('every handler emits a transparency signal OR is an allowlisted delegator (L3)', () => {
    const silent: string[] = [];
    for (const h of handlers) {
      const hasSignal = TRANSPARENCY_SIGNALS.some((re) => re.test(h.body));
      const allowlisted = Object.prototype.hasOwnProperty.call(DELEGATOR_ALLOWLIST, h.id);
      if (!hasSignal && !allowlisted) {
        silent.push(`  ${h.id}`);
      }
    }
    assert.strictEqual(
      silent.length,
      0,
      [
        `Found ${silent.length} command handler(s) with no transparency signal and no`,
        `delegator-allowlist entry — each is a potential silent no-op (spec L3):`,
        ...silent,
        ``,
        `Fix one of:`,
        `  - Add a toast / refresh / logger.info to the handler so the user can tell it ran.`,
        `  - If the handler is a thin delegator, add it to DELEGATOR_ALLOWLIST with the`,
        `    callee that owns the feedback.`,
      ].join('\n')
    );
  });

  it('every allowlisted delegator id still exists as a registered command (no stale entries)', () => {
    const ids = new Set(handlers.map((h) => h.id));
    const stale = Object.keys(DELEGATOR_ALLOWLIST).filter((id) => !ids.has(id));
    assert.strictEqual(
      stale.length,
      0,
      `DELEGATOR_ALLOWLIST has stale entries (command no longer registered): ${stale.join(', ')}. ` +
        'Remove them so the allowlist stays honest.'
    );
  });
});

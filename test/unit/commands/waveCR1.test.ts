/**
 * Review-round fixes for the squash/drop context-menu commands.
 *
 * Covers:
 *   1. Squash dialog uses untitled-style editor + save listener instead
 *      of `showInputBox` (multi-line editor, no `\n` literal rendering).
 *   2. `_handleDropCommit` (single path) runs hash-validation +
 *      initial-commit guard like multi.
 *   3. Squash second-pause false-success edge routes to "partial
 *      complete" warning, not success toast (covered in waveC.test.ts;
 *      structural pin here).
 *   4. Empty rebase-window guard surfaces stale-selection toast and
 *      refuses (covered in waveC.test.ts; structural pin here).
 *   5. Drop confirm modal includes commit subjects, not bare short-shas
 *      (covered in waveC.test.ts; structural pin here).
 *   6. The rebase-editing flows ride the shared _runHistoryRewrite runner
 *      with no manual stash bracket (git owns --autostash).
 *   7. Empty save = cancel (covered in waveC.test.ts; structural pin
 *      here).
 *   8. STALE_SELECTION_TOAST const replaces 4 inline duplicates
 *      (structural pin in waveC.test.ts).
 */

import '../../setup';
import { moduleFunctionBody } from '../../typed/historyRewriteSources';
import * as assert from 'assert';

describe('Wave C R1 — review fixes', () => {
  let src: string;
  let clsSrc: string;

  before(async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { readHistoryRewriteFamily } = await import('../../typed/historyRewriteSources');
    src = readHistoryRewriteFamily();
    clsSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/commits/CommitContextMenuCommands.ts'),
      'utf8'
    );
  });

  // ─── squash dialog uses untitled-editor + save listener ──────────────────
  describe('squash dialog editor flow', () => {
    it('CommitContextMenuCommands no longer calls showInputBox in the squash handler', () => {
      const squashBody = moduleFunctionBody(
        'commitSquashActions.ts',
        'export async function handleSquashCommits'
      );
      // The handler delegates to _promptForMessageInEditor; that helper
      // is allowed to fall back to showInputBox when the tempfile path
      // fails, but the primary path must NOT be a direct showInputBox
      // call in the squash handler body.
      assert.ok(
        !/await\s+vscode\.window\.showInputBox\s*\(/.test(squashBody),
        '_handleSquashCommits must delegate to the editor helper, not call showInputBox directly'
      );
    });

    it('exposes a private _promptForMessageInEditor helper', () => {
      assert.ok(
        /export\s+async\s+function\s+promptForMessageInEditor\s*\(/.test(src),
        'expected the squash editor helper to live in a single named method'
      );
    });

    it('the editor helper opens openTextDocument and registers save+close listeners', () => {
      const helperBody = moduleFunctionBody(
        'commitMessageEditor.ts',
        'export async function promptForMessageInEditor'
      );
      assert.ok(
        /vscode\.workspace\.openTextDocument\s*\(/.test(helperBody),
        'editor helper must call openTextDocument'
      );
      assert.ok(
        /vscode\.workspace\.onDidSaveTextDocument\s*\(/.test(helperBody),
        'editor helper must register an onDidSaveTextDocument listener'
      );
      assert.ok(
        /vscode\.workspace\.onDidCloseTextDocument\s*\(/.test(helperBody),
        'editor helper must register an onDidCloseTextDocument listener'
      );
    });

    it('the editor helper opens an editor via showTextDocument', () => {
      const helperBody = moduleFunctionBody(
        'commitMessageEditor.ts',
        'export async function promptForMessageInEditor'
      );
      assert.ok(
        /vscode\.window\.showTextDocument\s*\(/.test(helperBody),
        'editor helper must call showTextDocument so the user sees the document'
      );
    });

    it('the editor helper closes the editor + cleans up the tempfile after resolution', () => {
      const helperBody = moduleFunctionBody(
        'commitMessageEditor.ts',
        'export async function promptForMessageInEditor'
      );
      // Editor close uses the tab API, not
      // workbench.action.closeActiveEditor (which would close the
      // currently active editor, not necessarily the squash one).
      assert.ok(
        /vscode\.window\.tabGroups/.test(helperBody) && /tabGroups\.close/.test(helperBody),
        'editor helper must close the squash tab via the tab API (vscode.window.tabGroups.close)'
      );
      assert.ok(
        !/workbench\.action\.closeActiveEditor/.test(helperBody),
        'pre-R2 closeActiveEditor call must be replaced with tab-targeted close'
      );
      assert.ok(
        /fs\.unlinkSync\s*\(/.test(helperBody),
        'editor helper must clean up the tempfile after resolution'
      );
    });
  });

  // ─── single-drop guards ──────────────────────────────────────────────────
  describe('_handleDropCommit runs allHashesValid + initial-commit guard', () => {
    it('_handleDropCommit checks allHashesValid before routing', () => {
      const dropBody = moduleFunctionBody(
        'commitDropActions.ts',
        'export async function handleDropCommit('
      );
      assert.ok(
        /allHashesValid\s*\(\s*commitHashes\s*\)/.test(dropBody),
        '_handleDropCommit must call allHashesValid(commitHashes) before routing'
      );
    });

    it('_handleDropCommit resolves the rebase base through _resolveRewriteBase (initial-commit arm)', () => {
      const dropBody = moduleFunctionBody(
        'commitDropActions.ts',
        'export async function handleDropCommit('
      );
      assert.ok(
        /resolveRewriteBase\s*\(/.test(dropBody),
        '_handleDropCommit must resolve its base via _resolveRewriteBase (warn-then---root for the initial commit)'
      );
    });
  });

  // ─── squash status: 'paused' guard ───────────────────────────────────────
  // The outcome switch lives in the shared runner (_runHistoryRewrite); the
  // squash body must ride it and the runner must keep the pins.
  describe('squash second-pause false-success edge', () => {
    it('_handleSquashCommits rides the shared history-rewrite runner', () => {
      const squashBody = moduleFunctionBody(
        'commitSquashActions.ts',
        'export async function handleSquashCommits'
      );
      assert.ok(
        /runHistoryRewrite\s*\(/.test(squashBody),
        '_handleSquashCommits must delegate execute + outcome handling to _runHistoryRewrite'
      );
    });

    it("the runner's success branch pins to status === 'completed'", () => {
      const runnerBody = moduleFunctionBody(
        'commitHistoryRewriteRunner.ts',
        'export async function runHistoryRewrite'
      );
      assert.ok(
        /result\.status\s*===\s*['"]completed['"]/.test(runnerBody),
        "the runner's success branch must require status === 'completed'"
      );
    });

    it("the runner surfaces a partial-complete warning when status === 'paused'", () => {
      const runnerBody = moduleFunctionBody(
        'commitHistoryRewriteRunner.ts',
        'export async function runHistoryRewrite'
      );
      assert.ok(
        /partially complete|partial complete/i.test(runnerBody),
        'the runner must surface a partial-complete warning'
      );
    });
  });

  // ─── drop empty-rebase-window guard ──────────────────────────────────────
  describe('drop multi guards against empty / partial rebase windows', () => {
    it('_handleDropCommitMulti aborts when the plan covers fewer commits than selected', () => {
      const body = moduleFunctionBody(
        'commitDropActions.ts',
        'export async function handleDropCommitMulti'
      );
      // The guard compares the count of `drop` actions in the plan to
      // the user's selected count.
      assert.ok(
        /planDropCount|planSelectedCount/.test(body),
        '_handleDropCommitMulti must compute a plan-coverage count and guard against partial coverage'
      );
      assert.ok(
        /STALE_SELECTION_TOAST/.test(body),
        'partial-coverage abort must use STALE_SELECTION_TOAST'
      );
    });
  });

  // ─── drop modal includes subjects ────────────────────────────────────────
  describe('drop confirm modal includes commit subjects', () => {
    it('_handleDropCommitMulti fetches a subject for each preview row', () => {
      const body = moduleFunctionBody(
        'commitDropActions.ts',
        'export async function handleDropCommitMulti'
      );
      assert.ok(
        /previewCommitSubject\s*\(/.test(body),
        '_handleDropCommitMulti must fetch subjects via previewCommitSubject so the modal can disambiguate commits'
      );
      // The shared preview helper is the single place that calls getCommit.
      const helperBody = moduleFunctionBody(
        'commitContextMenuShared.ts',
        'export async function previewCommitSubject'
      );
      assert.ok(
        /ctx\.gitService\.getCommit\s*\(\s*repo\s*,/.test(helperBody),
        'previewCommitSubject must fetch the subject via getCommit'
      );
    });
  });

  // ─── no manual stash bracket in the rebase-editing flows ─────────────────
  describe('drop multi carries no manual stash bracket', () => {
    it('_handleDropCommitMulti rides the shared runner with no stash machinery', () => {
      const body = moduleFunctionBody(
        'commitDropActions.ts',
        'export async function handleDropCommitMulti'
      );
      assert.ok(
        /runHistoryRewrite\s*\(/.test(body),
        '_handleDropCommitMulti must delegate execute + outcome handling to _runHistoryRewrite'
      );
      // git owns save/restore via `rebase --autostash`; a manual bracket
      // here would pop onto a mid-rebase tree when the rebase pauses.
      assert.ok(
        !/_stashIfDirty|_unstash/.test(body),
        '_handleDropCommitMulti must not run a manual stash bracket'
      );
    });
  });

  // ─── STALE_SELECTION_TOAST const ──────────────────────────────────────────
  describe('STALE_SELECTION_TOAST is a single const', () => {
    it('the const is declared once at module scope', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const shared = fs.readFileSync(
        path.join(process.cwd(), 'src/commits/commitContextMenuShared.ts'),
        'utf8'
      );
      assert.ok(
        /^export const\s+STALE_SELECTION_TOAST\s*=\s*['"]Commit selection changed/m.test(shared),
        'STALE_SELECTION_TOAST must be a top-level const declaration'
      );
    });

    it('every multi-commit handler that emits the toast references the const', () => {
      // The multi-commit handlers route the stale toast through the shared
      // in-order guard (allHashesDisplayed) or reference the const directly
      // (the partial-coverage guard). Count both forms.
      const refs = src.match(/STALE_SELECTION_TOAST\b|allHashesDisplayed\s*\(/g) || [];
      // import + guard calls in dropCommitMulti and squashCommits + the
      // partial-coverage toast.
      assert.ok(
        refs.length >= 4,
        `expected ≥4 stale-toast routing references (import + handlers); got ${refs.length}`
      );
    });

    it('there are no inline duplicates of the toast literal', async () => {
      const fs = await import('fs');
      const path = await import('path');
      // Single source: the literal appears exactly once (the const decl in the
      // shared module); every action module references the symbol.
      const { HISTORY_REWRITE_MODULES } = await import('../../typed/historyRewriteSources');
      const files = [
        ...HISTORY_REWRITE_MODULES,
        'src/commits/commitContextMenuShared.ts',
        'src/commits/commitPatchActions.ts',
        'src/commits/commitCompareActions.ts',
      ];
      const literalCount = files.reduce((acc, rel) => {
        const body = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
        return (
          acc +
          (body.match(/['"]Commit selection changed since the menu opened — please retry\.['"]/g)
            ?.length ?? 0)
        );
      }, 0);
      assert.strictEqual(
        literalCount,
        1,
        `expected exactly 1 literal occurrence of the toast across the commit-menu modules; got ${literalCount}`
      );
    });
  });

  // ─── central hash validation at the dispatch boundary ────────────────────
  describe('dispatch validates commit hashes for every hash-consuming action', () => {
    it('_dispatchAction guards with allHashesValid(commitHashes)', () => {
      const dispatchIdx = clsSrc.indexOf('private async _dispatchAction(');
      assert.ok(dispatchIdx > 0, 'expected _dispatchAction definition');
      const switchIdx = clsSrc.indexOf('switch (action)', dispatchIdx);
      const head = clsSrc.substring(dispatchIdx, switchIdx > 0 ? switchIdx : dispatchIdx + 1200);
      assert.ok(
        /allHashesValid\s*\(\s*commitHashes\s*\)/.test(head),
        '_dispatchAction must reject a non-hex hash before the switch so every ' +
          'hash-consuming action is validated centrally (not per-handler)'
      );
    });

    it('the misleading security-follow-up TODO is gone', () => {
      assert.ok(
        !/TODO\(security follow-up\)/.test(clsSrc),
        'the security-follow-up TODO must be removed once validation is centralized'
      );
    });
  });
});

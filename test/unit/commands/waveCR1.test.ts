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
import * as assert from 'assert';

describe('Wave C R1 — review fixes', () => {
  let src: string;

  before(async () => {
    const fs = await import('fs');
    const path = await import('path');
    src = fs.readFileSync(
      path.join(process.cwd(), 'src/commits/CommitContextMenuCommands.ts'),
      'utf8'
    );
  });

  // ─── squash dialog uses untitled-editor + save listener ──────────────────
  describe('squash dialog editor flow', () => {
    it('CommitContextMenuCommands no longer calls showInputBox in the squash handler', () => {
      const squashIdx = src.indexOf('private async _handleSquashCommits');
      assert.ok(squashIdx > 0, 'expected _handleSquashCommits definition');
      const editIdx = src.indexOf('private async _handleEditCommitMessage', squashIdx);
      const squashBody = src.substring(squashIdx, editIdx > 0 ? editIdx : squashIdx + 12000);
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
        /private\s+async\s+_promptForMessageInEditor\s*\(/.test(src),
        'expected the squash editor helper to live in a single named method'
      );
    });

    it('the editor helper opens openTextDocument and registers save+close listeners', () => {
      const helperIdx = src.indexOf('private async _promptForMessageInEditor');
      assert.ok(helperIdx > 0, 'expected _promptForMessageInEditor definition');
      const helperEnd = src.indexOf('\n  }', helperIdx + 200);
      const helperBody = src.substring(helperIdx, helperEnd > 0 ? helperEnd : helperIdx + 8000);
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
      const helperIdx = src.indexOf('private async _promptForMessageInEditor');
      const helperEnd = src.indexOf('\n  }', helperIdx + 200);
      const helperBody = src.substring(helperIdx, helperEnd > 0 ? helperEnd : helperIdx + 8000);
      assert.ok(
        /vscode\.window\.showTextDocument\s*\(/.test(helperBody),
        'editor helper must call showTextDocument so the user sees the document'
      );
    });

    it('the editor helper closes the editor + cleans up the tempfile after resolution', () => {
      const helperIdx = src.indexOf('private async _promptForMessageInEditor');
      const helperEnd = src.indexOf('\n  }', helperIdx + 200);
      const helperBody = src.substring(helperIdx, helperEnd > 0 ? helperEnd : helperIdx + 8000);
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
      const dropIdx = src.indexOf('private async _handleDropCommit(');
      assert.ok(dropIdx > 0, 'expected _handleDropCommit definition');
      const multiIdx = src.indexOf('private async _handleDropCommitMulti', dropIdx);
      const dropBody = src.substring(dropIdx, multiIdx > 0 ? multiIdx : dropIdx + 4000);
      assert.ok(
        /allHashesValid\s*\(\s*commitHashes\s*\)/.test(dropBody),
        '_handleDropCommit must call allHashesValid(commitHashes) before routing'
      );
    });

    it('_handleDropCommit resolves the rebase base through _resolveRewriteBase (initial-commit arm)', () => {
      const dropIdx = src.indexOf('private async _handleDropCommit(');
      const multiIdx = src.indexOf('private async _handleDropCommitMulti', dropIdx);
      const dropBody = src.substring(dropIdx, multiIdx > 0 ? multiIdx : dropIdx + 4000);
      assert.ok(
        /_resolveRewriteBase\s*\(/.test(dropBody),
        '_handleDropCommit must resolve its base via _resolveRewriteBase (warn-then---root for the initial commit)'
      );
    });
  });

  // ─── squash status: 'paused' guard ───────────────────────────────────────
  // The outcome switch lives in the shared runner (_runHistoryRewrite); the
  // squash body must ride it and the runner must keep the pins.
  describe('squash second-pause false-success edge', () => {
    it('_handleSquashCommits rides the shared history-rewrite runner', () => {
      const squashIdx = src.indexOf('private async _handleSquashCommits');
      const editIdx = src.indexOf('private async _handleEditCommitMessage', squashIdx);
      const squashBody = src.substring(squashIdx, editIdx > 0 ? editIdx : squashIdx + 12000);
      assert.ok(
        /this\._runHistoryRewrite\s*\(/.test(squashBody),
        '_handleSquashCommits must delegate execute + outcome handling to _runHistoryRewrite'
      );
    });

    it("the runner's success branch pins to status === 'completed'", () => {
      const runnerIdx = src.indexOf('private async _runHistoryRewrite');
      assert.ok(runnerIdx > 0, 'expected _runHistoryRewrite definition');
      const nextIdx = src.indexOf('private async _handleDropCommit(', runnerIdx);
      const runnerBody = src.substring(runnerIdx, nextIdx > 0 ? nextIdx : runnerIdx + 8000);
      assert.ok(
        /result\.status\s*===\s*['"]completed['"]/.test(runnerBody),
        "the runner's success branch must require status === 'completed'"
      );
    });

    it("the runner surfaces a partial-complete warning when status === 'paused'", () => {
      const runnerIdx = src.indexOf('private async _runHistoryRewrite');
      const nextIdx = src.indexOf('private async _handleDropCommit(', runnerIdx);
      const runnerBody = src.substring(runnerIdx, nextIdx > 0 ? nextIdx : runnerIdx + 8000);
      assert.ok(
        /partially complete|partial complete/i.test(runnerBody),
        'the runner must surface a partial-complete warning'
      );
    });
  });

  // ─── drop empty-rebase-window guard ──────────────────────────────────────
  describe('drop multi guards against empty / partial rebase windows', () => {
    it('_handleDropCommitMulti aborts when the plan covers fewer commits than selected', () => {
      const handlerIdx = src.indexOf('private async _handleDropCommitMulti');
      const nextIdx = src.indexOf('private async _handleSquashCommits', handlerIdx);
      const body = src.substring(handlerIdx, nextIdx > 0 ? nextIdx : handlerIdx + 12000);
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
    it('_handleDropCommitMulti calls getCommit for each preview row', () => {
      const handlerIdx = src.indexOf('private async _handleDropCommitMulti');
      const nextIdx = src.indexOf('private async _handleSquashCommits', handlerIdx);
      const body = src.substring(handlerIdx, nextIdx > 0 ? nextIdx : handlerIdx + 12000);
      assert.ok(
        /this\._gitService\.getCommit\s*\(\s*repo\s*,/.test(body),
        '_handleDropCommitMulti must fetch subjects via getCommit so the modal can disambiguate commits'
      );
    });
  });

  // ─── no manual stash bracket in the rebase-editing flows ─────────────────
  describe('drop multi carries no manual stash bracket', () => {
    it('_handleDropCommitMulti rides the shared runner with no stash machinery', () => {
      const handlerIdx = src.indexOf('private async _handleDropCommitMulti');
      const nextIdx = src.indexOf('private async _handleSquashCommits', handlerIdx);
      const body = src.substring(handlerIdx, nextIdx > 0 ? nextIdx : handlerIdx + 12000);
      assert.ok(
        /this\._runHistoryRewrite\s*\(/.test(body),
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
      // The multi-commit handlers (createPatchMulti, compareVersions,
      // dropCommitMulti, squashCommits, and the new partial-coverage
      // guard) all emit the toast. Count the references to the const
      // inside the file.
      const refs = src.match(/STALE_SELECTION_TOAST\b/g) || [];
      // 1 declaration + ≥4 references in handler bodies.
      assert.ok(
        refs.length >= 5,
        `expected ≥5 STALE_SELECTION_TOAST references (decl + handlers); got ${refs.length}`
      );
    });

    it('there are no inline duplicates of the toast literal', async () => {
      const fs = await import('fs');
      const path = await import('path');
      // Single source: the literal appears exactly once (the const decl in the
      // shared module); the class and the patch module reference the symbol.
      const files = [
        'src/commits/CommitContextMenuCommands.ts',
        'src/commits/commitContextMenuShared.ts',
        'src/commits/commitPatchActions.ts',
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
      const dispatchIdx = src.indexOf('private async _dispatchAction(');
      assert.ok(dispatchIdx > 0, 'expected _dispatchAction definition');
      const switchIdx = src.indexOf('switch (action)', dispatchIdx);
      const head = src.substring(dispatchIdx, switchIdx > 0 ? switchIdx : dispatchIdx + 1200);
      assert.ok(
        /allHashesValid\s*\(\s*commitHashes\s*\)/.test(head),
        '_dispatchAction must reject a non-hex hash before the switch so every ' +
          'hash-consuming action is validated centrally (not per-handler)'
      );
    });

    it('the misleading security-follow-up TODO is gone', () => {
      assert.ok(
        !/TODO\(security follow-up\)/.test(src),
        'the security-follow-up TODO must be removed once validation is centralized'
      );
    });
  });
});

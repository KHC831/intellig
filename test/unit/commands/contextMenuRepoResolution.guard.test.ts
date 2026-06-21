/**
 * Structural guard — context-menu handlers must resolve the operation's
 * target repository from the clicked item, never from the active/context repo.
 *
 * Bug class (the H-1 / H-2 wrong-repo data-loss class): in a multi-root
 * workspace the graph/branch views can show commits and refs from every
 * repository at once ("all" scope). A handler that resolves its repo with a
 * bare `this._getRepository()` (the dropdown's selected repo) then runs a
 * mutating git op against the WRONG repository — deleting a branch, resetting
 * HEAD, or pushing a tag in a repo the user never clicked. The fix routes every
 * item-receiving handler through an item-aware resolver:
 *   - BranchContextMenuCommands: `_resolveRepository(item)` (item.repository ??
 *     fallback), so a clicked branch/tag leaf carries its own repo.
 *   - CommitContextMenuCommands: `_getRepositoryForCommit(hash)`
 *     (`getRepoRootForCommit(hash)` ?? fallback), so a clicked commit row
 *     resolves the repo the commit actually belongs to.
 *
 * This guard locks the invariant so the regression cannot silently return.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const BRANCH_FILE = path.join(process.cwd(), 'src/branches/BranchContextMenuCommands.ts');
const COMMIT_FILE = path.join(process.cwd(), 'src/commits/CommitContextMenuCommands.ts');

/**
 * Editor / command-palette handler files whose commands resolve a repo + a
 * file path. They run git with `cwd = repo.rootUri.fsPath`, so the second
 * limb of the same wrong-target bug class lives here: the pathspec must be
 * REPO-root-relative, derived via `repoRelativePath(repo.rootUri.fsPath, …)` —
 * never `vscode.workspace.asRelativePath(…)` (workspace-folder-relative, wrong
 * in a nested / multi-root repo). See {@link asRelativePathGitPathspecOffenders}.
 */
const EDITOR_PALETTE_HANDLER_FILES = [
  'src/commands/registration/commitRepoCoreCommands.ts',
  'src/commands/registration/blameEditorCommands.ts',
  'src/commands/registration/explorerCommands.ts',
].map((rel) => path.join(process.cwd(), rel));

/**
 * Indices of every class-member start (method declaration or its JSDoc) at
 * class-body indentation. Used to bound a method body without brace-matching
 * through the template literals and nested callbacks that the handlers contain.
 */
function memberBoundaries(src: string): number[] {
  const re = /^ {2}(?:private|public|protected|static|\/\*\*)/gm;
  const idxs: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    idxs.push(m.index);
  }
  return idxs;
}

/** Source of a single method, from its signature to the next member start. */
function methodBody(src: string, sigIdx: number, boundaries: number[]): string {
  const next = boundaries.find((b) => b > sigIdx);
  return src.slice(sigIdx, next ?? src.length);
}

/**
 * Names of item-receiving handlers (those whose signature takes a
 * `BranchTreeItem`) whose body resolves the repo with a bare
 * `this._getRepository()` instead of the item-aware `_resolveRepository(item)`.
 * A non-empty result is the wrong-repo bug class.
 */
function bareRepoItemHandlers(src: string): string[] {
  const boundaries = memberBoundaries(src);
  const sigRe = /private (?:async )?(_handle\w*)\([^)]*BranchTreeItem/g;
  const bad: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = sigRe.exec(src)) !== null) {
    const body = methodBody(src, m.index, boundaries);
    if (/this\._getRepository\(\)/.test(body)) {
      bad.push(m[1]);
    }
  }
  return bad;
}

/**
 * Executable lines in an editor/palette handler file that derive a git
 * pathspec from `vscode.workspace.asRelativePath(...)`. That value is relative
 * to the WORKSPACE FOLDER, but the git op runs under `cwd =
 * repo.rootUri.fsPath`, so in a nested repo / submodule (or a multi-root
 * workspace where the folder name is prefixed) the path is wrong and
 * `git <op> -- <folder>/<file>` fails (mutations silently no-op; reads report
 * a false "nothing here"). The only correct derivation is
 * `repoRelativePath(repo.rootUri.fsPath, ...)`. A non-empty result is the bug
 * class that regressed stage/unstage/revert/history/blame in nested repos.
 *
 * The handler signatures here are anonymous `registerLoggedCommand(...)` arrow
 * functions, not `_handle*(item: BranchTreeItem)` methods — so the
 * {@link bareRepoItemHandlers} detector cannot see them. This companion scans
 * the executable source instead. Comment / JSDoc lines that merely MENTION the
 * helper to warn against it (`asRelativePath` without an immediate `(`, or a
 * `//` / `*` line) are excluded — only live derivations count.
 */
function asRelativePathGitPathspecOffenders(src: string): string[] {
  const offenders: string[] = [];
  for (const raw of src.split('\n')) {
    const trimmed = raw.trim();
    // Skip pure comment / JSDoc lines.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }
    // Strip a trailing line comment so an inline `// …asRelativePath(…` note
    // can't masquerade as a live derivation.
    const codeOnly = raw.replace(/\/\/.*$/, '');
    if (/vscode\.workspace\.asRelativePath\(/.test(codeOnly)) {
      offenders.push(trimmed);
    }
  }
  return offenders;
}

describe('context-menu handlers resolve the target repo from the clicked item (wrong-repo guard)', () => {
  it('the detector has teeth: it flags an item-handler that uses bare _getRepository()', () => {
    const syntheticBad = [
      'class X {',
      '  private async _handleEvil(item: BranchTreeItem): Promise<void> {',
      '    const repo = this._getRepository();',
      '    await doThing(repo);',
      '  }',
      '  private async _handleGood(item: BranchTreeItem): Promise<void> {',
      '    const repo = this._resolveRepository(item);',
      '    await doThing(repo);',
      '  }',
      '}',
    ].join('\n');
    assert.deepStrictEqual(
      bareRepoItemHandlers(syntheticBad),
      ['_handleEvil'],
      'detector must flag the bare-_getRepository item handler and only that one'
    );
  });

  it('BranchContextMenuCommands: every BranchTreeItem handler resolves via _resolveRepository(item)', () => {
    const src = fs.readFileSync(BRANCH_FILE, 'utf8');
    const offenders = bareRepoItemHandlers(src);
    assert.deepStrictEqual(
      offenders,
      [],
      'these item-receiving handlers resolve the context repo with a bare ' +
        'this._getRepository() instead of _resolveRepository(item), risking a ' +
        `wrong-repo mutation in "all" scope: ${offenders.join(', ')}`
    );
  });

  it('BranchContextMenuCommands: _resolveRepository prefers the item repo then falls back', () => {
    const src = fs.readFileSync(BRANCH_FILE, 'utf8');
    const boundaries = memberBoundaries(src);
    const sigIdx = src.search(/private _resolveRepository\(/);
    assert.ok(sigIdx > 0, 'expected a _resolveRepository(item) helper');
    const body = methodBody(src, sigIdx, boundaries);
    assert.ok(
      /item\?\.repository\s*\?\?\s*this\._getRepository\(\)/.test(body),
      '_resolveRepository must be `item?.repository ?? this._getRepository()` so the ' +
        'clicked leaf wins and only header/no-item callers fall back'
    );
  });

  it('CommitContextMenuCommands: bare _getRepository() lives only in the per-commit resolver', () => {
    const src = fs.readFileSync(COMMIT_FILE, 'utf8');
    const total = (src.match(/this\._getRepository\(\)/g) || []).length;
    assert.strictEqual(
      total,
      1,
      'commit handlers must route through _getRepositoryForCommit(hash); the only ' +
        `bare this._getRepository() call is its fallback (found ${total})`
    );
    const boundaries = memberBoundaries(src);
    const sigIdx = src.search(/private async _getRepositoryForCommit\(/);
    assert.ok(sigIdx > 0, 'expected a _getRepositoryForCommit(hash) resolver');
    const body = methodBody(src, sigIdx, boundaries);
    assert.ok(
      /this\._getRepository\(\)/.test(body),
      'the single bare _getRepository() call must be the fallback inside ' +
        '_getRepositoryForCommit, not a handler bypassing per-commit resolution'
    );
  });
});

describe('editor/palette handlers derive the git pathspec repo-root-relative (wrong-path guard)', () => {
  it('the detector has teeth: it flags a live asRelativePath derivation, not the repo-relative one or a comment', () => {
    const synthetic = [
      'async function bad() {',
      '  const filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);',
      '  await gitService.stage(repo, [filePath]);',
      '}',
      'async function good() {',
      '  // never vscode.workspace.asRelativePath(uri) — workspace-folder-relative',
      '  const filePath = repoRelativePath(repo.rootUri.fsPath, activeEditor.document.uri.fsPath);',
      '  await gitService.stage(repo, [filePath]);',
      '}',
    ].join('\n');
    assert.deepStrictEqual(
      asRelativePathGitPathspecOffenders(synthetic),
      ['const filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);'],
      'detector must flag the live asRelativePath derivation and only that one'
    );
  });

  for (const file of EDITOR_PALETTE_HANDLER_FILES) {
    it(`${path.basename(file)}: no command handler derives the git pathspec from asRelativePath`, () => {
      const src = fs.readFileSync(file, 'utf8');
      const offenders = asRelativePathGitPathspecOffenders(src);
      assert.deepStrictEqual(
        offenders,
        [],
        'these lines derive a git pathspec from vscode.workspace.asRelativePath (workspace-folder-' +
          'relative) instead of repoRelativePath(repo.rootUri.fsPath, …), reintroducing the ' +
          `nested/multi-root wrong-path bug:\n  ${offenders.join('\n  ')}`
      );
    });
  }
});

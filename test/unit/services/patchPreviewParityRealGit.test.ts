/**
 * The Apply Patch preview must predict the apply.
 *
 * Preview runs `check: true`; apply runs for real. Both must reach the same
 * verdict on the same tree, so the three fixtures below cover git's whole
 * outcome space for a 3-way apply, measured against real git:
 *
 *   fixture        plain --check   --3way --check   --index --3way
 *   clean-apply    0               0                0, clean
 *   3way-clean     1               0                0, clean
 *   3way-conflict  1               0 + prose        1, conflict markers
 *
 * The middle row is why check mode carries `--3way`: a bare `--check` calls a
 * patch unappliable that the apply lands cleanly. The bottom row is why the
 * conflicted outcome is read from git's per-file prose: `--3way --check`
 * exits 0 whether the merge is clean or conflicted, and reports the
 * difference only as `Applied patch to '<path>' with conflicts.`
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { GitCli } from '../../../src/git-core/gitCli';
import { parseStatus } from '../../../src/git-core/gitParser';
import { PatchService } from '../../../src/patches/PatchService';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import type { IApplyPatchResult } from '../../../src/patches/interfaces/IPatchService';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function mkdtemp(prefix: string): string {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(SCRATCH_ROOT, prefix));
}

function repoOf(root: string): IRepository {
  return { rootUri: vscode.Uri.file(root) } as IRepository;
}

/**
 * PatchService reads `git status` to name the files a real apply left
 * unmerged, so the stub answers from the actual repo rather than a fixture —
 * that read is half of what the conflict verdict is being compared against.
 */
function makeService(): PatchService {
  const gitCli = new GitCli();
  const gitService = {
    gitCli,
    getStatus: (repo: IRepository) =>
      Promise.resolve(parseStatus(git(repo.rootUri.fsPath, 'status', '--porcelain'))),
  } as unknown as IGitService;
  return new PatchService(gitService);
}

const BASE_TEXT = 'line1\nline2\nline3\nline4\nline5\n';
const PATCH_TEXT = 'line1\nline2\nCHANGED\nline4\nline5\n';

/**
 * A repo whose HEAD content is `headText`, plus the patch that turns the
 * ORIGINAL base content into `PATCH_TEXT`. When `headText` differs from the
 * base, the patch only lands through the 3-way merge.
 */
function fixture(prefix: string, headText: string): { root: string; patch: string } {
  const root = mkdtemp(prefix);
  git(SCRATCH_ROOT, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');

  const file = path.join(root, 'f.txt');
  fs.writeFileSync(file, BASE_TEXT);
  git(root, 'add', 'f.txt');
  git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD').trim();

  fs.writeFileSync(file, PATCH_TEXT);
  git(root, 'commit', '-qam', 'change');
  const patch = git(root, 'diff', base, 'HEAD');

  git(root, 'reset', '-q', '--hard', base);
  if (headText !== BASE_TEXT) {
    fs.writeFileSync(file, headText);
    git(root, 'commit', '-qam', 'diverge');
  }
  return { root, patch };
}

/** Preview one fixture, then apply the same patch to a fresh copy of it. */
async function previewThenApply(
  prefix: string,
  headText: string
): Promise<{ preview: IApplyPatchResult; apply: IApplyPatchResult; status: string }> {
  const service = makeService();

  const previewFix = fixture(`${prefix}-preview-`, headText);
  const before = git(previewFix.root, 'status', '--porcelain');
  const preview = await service.applyPatch(repoOf(previewFix.root), {
    patchContent: previewFix.patch,
    check: true,
  });
  assert.strictEqual(
    git(previewFix.root, 'status', '--porcelain'),
    before,
    'a preview must not touch the working tree or index'
  );

  const applyFix = fixture(`${prefix}-apply-`, headText);
  const apply = await service.applyPatch(repoOf(applyFix.root), {
    patchContent: applyFix.patch,
  });
  return { preview, apply, status: git(applyFix.root, 'status', '--porcelain') };
}

describe('Apply Patch preview predicts the apply — real git', () => {
  it('clean-apply: preview and apply both succeed', async () => {
    const { preview, apply } = await previewThenApply('patch-parity-clean', BASE_TEXT);

    assert.strictEqual(apply.success, true, 'sanity: the patch applies');
    assert.strictEqual(preview.success, true, 'preview agrees');
  });

  it('3way-clean: a patch that only lands via 3-way previews as appliable', async () => {
    // HEAD changed a DIFFERENT line, so the hunk context no longer matches
    // verbatim but the 3-way merge resolves it cleanly.
    const diverged = 'line1\nline2\nline3\nline4\nOTHER\n';
    const { preview, apply } = await previewThenApply('patch-parity-3way', diverged);

    assert.strictEqual(apply.success, true, 'sanity: the apply lands cleanly via --3way');
    assert.strictEqual(
      preview.success,
      true,
      'preview must not report "does not apply" for a patch the apply lands'
    );
    assert.ok(
      preview.conflicts === undefined || preview.conflicts.length === 0,
      'a clean 3-way merge previews without conflicts'
    );
  });

  it('3way-conflict: preview reports the conflict the apply produces', async () => {
    // HEAD changed the SAME line, so the merge needs conflict markers.
    const diverged = 'line1\nline2\nTHEIRS\nline4\nline5\n';
    const { preview, apply, status } = await previewThenApply('patch-parity-conflict', diverged);

    assert.ok(status.includes('UU f.txt'), 'sanity: the apply left an unmerged file');
    assert.strictEqual(apply.success, false);
    assert.deepStrictEqual(
      apply.conflicts?.map((c) => c.path),
      ['f.txt'],
      'sanity: the apply reports the conflicted file'
    );

    assert.strictEqual(preview.success, false, 'preview does not call a conflicting patch clean');
    assert.deepStrictEqual(
      preview.conflicts?.map((c) => c.path),
      ['f.txt'],
      'preview names the same file the apply conflicts on'
    );
  });

  it('unappliable: preview and apply both fail when the base blob is unknown', async () => {
    const service = makeService();
    const { patch } = fixture('patch-parity-unrelated-src-', BASE_TEXT);

    const other = mkdtemp('patch-parity-unrelated-');
    git(SCRATCH_ROOT, 'init', '-q', '-b', 'main', other);
    git(other, 'config', 'user.email', 'test@example.com');
    git(other, 'config', 'user.name', 'Test');
    git(other, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(other, 'f.txt'), 'totally\ndifferent\n');
    git(other, 'add', 'f.txt');
    git(other, 'commit', '-qm', 'unrelated');

    const preview = await service.applyPatch(repoOf(other), { patchContent: patch, check: true });
    const apply = await service.applyPatch(repoOf(other), { patchContent: patch });

    assert.strictEqual(apply.success, false, 'sanity: the patch cannot apply here');
    assert.strictEqual(preview.success, false, 'preview agrees');
    assert.ok(
      preview.conflicts === undefined || preview.conflicts.length === 0,
      'unappliable is not the same outcome as conflicted'
    );
  });
});

/**
 * Real-git tests for PatchService.createPatchFromLocalChanges. The mock-argv
 * suite (patchService.test.ts) cannot see whether the EMITTED PATCH APPLIES;
 * these build real repositories and run `git apply --check` on the output.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { GitCli } from '../../../src/git-core/gitCli';
import { PatchService, filterPatchByFiles } from '../../../src/patches/PatchService';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function mkdtemp(prefix: string): string {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(SCRATCH_ROOT, prefix));
}

function initRepo(prefix: string): string {
  const root = mkdtemp(prefix);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}

function makeService(): PatchService {
  const gitService = { gitCli: new GitCli() } as unknown as IGitService;
  return new PatchService(gitService);
}

function repoOf(root: string): IRepository {
  return { rootUri: vscode.Uri.file(root) } as IRepository;
}

/** Clone `root` at HEAD into a fresh dir and return the clone's path. */
function cloneAtHead(root: string, prefix: string): string {
  const clean = mkdtemp(prefix);
  git(SCRATCH_ROOT, 'clone', '-q', root, path.join(clean, 'repo'));
  return path.join(clean, 'repo');
}

/** `git apply --check` the patch text inside `cwd`; returns git's error or undefined. */
function applyCheckError(cwd: string, patch: string): string | undefined {
  const patchFile = path.join(mkdtemp('patch-check-'), 'x.patch');
  fs.writeFileSync(patchFile, patch);
  try {
    git(cwd, 'apply', '--check', patchFile);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Base commit + a staged edit + a further unstaged edit on the SAME file. */
function stagedPlusDirtyRepo(): string {
  const root = initRepo('patch-local-');
  const file = path.join(root, 'f.txt');
  fs.writeFileSync(file, 'line1\nline2\nline3\n');
  git(root, 'add', 'f.txt');
  git(root, 'commit', '-qm', 'base');
  fs.writeFileSync(file, 'line1 staged\nline2\nline3\n');
  git(root, 'add', 'f.txt');
  fs.writeFileSync(file, 'line1 staged\nline2\nline3 dirty\n');
  return root;
}

describe('createPatchFromLocalChanges — real git', () => {
  it('a staged+dirty file emits ONE HEAD→worktree block that applies on a clean checkout', async () => {
    const root = stagedPlusDirtyRepo();

    const patch = await makeService().createPatchFromLocalChanges(repoOf(root), {});

    const blocks = patch.match(/^diff --git /gm) ?? [];
    assert.strictEqual(blocks.length, 1, `one diff block per file, got:\n${patch}`);
    const err = applyCheckError(cloneAtHead(root, 'patch-clean-'), patch);
    assert.strictEqual(err, undefined, `patch must apply on a clean checkout: ${err}`);
  });

  it('reverse (-R) emits a patch that applies onto the DIRTY tree (undoes the changes)', async () => {
    const root = stagedPlusDirtyRepo();

    const patch = await makeService().createPatchFromLocalChanges(repoOf(root), {
      reverse: true,
    });

    assert.strictEqual((patch.match(/^diff --git /gm) ?? []).length, 1);
    const err = applyCheckError(root, patch);
    assert.strictEqual(err, undefined, `reverse patch must undo the local state: ${err}`);
  });

  it('stagedOnly emits only the index diff and it applies on a clean checkout', async () => {
    const root = stagedPlusDirtyRepo();

    const patch = await makeService().createPatchFromLocalChanges(repoOf(root), {
      stagedOnly: true,
    });

    assert.ok(patch.includes('line1 staged'), 'staged hunk present');
    assert.ok(!patch.includes('dirty'), 'unstaged edit must not leak into a stagedOnly patch');
    const err = applyCheckError(cloneAtHead(root, 'patch-staged-clean-'), patch);
    assert.strictEqual(err, undefined, `stagedOnly patch must apply cleanly: ${err}`);
  });

  it('a file filter still scopes the single-diff output', async () => {
    const root = stagedPlusDirtyRepo();
    fs.writeFileSync(path.join(root, 'other.txt'), 'other\n');
    git(root, 'add', 'other.txt');
    git(root, 'commit', '-qm', 'other');
    fs.appendFileSync(path.join(root, 'other.txt'), 'more\n');

    const patch = await makeService().createPatchFromLocalChanges(repoOf(root), {
      files: ['f.txt'],
    });

    assert.ok(patch.includes('f.txt'));
    assert.ok(!patch.includes('other.txt'), 'unselected files stay out of the patch');
  });

  it('emits an appliable patch on an unborn HEAD (a repo with no commits)', async () => {
    const root = initRepo('patch-unborn-');
    fs.writeFileSync(path.join(root, 'f.txt'), 'a\nb\n');
    git(root, 'add', 'f.txt');
    // Staged, then dirtied — the same staged+dirty shape as a normal repo.
    fs.writeFileSync(path.join(root, 'f.txt'), 'a\nb\nc\n');

    const patch = await makeService().createPatchFromLocalChanges(repoOf(root), {});

    assert.ok(patch.includes('f.txt'), `first-commit content must be in the patch:\n${patch}`);
    assert.ok(patch.includes('+c'), 'the worktree edit is included, not just the index');
    const err = applyCheckError(initRepo('patch-unborn-target-'), patch);
    assert.strictEqual(err, undefined, `unborn-HEAD patch must apply: ${err}`);
  });
});

/**
 * A `git format-patch` mailbox carries a `From <sha> Mon Sep 17 …` envelope
 * ahead of the diffs. `git am` needs it; per-file subsetting must not eat it.
 */
describe('filterPatchByFiles — mailbox (git am) sources, real git', () => {
  /** Two-file commit exported with `git format-patch`. */
  function mailboxPatch(): { patch: string; base: string } {
    const root = initRepo('patch-mbox-');
    fs.writeFileSync(path.join(root, 'keep.txt'), 'keep\n');
    fs.writeFileSync(path.join(root, 'drop.txt'), 'drop\n');
    git(root, 'add', 'keep.txt', 'drop.txt');
    git(root, 'commit', '-qm', 'base');
    const base = cloneAtHead(root, 'patch-mbox-base-');

    fs.writeFileSync(path.join(root, 'keep.txt'), 'keep changed\n');
    fs.writeFileSync(path.join(root, 'drop.txt'), 'drop changed\n');
    git(root, 'add', 'keep.txt', 'drop.txt');
    git(root, 'commit', '-qm', 'Touch both files');

    const outDir = mkdtemp('patch-mbox-out-');
    git(root, 'format-patch', '-1', '-o', outDir);
    const file = fs.readdirSync(outDir).find((n) => n.endsWith('.patch'));
    assert.ok(file, 'format-patch produced a mailbox file');
    return { patch: fs.readFileSync(path.join(outDir, file), 'utf8'), base };
  }

  it('a single-file subset still carries the mailbox envelope git am requires', () => {
    const { patch, base } = mailboxPatch();
    assert.ok(/^From \S+ /.test(patch), 'sanity: source really is a mailbox patch');

    const subset = filterPatchByFiles(patch, ['keep.txt']);

    // The envelope's diffstat still names every file of the original commit;
    // what must be gone is the unselected file's DIFF BLOCK.
    assert.ok(!/^diff --git .*drop\.txt/m.test(subset), 'unselected file has no diff block');
    const patchFile = path.join(mkdtemp('patch-am-'), 'subset.patch');
    fs.writeFileSync(patchFile, subset);
    // The real contract: `git am` must accept the subset. Without the
    // envelope it fails with "Patch format detection failed".
    git(base, 'am', patchFile);
    assert.strictEqual(
      fs.readFileSync(path.join(base, 'keep.txt'), 'utf8'),
      'keep changed\n',
      'the selected file was applied'
    );
    assert.strictEqual(
      fs.readFileSync(path.join(base, 'drop.txt'), 'utf8'),
      'drop\n',
      'the unselected file was left alone'
    );
  });

  it('preserves the commit message from the envelope so `git am` commits it', () => {
    const { patch, base } = mailboxPatch();

    const subset = filterPatchByFiles(patch, ['keep.txt']);

    const patchFile = path.join(mkdtemp('patch-am-msg-'), 'subset.patch');
    fs.writeFileSync(patchFile, subset);
    git(base, 'am', patchFile);
    assert.strictEqual(git(base, 'log', '-1', '--pretty=%s').trim(), 'Touch both files');
  });

  it('a plain (non-mailbox) patch subset gains no envelope', () => {
    const plain =
      'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n' +
      'diff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-a\n+b\n';

    const subset = filterPatchByFiles(plain, ['x.ts']);

    assert.ok(subset.startsWith('diff --git a/x.ts'), 'no synthetic preamble on plain patches');
  });
});

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

  it('a modified binary alongside modified text yields a patch that applies whole', async () => {
    const root = initRepo('patch-binary-');
    const bin = path.join(root, 'blob.bin');
    const txt = path.join(root, 'f.txt');
    fs.writeFileSync(bin, Buffer.from([0, 1, 2, 0, 255, 7, 0, 9]));
    fs.writeFileSync(txt, 'line1\nline2\n');
    git(root, 'add', 'blob.bin', 'f.txt');
    git(root, 'commit', '-qm', 'base');
    fs.writeFileSync(bin, Buffer.from([0, 9, 9, 0, 254, 7, 0, 1, 42]));
    fs.writeFileSync(txt, 'line1 edited\nline2\n');

    const patch = await makeService().createPatchFromLocalChanges(repoOf(root), {});

    // Without --binary git emits only a "Binary files differ" stub, which
    // `git apply` refuses — taking the text hunks down with it.
    assert.ok(
      patch.includes('GIT binary patch'),
      `binary content must be in the patch, not a stub:\n${patch}`
    );
    const clean = cloneAtHead(root, 'patch-binary-target-');
    const err = applyCheckError(clean, patch);
    assert.strictEqual(err, undefined, `binary+text patch must apply: ${err}`);

    // …and it must actually reproduce both sides once applied.
    const patchFile = path.join(mkdtemp('patch-binary-file-'), 'x.patch');
    fs.writeFileSync(patchFile, patch);
    git(clean, 'apply', patchFile);
    assert.deepStrictEqual(
      [...fs.readFileSync(path.join(clean, 'blob.bin'))],
      [...fs.readFileSync(bin)],
      'the binary must round-trip byte for byte'
    );
    assert.strictEqual(fs.readFileSync(path.join(clean, 'f.txt'), 'utf8'), 'line1 edited\nline2\n');
  });

  it('emits real binary content even when a textconv filter is configured', async () => {
    const root = initRepo('patch-textconv-');
    const bin = path.join(root, 'blob.bin');
    fs.writeFileSync(bin, Buffer.from([0, 1, 2, 0, 255]));
    fs.writeFileSync(path.join(root, '.gitattributes'), '*.bin diff=hexdump\n');
    git(root, 'add', 'blob.bin', '.gitattributes');
    git(root, 'commit', '-qm', 'base');
    git(root, 'config', 'diff.hexdump.textconv', 'od -c');
    fs.writeFileSync(bin, Buffer.from([9, 9, 2, 0, 254, 3]));

    const patch = await makeService().createPatchFromLocalChanges(repoOf(root), {});

    // textconv turns the binary into human-readable text hunks that apply to
    // nothing; --no-textconv keeps the appliable hex payload.
    assert.ok(
      patch.includes('GIT binary patch'),
      `textconv must not replace the binary payload:\n${patch}`
    );
    const err = applyCheckError(cloneAtHead(root, 'patch-textconv-target-'), patch);
    assert.strictEqual(err, undefined, `textconv-repo patch must apply: ${err}`);
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

  /**
   * A two-commit mailbox. Commit 1 touches `a.txt` and `shared.txt`;
   * commit 2 touches `b.txt`. Subsetting must keep each commit's own
   * envelope with its own files.
   */
  function twoCommitMailbox(): { patch: string; base: string } {
    const root = initRepo('patch-mbox2-');
    for (const name of ['a.txt', 'shared.txt', 'b.txt']) {
      fs.writeFileSync(path.join(root, name), `${name} v1\n`);
    }
    git(root, 'add', 'a.txt', 'shared.txt', 'b.txt');
    git(root, 'commit', '-qm', 'base');
    const base = cloneAtHead(root, 'patch-mbox2-base-');

    fs.writeFileSync(path.join(root, 'a.txt'), 'a.txt v2\n');
    fs.writeFileSync(path.join(root, 'shared.txt'), 'shared.txt v2\n');
    git(root, 'add', 'a.txt', 'shared.txt');
    git(root, 'commit', '-qm', 'First commit subject');

    fs.writeFileSync(path.join(root, 'b.txt'), 'b.txt v2\n');
    git(root, 'add', 'b.txt');
    git(root, 'commit', '-qm', 'Second commit subject');

    const outDir = mkdtemp('patch-mbox2-out-');
    git(root, 'format-patch', '-2', '-o', outDir);
    const files = fs
      .readdirSync(outDir)
      .filter((n) => n.endsWith('.patch'))
      .sort();
    assert.strictEqual(files.length, 2, 'format-patch produced two mailbox files');
    const patch = files.map((n) => fs.readFileSync(path.join(outDir, n), 'utf8')).join('');
    return { patch, base };
  }

  it('keeps each commit envelope with its own files when subsetting a multi-commit mailbox', () => {
    const { patch, base } = twoCommitMailbox();

    // Deselect one file of commit 1; commit 2 keeps its only file.
    const subset = filterPatchByFiles(patch, ['a.txt', 'b.txt']);

    const patchFile = path.join(mkdtemp('patch-am2-'), 'subset.patch');
    fs.writeFileSync(patchFile, subset);
    git(base, 'am', patchFile);

    assert.deepStrictEqual(
      git(base, 'log', '-2', '--pretty=%s')
        .trim()
        .split('\n')
        .map((s) => s.trim()),
      ['Second commit subject', 'First commit subject'],
      'both commits land, each under its own message'
    );
    assert.strictEqual(fs.readFileSync(path.join(base, 'a.txt'), 'utf8'), 'a.txt v2\n');
    assert.strictEqual(fs.readFileSync(path.join(base, 'b.txt'), 'utf8'), 'b.txt v2\n');
    assert.strictEqual(
      fs.readFileSync(path.join(base, 'shared.txt'), 'utf8'),
      'shared.txt v1\n',
      'the deselected file was never applied'
    );
  });

  it('drops a commit whose files were all deselected', () => {
    const { patch, base } = twoCommitMailbox();

    const subset = filterPatchByFiles(patch, ['b.txt']);

    const patchFile = path.join(mkdtemp('patch-am3-'), 'subset.patch');
    fs.writeFileSync(patchFile, subset);
    git(base, 'am', patchFile);

    assert.strictEqual(git(base, 'log', '-1', '--pretty=%s').trim(), 'Second commit subject');
    assert.strictEqual(
      git(base, 'rev-list', '--count', 'HEAD').trim(),
      '2',
      'only the base commit and the one kept commit exist'
    );
  });

  it('a plain (non-mailbox) patch subset gains no envelope', () => {
    const plain =
      'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n' +
      'diff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-a\n+b\n';

    const subset = filterPatchByFiles(plain, ['x.ts']);

    assert.ok(subset.startsWith('diff --git a/x.ts'), 'no synthetic preamble on plain patches');
  });
});

describe('mailbox envelope recognition — real git am', () => {
  /**
   * A three-commit mailbox, one file per commit, with every envelope line
   * rewritten by `rewriteEnvelope`. Returns the mailbox plus a clean base
   * clone to `git am` it onto.
   */
  function threeCommitMailbox(
    prefix: string,
    rewriteEnvelope: (ident: string, index: number) => string
  ): { patch: string; base: string } {
    const root = initRepo(prefix);
    for (const name of ['one.txt', 'two.txt', 'three.txt']) {
      fs.writeFileSync(path.join(root, name), `${name} v1\n`);
    }
    git(root, 'add', 'one.txt', 'two.txt', 'three.txt');
    git(root, 'commit', '-qm', 'base');
    const base = cloneAtHead(root, `${prefix}base-`);

    for (const [index, name] of ['one.txt', 'two.txt', 'three.txt'].entries()) {
      fs.writeFileSync(path.join(root, name), `${name} v2\n`);
      git(root, 'add', name);
      git(root, 'commit', '-qm', `Commit ${index + 1} subject`);
    }

    const outDir = mkdtemp(`${prefix}out-`);
    git(root, 'format-patch', '-3', '-o', outDir);
    const files = fs
      .readdirSync(outDir)
      .filter((n) => n.endsWith('.patch'))
      .sort();
    assert.strictEqual(files.length, 3, 'format-patch produced three mailbox files');

    let index = 0;
    const patch = files
      .map((n) => fs.readFileSync(path.join(outDir, n), 'utf8'))
      .join('')
      .replace(/^From (\S+) (.*)$/gm, (_all, ident: string, rest: string) => {
        const line = `From ${rewriteEnvelope(ident, index)} ${rest}`;
        index += 1;
        return line;
      });
    return { patch, base };
  }

  it('splits an mboxrd mailbox per commit, so a subset keeps its OWN message', () => {
    // The mailing-list envelope form: the ident is `mboxrd@z`, not an object
    // name. `git am` accepts it, so per-commit splitting must too.
    const { patch, base } = threeCommitMailbox('patch-mboxrd-', () => 'mboxrd@z');
    assert.ok(patch.includes('From mboxrd@z '), 'sanity: envelopes really are mboxrd-shaped');

    // Keep ONLY the second commit's file. If the mailbox is not split per
    // commit, this block gets the FIRST commit's envelope and lands under the
    // wrong message.
    const subset = filterPatchByFiles(patch, ['two.txt']);

    const patchFile = path.join(mkdtemp('patch-mboxrd-am-'), 'subset.patch');
    fs.writeFileSync(patchFile, subset);
    git(base, 'am', patchFile);

    assert.strictEqual(
      git(base, 'log', '-1', '--pretty=%s').trim(),
      'Commit 2 subject',
      'the kept change lands under its own commit message'
    );
    assert.strictEqual(fs.readFileSync(path.join(base, 'two.txt'), 'utf8'), 'two.txt v2\n');
    assert.strictEqual(
      fs.readFileSync(path.join(base, 'one.txt'), 'utf8'),
      'one.txt v1\n',
      'the deselected commit never applied'
    );
  });

  it('splits a 64-hex (SHA-256) envelope mailbox per commit', () => {
    const { patch, base } = threeCommitMailbox('patch-sha256-', (_ident, index) =>
      String(index + 1).repeat(64)
    );
    assert.ok(/^From [0-9a-f]{64} /m.test(patch), 'sanity: envelopes carry 64-hex idents');

    const subset = filterPatchByFiles(patch, ['three.txt']);

    const patchFile = path.join(mkdtemp('patch-sha256-am-'), 'subset.patch');
    fs.writeFileSync(patchFile, subset);
    git(base, 'am', patchFile);

    assert.strictEqual(git(base, 'log', '-1', '--pretty=%s').trim(), 'Commit 3 subject');
    assert.strictEqual(
      git(base, 'rev-list', '--count', 'HEAD').trim(),
      '2',
      'only the base commit and the one kept commit exist'
    );
  });

  it('a commit-message line starting "From " does not open a new section', () => {
    // git mailsplit requires a date on the envelope line; a prose line that
    // merely starts with "From " is body text and must stay with its commit.
    const root = initRepo('patch-frombody-');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a v1\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'b v1\n');
    git(root, 'add', 'a.txt', 'b.txt');
    git(root, 'commit', '-qm', 'base');
    const base = cloneAtHead(root, 'patch-frombody-base-');

    fs.writeFileSync(path.join(root, 'a.txt'), 'a v2\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'b v2\n');
    git(root, 'add', 'a.txt', 'b.txt');
    git(root, 'commit', '-qm', 'Subject line\n\nFrom foo bar\nFrom the beginning we knew\n');

    const outDir = mkdtemp('patch-frombody-out-');
    git(root, 'format-patch', '-1', '-o', outDir);
    const file = fs.readdirSync(outDir).find((n) => n.endsWith('.patch'));
    assert.ok(file);
    const patch = fs.readFileSync(path.join(outDir, file), 'utf8');
    assert.ok(patch.includes('\nFrom foo bar\n'), 'sanity: body really carries the "From " line');

    const subset = filterPatchByFiles(patch, ['a.txt']);

    const patchFile = path.join(mkdtemp('patch-frombody-am-'), 'subset.patch');
    fs.writeFileSync(patchFile, subset);
    git(base, 'am', patchFile);

    assert.strictEqual(git(base, 'log', '-1', '--pretty=%s').trim(), 'Subject line');
    assert.ok(
      git(base, 'log', '-1', '--pretty=%b').includes('From foo bar'),
      'the body line survived inside its own commit message'
    );
    assert.strictEqual(fs.readFileSync(path.join(base, 'b.txt'), 'utf8'), 'b v1\n');
  });
});

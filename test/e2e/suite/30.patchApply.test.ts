/**
 * Tier-2 E2E — patch APPLY against real git.
 *
 * `patch.apply` was mock-only (the unit suite drives a scripted CLI), the
 * mock-trap class: the mocks scripted output shapes real git never emits and
 * hid real bugs this lane pins as regressions:
 *   - conflict scoping must parse the shape a real `git apply --index --3way`
 *     actually emits ("Applied patch to '<path>' with conflicts.") — the
 *     mocked lane only ever scripted "patching file <path>", so the scoping
 *     silently degraded to ALL unmerged files and blamed pre-existing
 *     unrelated conflicts on the patch;
 *   - real git even PRINTS that per-file line on a run that ultimately
 *     applies NOTHING (a sibling hard failure keeps `git apply` atomic), so
 *     output lines alone never prove partial state — the bracket arms below
 *     assert against `git status` and file bytes instead;
 *   - a failed multi-commit `git am` PAUSES with `.git/rebase-apply/applying`
 *     on disk — the repo must report kind 'applying' (never 'rebasing'), and
 *     the `intellig.am.continue/skip/abort` recovery commands must actually
 *     end the session.
 *
 * Arms: happy apply (+ staged via --index), conflict scoping, the pre-apply
 * bracket (full restore on conflict-arm abort; silent drop on success and
 * hard failure), and the two-commit-mailbox am failure driven through
 * abort / continue / skip.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getServices } from '../support/activatedExtension';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

describe('e2e — patch apply (real git)', function () {
  this.timeout(40_000);

  let fix: Fixture;
  let stubs: PromptStubs;

  afterEach(async () => {
    if (stubs) {
      stubs.restore();
    }
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  const rebaseApplyDir = (): string => path.join(fix.rootPath, '.git', 'rebase-apply');

  it('applies a patch file via the service — content restored and staged (--index)', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    const file0 = path.join(fix.rootPath, 'file0.txt');

    // Create a patch from a modification, then revert the modification.
    fs.writeFileSync(file0, 'content-0\npatched-line\n');
    const diff = await execGit(fix.rootPath, ['diff']);
    const patchPath = path.join(fix.rootPath, '..', 'change.patch');
    fs.writeFileSync(patchPath, diff.stdout);
    await execGit(fix.rootPath, ['checkout', '--', 'file0.txt']);

    const repo = await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    const res = await getServices()!.patchService.applyPatch(repo, { patchPath });

    assert.strictEqual(res.success, true, `apply failed: ${res.stderr ?? ''}`);
    assert.strictEqual(fs.readFileSync(file0, 'utf8'), 'content-0\npatched-line\n');
    const staged = await execGit(fix.rootPath, ['diff', '--cached', '--name-only']);
    assert.ok(
      staged.stdout.split('\n').includes('file0.txt'),
      `--index must stage the applied file; staged: ${staged.stdout}`
    );
  });

  it('scopes a 3way conflict to the patched file — a pre-existing unrelated UU file is not attributed', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    const target = path.join(fix.rootPath, 'target.txt');
    const other = path.join(fix.rootPath, 'other.txt');

    // Base commit with both files.
    fs.writeFileSync(target, 'original\n');
    fs.writeFileSync(other, 'other-base\n');
    await execGit(fix.rootPath, ['add', 'target.txt', 'other.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'seed target+other']);

    // Patch that rewrites target.txt, generated against 'original'.
    fs.writeFileSync(target, 'upstream\n');
    const diff = await execGit(fix.rootPath, ['diff', '--', 'target.txt']);
    const patchPath = path.join(fix.rootPath, '..', 'conflict.patch');
    fs.writeFileSync(patchPath, diff.stdout);
    await execGit(fix.rootPath, ['checkout', '--', 'target.txt']);

    // Commit a colliding local change so the 3way apply conflicts.
    fs.writeFileSync(target, 'local\n');
    await execGit(fix.rootPath, ['commit', '-am', 'local target change']);

    // Manufacture an unrelated pre-existing UU file via a merge conflict
    // on other.txt (left unresolved).
    await execGit(fix.rootPath, ['checkout', '-b', 'side']);
    fs.writeFileSync(other, 'side\n');
    await execGit(fix.rootPath, ['commit', '-am', 'side other change']);
    await execGit(fix.rootPath, ['checkout', fix.defaultBranch]);
    fs.writeFileSync(other, 'main\n');
    await execGit(fix.rootPath, ['commit', '-am', 'main other change']);
    await execGit(fix.rootPath, ['merge', 'side'], { allowNonZero: true });
    const status = await execGit(fix.rootPath, ['status', '--porcelain']);
    assert.ok(/^UU other\.txt$/m.test(status.stdout), `expected UU other.txt: ${status.stdout}`);

    const repo = await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    const res = await getServices()!.patchService.applyPatch(repo, { patchPath });

    assert.strictEqual(res.success, false);
    assert.ok(res.conflicts, `expected a conflict result, got stderr: ${res.stderr ?? ''}`);
    assert.deepStrictEqual(
      res.conflicts.map((c) => c.path),
      ['target.txt'],
      'conflicts must list exactly the colliding file — never the unrelated UU file'
    );
    // The plain-apply path must not claim a git-am session.
    assert.ok(!res.amSessionActive, 'plain git apply must never report an am session');
  });

  it('conflict-arm Abort restores the FULL pre-apply state — new file gone, siblings back, tree byte-identical', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    const t = path.join(fix.rootPath, 't.txt');
    const sib = path.join(fix.rootPath, 's.txt');
    const w = path.join(fix.rootPath, 'w.txt');
    const n = path.join(fix.rootPath, 'n.txt');

    fs.writeFileSync(t, 'original\n');
    fs.writeFileSync(sib, 'l1\nl2\nl3\n');
    fs.writeFileSync(w, 'w-base\n');
    await execGit(fix.rootPath, ['add', 't.txt', 's.txt', 'w.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'seed bracket base']);

    // Patch: rewrite t.txt (will conflict), touch s.txt line 1 (applies
    // cleanly via 3way over the staged l3 change), and CREATE n.txt.
    await execGit(fix.rootPath, ['checkout', '-b', 'up']);
    fs.writeFileSync(t, 'upstream\n');
    fs.writeFileSync(sib, 'l1-up\nl2\nl3\n');
    fs.writeFileSync(n, 'brand-new\n');
    await execGit(fix.rootPath, ['add', 't.txt', 's.txt', 'n.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'upstream patch source']);
    const diff = await execGit(fix.rootPath, ['diff', `${fix.defaultBranch}...up`]);
    const patchPath = path.join(fix.rootPath, '..', 'bracket.patch');
    fs.writeFileSync(patchPath, diff.stdout);
    await execGit(fix.rootPath, ['checkout', fix.defaultBranch]);

    // Local state the abort must bring back exactly: a committed conflicting
    // change on t.txt, a STAGED uncommitted change on s.txt, and an unstaged
    // change on w.txt (untouched by the patch — must survive both ways).
    fs.writeFileSync(t, 'local\n');
    await execGit(fix.rootPath, ['commit', '-am', 'local t change']);
    fs.writeFileSync(sib, 'l1\nl2\nl3-local\n');
    await execGit(fix.rootPath, ['add', 's.txt']);
    fs.writeFileSync(w, 'w-dirty\n');

    const preStatus = (await execGit(fix.rootPath, ['status', '--porcelain'])).stdout;
    const preStash = (await execGit(fix.rootPath, ['stash', 'list'])).stdout;

    const repo = await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});
    const services = getServices()!;

    const res = await services.patchService.applyPatch(repo, { patchPath });

    // Partial state on disk: the conflict is scoped to t.txt, the clean
    // siblings landed (n.txt created, s.txt 3way-merged over the staged
    // change), and the bracket token names ALL touched files.
    assert.strictEqual(res.success, false);
    assert.deepStrictEqual(
      res.conflicts?.map((c) => c.path),
      ['t.txt'],
      `stderr: ${res.stderr ?? ''}`
    );
    assert.ok(fs.existsSync(n), 'the clean new file must be applied before the abort');
    assert.strictEqual(fs.readFileSync(sib, 'utf8'), 'l1-up\nl2\nl3-local\n');
    assert.ok(res.preApplyState, 'the conflict result must carry the restore token');
    assert.ok(res.preApplyState.stashSha, 'a dirty pre-apply tree must pin a snapshot sha');
    assert.deepStrictEqual(
      [...res.preApplyState.patchPaths].sort(),
      ['n.txt', 's.txt', 't.txt'],
      'the token must name every touched file, silent clean ones included'
    );
    // The snapshot never litters the stash stack.
    assert.strictEqual(
      (await execGit(fix.rootPath, ['stash', 'list'])).stdout,
      preStash,
      'the bracket must not touch the stash stack'
    );

    const restored = await services.conflictResolutionService.restorePreApplyState(
      repo,
      res.preApplyState
    );
    assert.strictEqual(restored.success, true, `restore failed: ${restored.error ?? ''}`);

    // Byte-identical pre-apply state: contents, the patch-created file, the
    // conflict, and the untouched dirty file.
    assert.ok(!fs.existsSync(n), 'the patch-created file must be GONE after the abort');
    assert.strictEqual(fs.readFileSync(t, 'utf8'), 'local\n');
    assert.strictEqual(fs.readFileSync(sib, 'utf8'), 'l1\nl2\nl3-local\n');
    assert.strictEqual(fs.readFileSync(w, 'utf8'), 'w-dirty\n');
    const postStatus = (await execGit(fix.rootPath, ['status', '--porcelain'])).stdout;
    assert.deepStrictEqual(
      postStatus.split('\n').sort(),
      preStatus.split('\n').sort(),
      'git status must match the pre-apply snapshot exactly'
    );
    assert.strictEqual((await execGit(fix.rootPath, ['stash', 'list'])).stdout, preStash);
  });

  it('success and hard failure drop the bracket silently — the stash stack never changes', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    const file0 = path.join(fix.rootPath, 'file0.txt');

    // Dirty tree so the snapshot actually captures something.
    fs.writeFileSync(path.join(fix.rootPath, 'dirty.txt'), 'not-in-patch\n');
    fs.writeFileSync(file0, 'content-0\npatched-line\n');
    const diff = await execGit(fix.rootPath, ['diff']);
    const patchPath = path.join(fix.rootPath, '..', 'ok.patch');
    fs.writeFileSync(patchPath, diff.stdout);
    await execGit(fix.rootPath, ['checkout', '--', 'file0.txt']);

    const repo = await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});
    const services = getServices()!;

    const ok = await services.patchService.applyPatch(repo, { patchPath });
    assert.strictEqual(ok.success, true, `apply failed: ${ok.stderr ?? ''}`);
    assert.strictEqual(
      (await execGit(fix.rootPath, ['stash', 'list'])).stdout,
      '',
      'a successful apply must leave the stash stack untouched'
    );
    assert.strictEqual(ok.preApplyState, undefined, 'success carries no restore token');

    const badPath = path.join(fix.rootPath, '..', 'corrupt.patch');
    fs.writeFileSync(badPath, 'diff --git a/x.txt b/x.txt\n@@ garbage @@\nnot a patch\n');
    const bad = await services.patchService.applyPatch(repo, { patchPath: badPath });
    assert.strictEqual(bad.success, false);
    assert.strictEqual(bad.preApplyState, undefined, 'a hard failure is atomic — no token');
    assert.strictEqual(
      (await execGit(fix.rootPath, ['stash', 'list'])).stdout,
      '',
      'a hard failure must leave the stash stack untouched'
    );
  });

  /**
   * Build the F-K1 repro: a two-commit mailbox whose SECOND commit collides
   * with a committed local change, applied with `useAm`. Returns once the
   * am session is paused on disk with the repo reporting kind 'applying'.
   */
  async function setupPausedAmSession(): Promise<{
    repo: IRepository;
    localHead: string;
    target: string;
  }> {
    fix = await createFixtureRepo({ commits: 1 });
    const target = path.join(fix.rootPath, 'target.txt');
    const filea = path.join(fix.rootPath, 'filea.txt');

    fs.writeFileSync(target, 'original\n');
    fs.writeFileSync(filea, 'a-base\n');
    await execGit(fix.rootPath, ['add', 'target.txt', 'filea.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'seed am base']);

    // Two upstream commits on a side branch: commit 1 applies cleanly,
    // commit 2 rewrites target.txt.
    await execGit(fix.rootPath, ['checkout', '-b', 'upstream-work']);
    fs.appendFileSync(filea, 'a-change\n');
    await execGit(fix.rootPath, ['commit', '-am', 'mailbox one']);
    fs.writeFileSync(target, 'upstream\n');
    await execGit(fix.rootPath, ['commit', '-am', 'mailbox two']);
    const mailbox = await execGit(fix.rootPath, [
      'format-patch',
      `${fix.defaultBranch}..upstream-work`,
      '--stdout',
    ]);
    const mailboxPath = path.join(fix.rootPath, '..', 'mailbox.patch');
    fs.writeFileSync(mailboxPath, mailbox.stdout);

    // Local colliding change on the default branch.
    await execGit(fix.rootPath, ['checkout', fix.defaultBranch]);
    fs.writeFileSync(target, 'local\n');
    await execGit(fix.rootPath, ['commit', '-am', 'local change']);
    const localHead = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();

    const repo = await useFixtureWorkspace(fix.rootPath);

    const res = await getServices()!.patchService.applyPatch(repo, {
      patchPath: mailboxPath,
      useAm: true,
    });

    assert.strictEqual(res.success, false, 'the mailbox apply must fail on commit 2');
    assert.strictEqual(
      res.amSessionActive,
      true,
      `the result must report the paused am session; stderr: ${res.stderr ?? ''}`
    );
    assert.ok(
      fs.existsSync(path.join(rebaseApplyDir(), 'applying')),
      'git must have left rebase-apply/applying on disk'
    );

    // The masquerade pin (K-F5-2 as automation): the repo state must read
    // as a patch apply, never as a rebase.
    const services = getServices()!;
    const fresh = (await services.gitService.reloadRepository(repo)) ?? repo;
    assert.strictEqual(fresh.inProgress?.kind, 'applying', 'kind must be the am session');
    assert.notStrictEqual(fresh.inProgress?.kind, 'rebasing');

    return { repo, localHead, target };
  }

  it('git am failure pauses as kind "applying"; intellig.am.abort restores the pre-apply state', async () => {
    const { localHead, target } = await setupPausedAmSession();
    stubs = stubPrompts({
      warningMessage: (message) =>
        message.startsWith('Abort the patch apply?') ? 'Abort' : undefined,
    });

    await vscode.commands.executeCommand('intellig.am.abort');

    assert.ok(
      !fs.existsSync(rebaseApplyDir()),
      `abort must clear the am session; errors: ${JSON.stringify(stubs.errorMessageCalls)}`
    );
    const head = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.strictEqual(head, localHead, 'abort must roll back the partially-applied mailbox');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'local\n');
  });

  it('intellig.am.continue finishes the session after the conflict is resolved', async () => {
    const { target } = await setupPausedAmSession();
    stubs = stubPrompts({});

    // Resolve the conflict in favour of the mailbox and stage it.
    fs.writeFileSync(target, 'upstream\n');
    await execGit(fix.rootPath, ['add', 'target.txt']);

    await vscode.commands.executeCommand('intellig.am.continue');

    assert.ok(
      !fs.existsSync(rebaseApplyDir()),
      `continue must end the am session; errors: ${JSON.stringify(stubs.errorMessageCalls)}`
    );
    const subjects = (await execGit(fix.rootPath, ['log', '--format=%s'])).stdout;
    assert.ok(subjects.includes('mailbox one'), `commit 1 must be applied; log: ${subjects}`);
    assert.ok(subjects.includes('mailbox two'), `commit 2 must be applied; log: ${subjects}`);
  });

  it('intellig.am.skip drops the failing patch and keeps the rest', async () => {
    const { target } = await setupPausedAmSession();
    stubs = stubPrompts({
      warningMessage: (message) => (message.startsWith('Skip this patch?') ? 'Skip' : undefined),
    });

    await vscode.commands.executeCommand('intellig.am.skip');

    assert.ok(
      !fs.existsSync(rebaseApplyDir()),
      `skip must end the am session; errors: ${JSON.stringify(stubs.errorMessageCalls)}`
    );
    const subjects = (await execGit(fix.rootPath, ['log', '--format=%s'])).stdout;
    assert.ok(subjects.includes('mailbox one'), `commit 1 must be applied; log: ${subjects}`);
    assert.ok(!subjects.includes('mailbox two'), `commit 2 must be skipped; log: ${subjects}`);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'local\n');
  });

  it('am recovery commands refuse politely when no am session is in progress', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.am.continue');

    assert.ok(
      stubs.informationMessageCalls.some((c) =>
        String(c.message).includes('only available while a patch apply')
      ),
      `expected the refusal toast; info: ${JSON.stringify(stubs.informationMessageCalls)}, errors: ${JSON.stringify(stubs.errorMessageCalls)}`
    );
    assert.strictEqual(stubs.errorMessageCalls.length, 0);
  });
});

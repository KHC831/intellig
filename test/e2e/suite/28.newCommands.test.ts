/**
 * R9-3 — real-git e2e for the 0.2.11 command surfaces:
 *
 *   - `intellig.conflict.unresolve` — a RESOLVED file goes back to
 *     conflicted (`git checkout --merge`, resolve-undo data), asserted on
 *     the index (`ls-files -u`), not on toasts.
 *   - `intellig.branch.removeWorktree` — the picker flow removes a linked
 *     worktree from disk and from `git worktree list`; the same picker's
 *     prune item cleans a stale record after a manual directory delete.
 *   - Remotes backend round-trip (add → rename → set-url → remove) against
 *     a real repo — the git side of the Configure Remotes wizard (the
 *     wizard's prompt flow is unit-tested; the argv contract is what needs
 *     a real git).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';
import { getServices } from '../support/activatedExtension';

describe('e2e — 0.2.11 command surfaces (real git state)', function () {
  this.timeout(60_000);

  let fix: Fixture;
  let stubs: PromptStubs | undefined;

  afterEach(async () => {
    if (stubs) {
      stubs.restore();
      stubs = undefined;
    }
    await clearWorkspace();
    await fix?.cleanup();
  });

  it('intellig.conflict.unresolve — sends a resolved file back to conflicted', async () => {
    fix = await createFixtureRepo();
    const file = path.join(fix.rootPath, 'clash.txt');

    // Build a real merge conflict: main and feature both rewrite clash.txt.
    fs.writeFileSync(file, 'base\n');
    await execGit(fix.rootPath, ['add', '.']);
    await execGit(fix.rootPath, ['commit', '-m', 'base']);
    await execGit(fix.rootPath, ['checkout', '-b', 'feature']);
    fs.writeFileSync(file, 'feature side\n');
    await execGit(fix.rootPath, ['commit', '-am', 'feature edit']);
    await execGit(fix.rootPath, ['checkout', fix.defaultBranch]);
    fs.writeFileSync(file, 'main side\n');
    await execGit(fix.rootPath, ['commit', '-am', 'main edit']);
    const merge = await execGit(fix.rootPath, ['merge', 'feature'], { allowNonZero: true });
    assert.notStrictEqual(merge.exitCode, 0, 'merge must conflict');

    // Resolve it (stage the file) — conflict gone, resolve-undo recorded.
    fs.writeFileSync(file, 'resolved\n');
    await execGit(fix.rootPath, ['add', 'clash.txt']);
    const resolved = await execGit(fix.rootPath, ['ls-files', '-u']);
    assert.strictEqual(resolved.stdout.trim(), '', 'file must be resolved before un-resolve');

    // Register the repo AFTER the merge started so inProgress is current.
    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.conflict.unresolve', vscode.Uri.file(file), [
      vscode.Uri.file(file),
    ]);

    const unmerged = await execGit(fix.rootPath, ['ls-files', '-u']);
    assert.ok(
      unmerged.stdout.includes('clash.txt'),
      `clash.txt must be conflicted again; errors=${JSON.stringify(stubs.errorMessageCalls)}`
    );
  });

  it('intellig.branch.removeWorktree — removes a linked worktree, then prunes a stale one', async () => {
    fix = await createFixtureRepo();
    await useFixtureWorkspace(fix.rootPath);

    const wtPath = path.join(path.dirname(fix.rootPath), 'wt-removable');
    await execGit(fix.rootPath, ['worktree', 'add', '-b', 'wt-branch', wtPath, 'HEAD']);
    assert.ok(fs.existsSync(wtPath), 'worktree dir must exist');

    // Pick the linked worktree row, confirm the modal.
    stubs = stubPrompts({
      quickPick: (items: unknown) =>
        (items as Array<{ label: string }>).find((i) => i.label.includes('wt-branch')),
      warningMessage: () => 'Remove',
    });
    await vscode.commands.executeCommand('intellig.branch.removeWorktree');

    assert.ok(!fs.existsSync(wtPath), 'worktree dir must be deleted');
    const listAfterRemove = await execGit(fix.rootPath, ['worktree', 'list', '--porcelain']);
    assert.ok(
      !listAfterRemove.stdout.includes('wt-removable'),
      `worktree must leave the list; errors=${JSON.stringify(stubs.errorMessageCalls)}`
    );
    stubs.restore();

    // Stale record: delete a worktree dir manually, then prune via the picker.
    const stalePath = path.join(path.dirname(fix.rootPath), 'wt-stale');
    await execGit(fix.rootPath, ['worktree', 'add', '-b', 'wt-stale-branch', stalePath, 'HEAD']);
    fs.rmSync(stalePath, { recursive: true, force: true });
    stubs = stubPrompts({
      quickPick: (items: unknown) =>
        (items as Array<{ label: string }>).find((i) => /prune/i.test(i.label)),
      warningMessage: () => 'Prune Worktrees',
    });
    await vscode.commands.executeCommand('intellig.branch.removeWorktree');

    const listAfterPrune = await execGit(fix.rootPath, ['worktree', 'list', '--porcelain']);
    assert.ok(
      !listAfterPrune.stdout.includes('wt-stale'),
      `stale record must be pruned; errors=${JSON.stringify(stubs.errorMessageCalls)}`
    );
  });

  it('remotes backend — add, rename, set-url, remove round-trip on a real repo', async () => {
    fix = await createFixtureRepo();
    const repo = await useFixtureWorkspace(fix.rootPath);
    const services = getServices();
    assert.ok(services, 'services must be initialised');
    const git = services.gitService;

    const url1 = 'https://example.com/one.git';
    const url2 = 'https://example.com/two.git';

    (await git.addRemote(repo, 'upstream', url1))._unsafeUnwrap();
    let remotes = (await execGit(fix.rootPath, ['remote', '-v'])).stdout;
    assert.ok(remotes.includes('upstream') && remotes.includes(url1), remotes);

    (await git.renameRemote(repo, 'upstream', 'mirror'))._unsafeUnwrap();
    (await git.setRemoteUrl(repo, 'mirror', url2))._unsafeUnwrap();
    remotes = (await execGit(fix.rootPath, ['remote', '-v'])).stdout;
    assert.ok(!remotes.includes('upstream'), 'old name must be gone');
    assert.ok(remotes.includes('mirror') && remotes.includes(url2), remotes);

    (await git.removeRemote(repo, 'mirror'))._unsafeUnwrap();
    remotes = (await execGit(fix.rootPath, ['remote', '-v'])).stdout;
    assert.strictEqual(remotes.trim(), '', 'all remotes must be gone');
  });
});

/**
 * Tier-2 E2E — rebase commands.
 *
 * Covers:
 *   - `intellig.rebase.skip` — called mid-rebase; must skip the conflicting
 *                              commit. The command prompts a Skip/Cancel
 *                              warning; we stub it to 'Skip'.
 *
 * We set up a real mid-rebase state by creating two divergent branches that
 * touch the same file, then running `git rebase` to provoke a conflict
 * before the command fires. `git status` is asserted pre- and post-command
 * to confirm state transitions.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';

describe('e2e — rebase commands', function () {
  this.timeout(20_000);

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

  /** Set up a repo that is mid-rebase with a conflict on `shared.txt`. */
  async function setupMidRebaseConflict(): Promise<Fixture> {
    const f = await createFixtureRepo({ commits: 1 });
    const sharedPath = path.join(f.rootPath, 'shared.txt');

    // Base commit on main.
    fs.writeFileSync(sharedPath, 'base\n');
    await execGit(f.rootPath, ['add', 'shared.txt']);
    await execGit(f.rootPath, ['commit', '-m', 'add shared.txt']);

    // Feature branch modifies shared.txt.
    await execGit(f.rootPath, ['checkout', '-b', 'feature']);
    fs.writeFileSync(sharedPath, 'feature change\n');
    await execGit(f.rootPath, ['commit', '-am', 'feature: modify shared.txt']);

    // Back to main, conflicting change.
    await execGit(f.rootPath, ['checkout', f.defaultBranch]);
    fs.writeFileSync(sharedPath, 'main change\n');
    await execGit(f.rootPath, ['commit', '-am', 'main: modify shared.txt']);

    // Switch to feature and rebase onto main — this will conflict.
    await execGit(f.rootPath, ['checkout', 'feature']);
    await execGit(f.rootPath, ['rebase', f.defaultBranch], { allowNonZero: true });

    // Assert we're now mid-rebase.
    const gitDir = path.join(f.rootPath, '.git');
    assert.ok(
      fs.existsSync(path.join(gitDir, 'rebase-apply')) ||
        fs.existsSync(path.join(gitDir, 'rebase-merge')),
      'fixture: expected rebase-apply or rebase-merge directory mid-rebase'
    );
    return f;
  }

  it('intellig.rebase.skip — skips the conflicting commit and leaves the rebase clean', async () => {
    fix = await setupMidRebaseConflict();
    await useFixtureWorkspace(fix.rootPath);

    // Stub the "Skip?" warning modal to answer 'Skip'.
    stubs = stubPrompts({
      warningMessage: (_msg, _opts, ...items) => {
        // IntelliG passes a single 'Skip' action item.
        const skip = items.find((i) => i === 'Skip');
        return (skip as string) ?? undefined;
      },
    });

    await vscode.commands.executeCommand('intellig.rebase.skip');

    // After `rebase --skip` on a single-conflict fixture, the rebase should
    // have completed (or advanced) — the `rebase-apply`/`rebase-merge` dir
    // is gone in the single-commit case.
    const gitDir = path.join(fix.rootPath, '.git');
    const stillRebasing =
      fs.existsSync(path.join(gitDir, 'rebase-apply')) ||
      fs.existsSync(path.join(gitDir, 'rebase-merge'));
    assert.strictEqual(
      stillRebasing,
      false,
      'rebase.skip on a single-commit rebase should finish the rebase'
    );

    // `shared.txt` should contain the main-branch version since we skipped
    // the feature commit.
    const final = fs.readFileSync(path.join(fix.rootPath, 'shared.txt'), 'utf8');
    assert.strictEqual(
      final,
      'main change\n',
      'rebase.skip should discard the feature commit content'
    );
  });

  it('intellig.rebase.skip — no-op when not mid-rebase (and does not throw)', async () => {
    fix = await createFixtureRepo({ commits: 2 });
    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    // Command surfaces an informational toast and returns. We just verify
    // it doesn't throw or mutate the repo.
    const before = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();
    await vscode.commands.executeCommand('intellig.rebase.skip');
    const after = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.strictEqual(before, after, 'rebase.skip must not mutate HEAD when no rebase is active');
  });
});

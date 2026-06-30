/**
 * Tier-2 E2E — conflict-resolution commands (real git).
 *
 * Exercises the conflict-workflow correctness fixes end-to-end through the
 * registered commands, asserting on real git state:
 *
 *   - `intellig.conflict.acceptAllCurrent` / `acceptAllIncoming` swap ours and
 *     theirs during a REBASE (git puts the user's own commit on stage 3), so
 *     "Accept All Current" must keep the user's work and "Accept All Incoming"
 *     the upstream side — matching IntelliJ `GitMergeUtil.isReverseRoot`.
 *   - During a MERGE the same commands must NOT swap (current = ours = stage 2).
 *   - `intellig.merge.openMergeView` injects a synthetic stage-1 base for an
 *     add/add conflict (no common ancestor) so VS Code's native merge editor
 *     can show a real diff instead of the whole file on both sides.
 *
 * The Resolve Conflicts dialog itself is a webview and not driven here; these
 * tests cover the command + git-state layer the dialog and palette share.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';
import { getServices } from '../support/activatedExtension';

describe('e2e — conflict resolution commands', function () {
  this.timeout(30_000);

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

  /** Count stage entries (1/2/3) reported by `git ls-files -u <file>`. */
  async function unmergedStages(root: string, file: string): Promise<Set<number>> {
    const out = (await execGit(root, ['ls-files', '-u', '--', file])).stdout;
    const stages = new Set<number>();
    for (const line of out.split('\n')) {
      const m = line.match(/\s([123])\t/);
      if (m) {
        stages.add(Number(m[1]));
      }
    }
    return stages;
  }

  /**
   * Leave the repo mid-rebase of `feature` onto the default branch with a
   * conflict on `shared.txt`. The user's own commit content is `feature change`
   * (lands on stage 3 during a rebase); the upstream content is `main change`
   * (stage 2).
   */
  async function setupMidRebaseConflict(): Promise<Fixture> {
    const f = await createFixtureRepo({ commits: 1 });
    const shared = path.join(f.rootPath, 'shared.txt');

    fs.writeFileSync(shared, 'base\n');
    await execGit(f.rootPath, ['add', 'shared.txt']);
    await execGit(f.rootPath, ['commit', '-m', 'add shared.txt']);

    await execGit(f.rootPath, ['checkout', '-b', 'feature']);
    fs.writeFileSync(shared, 'feature change\n');
    await execGit(f.rootPath, ['commit', '-am', 'feature: modify shared.txt']);

    await execGit(f.rootPath, ['checkout', f.defaultBranch]);
    fs.writeFileSync(shared, 'main change\n');
    await execGit(f.rootPath, ['commit', '-am', 'main: modify shared.txt']);

    await execGit(f.rootPath, ['checkout', 'feature']);
    await execGit(f.rootPath, ['rebase', f.defaultBranch], { allowNonZero: true });

    const gitDir = path.join(f.rootPath, '.git');
    assert.ok(
      fs.existsSync(path.join(gitDir, 'rebase-apply')) ||
        fs.existsSync(path.join(gitDir, 'rebase-merge')),
      'fixture: expected to be mid-rebase'
    );
    return f;
  }

  it("acceptAllCurrent during a rebase keeps the user's own work (ours/theirs swapped)", async () => {
    fix = await setupMidRebaseConflict();
    const repo = await useFixtureWorkspace(fix.rootPath);
    await getServices()?.gitService.reloadRepository(repo);
    assert.strictEqual(repo.state, 'rebasing', 'sanity: extension sees a rebase in progress');

    stubs = stubPrompts({
      warningMessage: (_m, _o, ...items) =>
        (items.find((i) => i === 'Accept All Current') as string) ?? undefined,
    });

    await vscode.commands.executeCommand('intellig.conflict.acceptAllCurrent');

    assert.strictEqual(
      fs.readFileSync(path.join(fix.rootPath, 'shared.txt'), 'utf8'),
      'feature change\n',
      "Accept All Current during a rebase must keep the user's own commit, not upstream"
    );
  });

  it('acceptAllIncoming during a rebase keeps the upstream side (ours/theirs swapped)', async () => {
    fix = await setupMidRebaseConflict();
    const repo = await useFixtureWorkspace(fix.rootPath);
    await getServices()?.gitService.reloadRepository(repo);
    assert.strictEqual(repo.state, 'rebasing', 'sanity: extension sees a rebase in progress');

    stubs = stubPrompts({
      warningMessage: (_m, _o, ...items) =>
        (items.find((i) => i === 'Accept All Incoming') as string) ?? undefined,
    });

    await vscode.commands.executeCommand('intellig.conflict.acceptAllIncoming');

    assert.strictEqual(
      fs.readFileSync(path.join(fix.rootPath, 'shared.txt'), 'utf8'),
      'main change\n',
      'Accept All Incoming during a rebase must take the upstream content'
    );
  });

  it('acceptAllCurrent during a MERGE takes ours (no swap)', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    const shared = path.join(fix.rootPath, 'shared.txt');

    fs.writeFileSync(shared, 'base\n');
    await execGit(fix.rootPath, ['add', 'shared.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'add shared.txt']);

    await execGit(fix.rootPath, ['checkout', '-b', 'feature']);
    fs.writeFileSync(shared, 'feature change\n');
    await execGit(fix.rootPath, ['commit', '-am', 'feature change']);

    await execGit(fix.rootPath, ['checkout', fix.defaultBranch]);
    fs.writeFileSync(shared, 'main change\n');
    await execGit(fix.rootPath, ['commit', '-am', 'main change']);

    // Merge feature INTO main → ours (stage 2) is the main side.
    await execGit(fix.rootPath, ['merge', 'feature'], { allowNonZero: true });

    const repo = await useFixtureWorkspace(fix.rootPath);
    await getServices()?.gitService.reloadRepository(repo);
    assert.strictEqual(repo.state, 'merging', 'sanity: extension sees a merge in progress');

    stubs = stubPrompts({
      warningMessage: (_m, _o, ...items) =>
        (items.find((i) => i === 'Accept All Current') as string) ?? undefined,
    });

    await vscode.commands.executeCommand('intellig.conflict.acceptAllCurrent');

    assert.strictEqual(
      fs.readFileSync(shared, 'utf8'),
      'main change\n',
      'Accept All Current during a merge must take ours (the current branch)'
    );
  });

  it('openMergeView injects a synthetic stage-1 base for an add/add conflict', async () => {
    fix = await createFixtureRepo({ commits: 1 });
    const newFile = path.join(fix.rootPath, 'added.txt');

    // Both branches ADD `added.txt` with different content → add/add (no base).
    await execGit(fix.rootPath, ['checkout', '-b', 'feature']);
    fs.writeFileSync(newFile, 'l1\nFEATURE\nl3\n');
    await execGit(fix.rootPath, ['add', 'added.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'feature adds added.txt']);

    await execGit(fix.rootPath, ['checkout', fix.defaultBranch]);
    fs.writeFileSync(newFile, 'l1\nMAIN\nl3\n');
    await execGit(fix.rootPath, ['add', 'added.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'main adds added.txt']);

    await execGit(fix.rootPath, ['merge', 'feature'], { allowNonZero: true });

    // Precondition: an add/add conflict has stages 2 and 3 but NO stage 1.
    const before = await unmergedStages(fix.rootPath, 'added.txt');
    assert.deepStrictEqual([...before].sort(), [2, 3], 'fixture: add/add has only stages 2 and 3');

    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.merge.openMergeView', vscode.Uri.file(newFile));

    // The native editor needs a base; show() must have injected a synthetic
    // stage-1 so all three stages are now present.
    const after = await unmergedStages(fix.rootPath, 'added.txt');
    assert.ok(after.has(1), 'openMergeView must inject a synthetic stage-1 base for add/add');
    assert.ok(after.has(2) && after.has(3), 'ours/theirs stages must be preserved');

    // Stage 1 equals the conflict-marked working file (IntelliJ loadMergeData
    // fallback) — so it carries markers and is not a real ancestor.
    const stage1 = (await execGit(fix.rootPath, ['show', ':1:added.txt'])).stdout;
    assert.ok(stage1.includes('<<<<<<<'), 'synthetic base is the conflict-marked working file');
  });
});

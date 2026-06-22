/**
 * Tier-2 E2E — rebase recovery commands `intellig.rebase.abort` and
 * `intellig.rebase.continue`, exercised against a REAL in-progress (conflicted)
 * rebase.
 *
 * Both resolve the repo via resolveRepo and gate on the repository being in the
 * 'rebasing' state, then run git directly. We create a genuine conflict, pause
 * the rebase, reload so the cached repo reports 'rebasing', then assert real git
 * (the rebase metadata is gone afterwards; abort restores the branch tip,
 * continue completes the rebase).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getServices } from '../support/activatedExtension';

describe('e2e — rebase recovery (real in-progress rebase)', function () {
  this.timeout(40_000);

  let fix: Fixture;
  let stubs: PromptStubs;

  /** Drain the extension's in-flight repo reloads so they don't hold .git locks. */
  async function drain(): Promise<void> {
    const gs = getServices()!.gitService as unknown as {
      _drainPendingReloads?: () => Promise<void>;
    };
    await gs._drainPendingReloads?.();
  }

  /**
   * The live repo watcher reacts to the heavy `.git/` churn of a rebase and can
   * hold `index.lock` (a concurrent `git status` refresh) exactly when the test
   * issues its own mutating git command. Drain first, then retry on a transient
   * lock so the suite doesn't flake.
   */
  async function gitMutate(args: string[]): Promise<void> {
    await drain();
    for (let attempt = 0; ; attempt++) {
      try {
        await execGit(fix.rootPath, args);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < 10 && /index\.lock/.test(msg)) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        throw err;
      }
    }
  }

  const file0 = (): string => path.join(fix.rootPath, 'file0.txt');
  const rebaseInProgress = (): boolean =>
    fs.existsSync(path.join(fix.rootPath, '.git', 'rebase-merge')) ||
    fs.existsSync(path.join(fix.rootPath, '.git', 'rebase-apply'));
  const currentBranch = async (): Promise<string> =>
    (await execGit(fix.rootPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();

  /** Build a conflicted, paused rebase and reload so the repo reports 'rebasing'. */
  async function startConflictingRebase(): Promise<void> {
    const base = await currentBranch();
    await gitMutate(['checkout', '-b', 'feature']);
    fs.writeFileSync(file0(), 'feature side\n');
    await gitMutate(['add', 'file0.txt']);
    await gitMutate(['commit', '-m', 'feature change']);
    await gitMutate(['checkout', base]);
    fs.writeFileSync(file0(), 'main side\n');
    await gitMutate(['add', 'file0.txt']);
    await gitMutate(['commit', '-m', 'main change']);
    await gitMutate(['checkout', 'feature']);
    await drain();
    try {
      await execGit(fix.rootPath, ['rebase', base]); // conflicts → non-zero
    } catch {
      // expected: the rebase pauses on the conflict
    }
    assert.ok(rebaseInProgress(), 'fixture: rebase should be paused on a conflict');
    const gitService = getServices()!.gitService;
    await gitService.reloadRepository(gitService.getRepositories()[0]);
    // The rebase churned .git; the repo watcher has a ~250ms-debounced reload
    // SCHEDULED (not yet fired), which would otherwise hold index.lock midway
    // through the command's own `git rebase --continue/--abort`. Wait past the
    // debounce, then drain, so the watcher reload fires and settles BEFORE the
    // command runs — leaving the command a clean lock.
    await new Promise((r) => setTimeout(r, 600));
    await drain();
  }

  beforeEach(async () => {
    fix = await createFixtureRepo({ commits: 2 });
    await useFixtureWorkspace(fix.rootPath);
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (stubs) {
      stubs.restore();
    }
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  it('intellig.rebase.abort — restores the pre-rebase branch state', async () => {
    await startConflictingRebase();
    stubs = stubPrompts({ warningMessage: () => 'Abort' });

    await drain();
    await vscode.commands.executeCommand('intellig.rebase.abort');

    assert.ok(
      !rebaseInProgress(),
      `rebase metadata should be gone; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
    assert.strictEqual(await currentBranch(), 'feature', 'abort should restore the feature branch');
  });

  it('intellig.rebase.continue — completes the rebase after the conflict is resolved', async () => {
    await startConflictingRebase();
    // Resolve the conflict and stage it.
    fs.writeFileSync(file0(), 'resolved\n');
    await gitMutate(['add', 'file0.txt']);
    // `git rebase --continue` may open the commit-message editor; make it a no-op.
    const prevEditor = process.env.GIT_EDITOR;
    process.env.GIT_EDITOR = 'true';
    stubs = stubPrompts({});

    try {
      await drain();
      await vscode.commands.executeCommand('intellig.rebase.continue');
    } finally {
      if (prevEditor === undefined) {
        delete process.env.GIT_EDITOR;
      } else {
        process.env.GIT_EDITOR = prevEditor;
      }
    }

    assert.ok(
      !rebaseInProgress(),
      `rebase should be complete; err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
    assert.strictEqual(
      fs.readFileSync(file0(), 'utf8'),
      'resolved\n',
      'the resolved content should be committed'
    );
  });
});

/**
 * Tier-2 E2E — commit-context commands that mutate the working tree or HEAD.
 *
 * Covers:
 *   - `intellig.commit.revert`           — reverts a commit via `git revert`.
 *   - `intellig.commit.checkoutRevision` — detached-HEAD checkout of a commit.
 *
 * Each test begins with a fixture at a known HEAD, runs the command, and
 * then asserts real git state post-conditions via direct `git` subprocess
 * calls — never by reading a toast or webview message.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';

describe('e2e — commit-context commands', function () {
  this.timeout(20_000);

  let fix: Fixture;
  let stubs: PromptStubs;

  afterEach(async () => {
    if (stubs) {
      stubs.restore();
    }
    clearWorkspace();
    if (fix) {
      fix.cleanup();
    }
  });

  it('intellig.commit.revert — creates a revert commit on top of HEAD that undoes the target', async () => {
    fix = await createFixtureRepo({ commits: 2 });

    // Add a third commit with a distinctive file; that's the one we'll revert.
    const toRevert = path.join(fix.rootPath, 'revert-me.txt');
    fs.writeFileSync(toRevert, 'to be reverted\n');
    await execGit(fix.rootPath, ['add', 'revert-me.txt']);
    await execGit(fix.rootPath, ['commit', '-m', 'add revert-me.txt']);
    const targetHash = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();
    const headBefore = targetHash;

    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.commit.revert', { hash: targetHash });

    // Post-conditions:
    //   1. HEAD moved forward by exactly one commit.
    //   2. The revert-me.txt file is gone from the working tree.
    const headAfter = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.notStrictEqual(
      headAfter,
      headBefore,
      'revert should create a new commit on top of HEAD'
    );

    const parent = (await execGit(fix.rootPath, ['rev-parse', 'HEAD^'])).stdout.trim();
    assert.strictEqual(
      parent,
      headBefore,
      'the new HEAD must be a direct child of the pre-revert HEAD'
    );

    assert.strictEqual(
      fs.existsSync(toRevert),
      false,
      'revert-me.txt should be absent from the working tree after a revert'
    );
  });

  it('intellig.commit.checkoutRevision — moves HEAD to the supplied hash (detached)', async () => {
    fix = await createFixtureRepo({ commits: 3 });

    const log = (await execGit(fix.rootPath, ['log', '--pretty=format:%H', '--reverse'])).stdout
      .split('\n')
      .filter(Boolean);
    const target = log[0]; // the oldest commit
    const headBefore = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.notStrictEqual(target, headBefore, 'sanity: target must differ from HEAD');

    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    await vscode.commands.executeCommand('intellig.commit.checkoutRevision', { hash: target });

    // Post-conditions: HEAD points at target (detached — it's not a branch).
    const headAfter = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();

    // Surface every recorded toast in the failure message so a regressing
    // handler's silenced error becomes visible in CI logs. Without this,
    // a silent catch-and-toast path looks identical to "command never ran"
    // — which is the exact diagnostic gap that hid the original Linux-CI
    // flake from us for two CI iterations.
    if (headAfter !== target) {
      const errors = stubs.errorMessageCalls.map((c) => `error: ${c.message}`);
      const warnings = stubs.warningMessageCalls.map((c) => `warning: ${c.message}`);
      const infos = stubs.informationMessageCalls.map((c) => `info: ${c.message}`);
      const toastTrail = [...errors, ...warnings, ...infos].join('\n  ');
      assert.fail(
        `HEAD should be at target hash; got ${headAfter}\n` +
          `  target was ${target}\n` +
          `  headBefore was ${headBefore}\n` +
          `  recorded toasts:\n  ${toastTrail || '(none)'}`
      );
    }

    // HEAD must not be on a branch. `symbolic-ref HEAD` returns non-zero for
    // detached state.
    const sym = await execGit(fix.rootPath, ['symbolic-ref', '-q', 'HEAD'], { allowNonZero: true });
    assert.notStrictEqual(sym.exitCode, 0, 'HEAD should be detached after checkoutRevision');
  });
});

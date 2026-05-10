/**
 * Tier-2 E2E — patch commands.
 *
 * Covers:
 *   - `intellig.commit.createPatch` — writes `format-patch` output to a
 *     user-selected file. We stub `showSaveDialog` to return a fixed path
 *     inside the fixture's temp dir, then assert the file exists and has
 *     the expected header fields.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';

describe('e2e — patch commands', function () {
  this.timeout(15_000);

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

  it('intellig.commit.createPatch — writes a valid format-patch file for the given commit', async () => {
    fix = await createFixtureRepo({ commits: 2 });
    const head = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();

    await useFixtureWorkspace(fix.rootPath);

    const targetPatch = path.join(fix.rootPath, 'my-fix.patch');
    stubs = stubPrompts({
      saveDialog: () => vscode.Uri.file(targetPatch),
    });

    await vscode.commands.executeCommand('intellig.commit.createPatch', { hash: head });

    assert.strictEqual(fs.existsSync(targetPatch), true, `expected patch file at ${targetPatch}`);
    const content = fs.readFileSync(targetPatch, 'utf8');
    // Format-patch output starts with `From <hash>` and contains Subject:.
    assert.ok(
      /^From [0-9a-f]{40}/.test(content),
      `patch should start with "From <40-hex>"; got first line: "${content.split('\n')[0]}"`
    );
    assert.ok(content.includes('Subject:'), 'patch should include a Subject: header');
  });

  it('intellig.commit.createPatch — no file is written when the user cancels the save dialog', async () => {
    fix = await createFixtureRepo({ commits: 2 });
    const head = (await execGit(fix.rootPath, ['rev-parse', 'HEAD'])).stdout.trim();

    await useFixtureWorkspace(fix.rootPath);

    stubs = stubPrompts({
      saveDialog: () => undefined,
    });

    // Run the command and then snapshot the fixture root to confirm no
    // `.patch` leaked.
    await vscode.commands.executeCommand('intellig.commit.createPatch', { hash: head });

    const entries = fs.readdirSync(fix.rootPath).filter((e) => e.endsWith('.patch'));
    assert.deepStrictEqual(
      entries,
      [],
      `no .patch file should be written on cancel; got: ${entries.join(', ')}`
    );
  });
});

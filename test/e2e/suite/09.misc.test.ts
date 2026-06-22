/**
 * Tier-2 E2E — miscellaneous no-argument palette commands.
 *
 * Covers a cluster of light-weight commands that don't need a commit arg or
 * a prompt stub. These are the commands a user most often discovers via the
 * command palette; we run each one end-to-end against a real repo and
 * assert they don't throw.
 *
 *   - `intellig.openGitToolWindow`
 *   - `intellig.toolWindow.focusTab`               (focus each valid tab id)
 *   - `intellig.blame.toggleIgnoreWhitespace`
 *   - `intellig.blame.toggleDetectMovementsWithinFile`
 *   - `intellig.blame.toggleDetectMovementsAcrossFiles`
 *   - `intellig.blame.clearHiddenRevisions`
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

import { createFixtureRepo, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';
import { getServices } from '../support/activatedExtension';

describe('e2e — miscellaneous palette commands', function () {
  this.timeout(15_000);

  let fix: Fixture;
  let stubs: PromptStubs;

  beforeEach(async () => {
    fix = await createFixtureRepo({ commits: 1 });
    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});
  });

  afterEach(async () => {
    stubs.restore();
    await clearWorkspace();
    await fix.cleanup();
  });

  it('intellig.openGitToolWindow — focuses the tool window without throwing', async () => {
    await vscode.commands.executeCommand('intellig.openGitToolWindow');
    // No throw = success. VS Code's view-focus API does not expose an
    // "is focused" boolean.
  });

  it('intellig.toolWindow.focusTab — accepts each valid tab id without throwing', async () => {
    // Open first so the provider is live.
    await vscode.commands.executeCommand('intellig.openGitToolWindow');
    // `updateInfo` and 'history' are later additions.
    const validTabs = ['log', 'console', 'incoming', 'updateInfo', 'history'];
    for (const tab of validTabs) {
      await vscode.commands.executeCommand('intellig.toolWindow.focusTab', tab);
    }
  });

  it('intellig.toolWindow.focusTab — silently ignores unknown tab ids', async () => {
    await vscode.commands.executeCommand('intellig.openGitToolWindow');
    // The command validates against an allowlist; unknown ids are a no-op,
    // not a throw.
    await vscode.commands.executeCommand('intellig.toolWindow.focusTab', 'not-a-real-tab');
  });

  it('intellig.blame.toggleIgnoreWhitespace — flips the persisted flag', async () => {
    const services = getServices();
    assert.ok(services);
    const before = services.blameOptionsSource.snapshot().ignoreWhitespace;

    await vscode.commands.executeCommand('intellig.blame.toggleIgnoreWhitespace');
    const after = services.blameOptionsSource.snapshot().ignoreWhitespace;

    assert.strictEqual(after, !before, 'ignoreWhitespace flag should flip after toggle');

    // Flip back so we don't leak state into later tests.
    await vscode.commands.executeCommand('intellig.blame.toggleIgnoreWhitespace');
    const restored = services.blameOptionsSource.snapshot().ignoreWhitespace;
    assert.strictEqual(restored, before, 'restore toggle should return to original');
  });

  it('intellig.blame.toggleDetectMovementsWithinFile — flips the persisted flag', async () => {
    const services = getServices();
    assert.ok(services);
    const before = services.blameOptionsSource.snapshot().detectMovementsWithinFile;
    await vscode.commands.executeCommand('intellig.blame.toggleDetectMovementsWithinFile');
    const after = services.blameOptionsSource.snapshot().detectMovementsWithinFile;
    assert.strictEqual(after, !before, 'detectMovementsWithinFile flag should flip');
    // Restore.
    await vscode.commands.executeCommand('intellig.blame.toggleDetectMovementsWithinFile');
  });

  it('intellig.blame.toggleDetectMovementsAcrossFiles — flips the persisted flag', async () => {
    const services = getServices();
    assert.ok(services);
    const before = services.blameOptionsSource.snapshot().detectMovementsAcrossFiles;
    await vscode.commands.executeCommand('intellig.blame.toggleDetectMovementsAcrossFiles');
    const after = services.blameOptionsSource.snapshot().detectMovementsAcrossFiles;
    assert.strictEqual(after, !before, 'detectMovementsAcrossFiles flag should flip');
    await vscode.commands.executeCommand('intellig.blame.toggleDetectMovementsAcrossFiles');
  });

  it('intellig.blame.clearHiddenRevisions — empties the hidden-revisions set without throwing', async () => {
    // No observable mutation if there's nothing hidden yet; the test simply
    // verifies the command path completes — which is the more common
    // failure mode (uncaught rejection inside `clearHiddenRevisions`).
    await vscode.commands.executeCommand('intellig.blame.clearHiddenRevisions');
  });
});

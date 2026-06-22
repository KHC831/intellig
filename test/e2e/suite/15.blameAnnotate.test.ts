/**
 * Tier-2 E2E — "Annotate with Git Blame" (`intellig.toggleBlame`).
 *
 * The shipped bug: the handler took no argument, so the explorer's
 * right-clicked file URI was ignored — it never opened or targeted that file
 * and only flipped single-line inline blame on whatever editor was last
 * active. The user saw the "...enabled" toast but no annotation. Asserting the
 * toast alone would NOT catch it; the toast fired in the broken version too.
 *
 * So this test asserts the REAL behaviour: invoking the command with a file URI
 * must open/target that file and drive the gutter-annotation blame fetch for
 * it. We observe it by spying on the blame service (reached through the running
 * extension's `getServices()`): the gutter provider's render path calls
 * `getBlame(repo, <repo-relative path>)` only after the file is opened,
 * targeted, the repo resolved, and the annotation-style gate passed — exactly
 * the chain the bug short-circuited. Real git, committed fixture file, so blame
 * resolves real lines.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

import { Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace } from '../support/workspaceHelper';
import { setupNestedFixture } from '../support/nestedFixture';
import { getServices } from '../support/activatedExtension';
import type { IBlameService } from '../../../src/blame/interfaces/IBlameService';

/** Poll `predicate` until true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('e2e — Annotate with Git Blame (real git, real blame fetch)', function () {
  this.timeout(20_000);

  let fix: Fixture;
  let uriFor: (rel: string) => vscode.Uri;
  let stubs: PromptStubs;

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

  it('intellig.toggleBlame — opens the file and fetches blame for it (gutter annotation path)', async () => {
    const nested = await setupNestedFixture();
    fix = nested.fix;
    uriFor = nested.uriFor;
    stubs = stubPrompts({});

    const services = getServices();
    assert.ok(services, 'extension services must be initialised');
    const blameService = services.blameService;

    // Spy the blame fetch: the gutter render path reaches it only after the
    // command opens + targets the file, resolves the repo, and passes the
    // annotation-style gate. In the buggy version the file URI was ignored, so
    // blame for file0.txt would never be fetched via this command.
    const blamedPaths: string[] = [];
    const origGetBlame = blameService.getBlame.bind(blameService);
    (blameService as unknown as { getBlame: IBlameService['getBlame'] }).getBlame = ((
      ...args: Parameters<IBlameService['getBlame']>
    ) => {
      blamedPaths.push(args[1]);
      return origGetBlame(...args);
    }) as IBlameService['getBlame'];

    try {
      await vscode.commands.executeCommand('intellig.toggleBlame', uriFor('file0.txt'));

      // If a prior run left annotation enabled, the first invocation toggled it
      // OFF (no blame fetch) — turn it back on so we observe the enable path.
      const lastToast = stubs.informationMessageCalls[stubs.informationMessageCalls.length - 1];
      if (lastToast && /disabled/i.test(lastToast.message)) {
        await vscode.commands.executeCommand('intellig.toggleBlame', uriFor('file0.txt'));
      }

      // enable() schedules the blame fetch asynchronously (not awaited by the
      // command), so poll until blame is fetched for the targeted file.
      await waitFor(() => blamedPaths.some((p) => p.endsWith('file0.txt')), 8_000);

      assert.ok(
        blamedPaths.some((p) => p.endsWith('file0.txt')),
        `Annotate must fetch blame for the targeted file; blamed=${JSON.stringify(blamedPaths)} ` +
          `info=${JSON.stringify(stubs.informationMessageCalls.map((c) => c.message))} ` +
          `err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
      );
    } finally {
      (blameService as unknown as { getBlame: IBlameService['getBlame'] }).getBlame = origGetBlame;
      // Toggle annotation back off so it does not leak into later suites.
      await vscode.commands
        .executeCommand('intellig.toggleBlame', uriFor('file0.txt'))
        .then(undefined, () => undefined);
    }
  });
});

/**
 * Tier-2 E2E — an external branch switch is observed by the repository watcher.
 *
 * F5 section 2 "branch switching settles": when the user switches branches the Commit
 * / graph views must update per switch. The reason `.git/HEAD` and
 * `.git/refs/**` are in the GitService watcher allow-list is precisely so an
 * external `git checkout` reaches the extension without an explicit refresh.
 *
 * This spec drives a REAL `git checkout` (no manual `reloadRepository`, unlike
 * the conflict suites which reload deterministically) and asserts the watcher
 * fires `onDidChangeRepository` with the NEW branch — twice, once per switch —
 * so a HEAD/refs watcher regression that stopped observing branch changes would
 * fail here. The "no flicker loop" half of the box is covered by the sibling
 * idle-invariant suite (12); the webview state-preservation half (message /
 * scroll survive the swap) is jsdom-unit-covered and not reachable from this
 * host lane.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';
import { getServices } from '../support/activatedExtension';

/** Canonicalize so a symlinked temp root (macOS /var → /private/var) matches. */
function realOrRaw(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

async function pollUntil(
  condition: () => boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pollUntil timed out after ${timeoutMs}ms: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('e2e — branch switch observed by the repository watcher', function () {
  this.timeout(30_000);

  let fix: Fixture;
  let stubs: PromptStubs;
  let sub: vscode.Disposable | undefined;

  afterEach(async () => {
    if (sub) {
      sub.dispose();
      sub = undefined;
    }
    if (stubs) {
      stubs.restore();
    }
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  it('a real git checkout fires onDidChangeRepository with the new branch (per switch, no manual reload)', async () => {
    fix = await createFixtureRepo({ commits: 2, branches: [{ name: 'feature' }] });
    const repo = await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});

    const services = getServices();
    assert.ok(services, 'extension services not available');
    const gitService = services.gitService;

    // Sanity: the extension starts on the default branch.
    assert.strictEqual(
      repo.head?.name,
      fix.defaultBranch,
      `fixture should start on ${fix.defaultBranch}`
    );

    // Record the branch reported by EACH watcher-driven repository event for our
    // fixture. No manual reloadRepository() — the file watcher on `.git/HEAD`
    // must be what surfaces the switch.
    const fixtureRoot = realOrRaw(fix.rootPath);
    const observed: Array<string | undefined> = [];
    sub = gitService.onDidChangeRepository((r) => {
      if (realOrRaw(r.rootUri.fsPath) === fixtureRoot) {
        observed.push(r.head?.name);
      }
    });

    // Switch 1: default → feature (external checkout).
    await execGit(fix.rootPath, ['checkout', 'feature']);
    await pollUntil(
      () => observed.includes('feature'),
      15_000,
      'watcher never reported the switch to `feature` (HEAD/refs watcher not observing checkouts?)'
    );

    // Switch 2: feature → default. A second observed switch pins that EACH
    // checkout is surfaced, not just the first after activation.
    const beforeSecond = observed.length;
    await execGit(fix.rootPath, ['checkout', fix.defaultBranch]);
    await pollUntil(
      () => observed.slice(beforeSecond).includes(fix.defaultBranch),
      15_000,
      `watcher never reported the switch back to \`${fix.defaultBranch}\``
    );
  });
});

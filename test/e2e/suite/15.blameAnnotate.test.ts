/**
 * Tier-2 E2E — "Annotate with Git Blame" (`intellig.toggleBlame`).
 *
 * The shipped bug: the handler took no argument, so the explorer's
 * right-clicked file URI was ignored — it never opened or targeted that file
 * and only flipped single-line inline blame on whatever editor was last
 * active. The user saw the "...enabled" toast but no annotation. Asserting the
 * toast alone would NOT catch it; the toast fired in the broken version too.
 *
 * These tests assert the REAL behaviour: invoking the command with a file URI
 * opens/targets that file and drives the gutter-annotation blame fetch for it.
 * We observe it by spying on the blame service (reached through the running
 * extension's `getServices()`): the gutter render path calls
 * `getBlame(repo, <repo-relative path>)` only after the file is opened,
 * targeted, the repo resolved, and the annotation-style gate passed — exactly
 * the chain the bug short-circuited.
 *
 * Coverage:
 *   1. single repo — blame fetched for the targeted file.
 *   2. MULTI-repo — the deepest-ancestor repo resolution must pick the right
 *      repo (the single-repo fallback can't mask a broken ancestor match here).
 *   3. untracked file — graceful: no error toast, no throw.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
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
  this.timeout(30_000);

  let fixtures: Fixture[];
  let stubs: PromptStubs;

  beforeEach(() => {
    fixtures = [];
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (stubs) {
      stubs.restore();
    }
    await clearWorkspace();
    for (const f of fixtures) {
      await f.cleanup();
    }
  });

  /**
   * Spy the blame service, invoke Annotate for `uri` (re-invoking once if a
   * prior run had left annotation enabled so the first call toggled it off),
   * poll for the blame fetch, restore the spy, and toggle annotation back off.
   * Returns the repo-relative paths blame was requested for.
   */
  async function annotateAndCollectBlamedPaths(uri: vscode.Uri): Promise<string[]> {
    const services = getServices();
    assert.ok(services, 'extension services must be initialised');
    const blameService = services.blameService;

    const blamedPaths: string[] = [];
    const origGetBlame = blameService.getBlame.bind(blameService);
    (blameService as unknown as { getBlame: IBlameService['getBlame'] }).getBlame = ((
      ...args: Parameters<IBlameService['getBlame']>
    ) => {
      blamedPaths.push(args[1]);
      return origGetBlame(...args);
    }) as IBlameService['getBlame'];

    try {
      await vscode.commands.executeCommand('intellig.toggleBlame', uri);
      const lastToast = stubs.informationMessageCalls[stubs.informationMessageCalls.length - 1];
      if (lastToast && /disabled/i.test(lastToast.message)) {
        await vscode.commands.executeCommand('intellig.toggleBlame', uri);
      }
      await waitFor(() => blamedPaths.length > 0, 8_000);
      return blamedPaths;
    } finally {
      (blameService as unknown as { getBlame: IBlameService['getBlame'] }).getBlame = origGetBlame;
      await vscode.commands
        .executeCommand('intellig.toggleBlame', uri)
        .then(undefined, () => undefined);
    }
  }

  it('opens the file and fetches blame for it (single repo)', async () => {
    const nested = await setupNestedFixture();
    fixtures.push(nested.fix);
    stubs = stubPrompts({});

    const blamed = await annotateAndCollectBlamedPaths(nested.uriFor('file0.txt'));

    assert.ok(
      blamed.some((p) => p.endsWith('file0.txt')),
      `Annotate must fetch blame for the targeted file; blamed=${JSON.stringify(blamed)} ` +
        `info=${JSON.stringify(stubs.informationMessageCalls.map((c) => c.message))} ` +
        `err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('resolves the correct repo in a MULTI-repo workspace (deepest-ancestor match)', async () => {
    // Two independent open repos. resolveBlameRepo's single-open-repo fallback
    // does not apply, so a non-empty blame fetch proves the canonicalized
    // ancestor match selected the file's repo — the path that protects
    // multi-repo and was untested.
    const repoA = await createFixtureRepo({ commits: 2 });
    const repoB = await createFixtureRepo({ commits: 2 });
    fixtures.push(repoA, repoB);
    await useFixtureWorkspace(repoA.rootPath);
    await useFixtureWorkspace(repoB.rootPath);
    stubs = stubPrompts({});

    const fileInB = vscode.Uri.file(path.join(repoB.rootPath, 'file0.txt'));
    const blamed = await annotateAndCollectBlamedPaths(fileInB);

    assert.ok(
      blamed.some((p) => p.endsWith('file0.txt')),
      `Annotate must resolve the right repo and fetch blame in a multi-repo workspace; ` +
        `blamed=${JSON.stringify(blamed)} ` +
        `err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
  });

  it('returns DISTINCT per-line commits/authors for a file edited across commits', async () => {
    // Ground-truth for the reported "every line shows the same commit" bug.
    // Build a file whose three lines were each last touched by a DIFFERENT
    // commit and author, then drive the REAL blame fetch and assert the parsed
    // result is distinct per line (hash + author + message), end to end through
    // gitCli + parseBlame in the running extension host.
    const repo = await createFixtureRepo({ commits: 1 });
    fixtures.push(repo);
    const root = repo.rootPath;

    const writeAll = (l1: string, l2: string, l3: string): void =>
      fs.writeFileSync(path.join(root, 'multi.txt'), `${l1}\n${l2}\n${l3}\n`);

    const commitAs = async (name: string, email: string, message: string): Promise<void> => {
      await execGit(root, ['add', 'multi.txt']);
      await execGit(root, [
        '-c',
        `user.name=${name}`,
        '-c',
        `user.email=${email}`,
        'commit',
        '--author',
        `${name} <${email}>`,
        '-m',
        message,
      ]);
    };

    writeAll('line one', 'line two', 'line three');
    await commitAs('Alice Ant', 'alice@x.test', 'add multi');
    writeAll('line one', 'line two EDITED', 'line three');
    await commitAs('Bob Bee', 'bob@x.test', 'edit line two');
    writeAll('line one', 'line two EDITED', 'line three EDITED');
    await commitAs('Carol Cat', 'carol@x.test', 'edit line three');

    await useFixtureWorkspace(root);
    stubs = stubPrompts({});

    const services = getServices();
    assert.ok(services, 'extension services must be initialised');
    const repos = services.gitService.getRepositories();
    const targetRepo = repos.find((r) => r.rootUri.fsPath === root) ?? repos[0];
    assert.ok(targetRepo, 'fixture repo must be open');

    const info = await services.blameService.getBlame(targetRepo, 'multi.txt');
    const byLine = new Map(info.lines.map((l) => [l.line, l]));

    assert.strictEqual(info.lines.length, 3, `expected 3 blamed lines; got ${info.lines.length}`);

    const l1 = byLine.get(1);
    const l2 = byLine.get(2);
    const l3 = byLine.get(3);
    assert.ok(l1 && l2 && l3, 'all three lines must be blamed');

    // Distinct commits per line.
    const hashes = new Set([l1.commit, l2.commit, l3.commit]);
    assert.strictEqual(
      hashes.size,
      3,
      `each line must map to a distinct commit; got ${JSON.stringify([l1.commit, l2.commit, l3.commit].map((h) => h.slice(0, 7)))}`
    );

    // Per-line author + message must match the commit that last touched it —
    // this is exactly what the per-sha porcelain parse fixes.
    assert.strictEqual(l1.author, 'Alice Ant', `line 1 author; got ${l1.author}`);
    assert.strictEqual(l2.author, 'Bob Bee', `line 2 author; got ${l2.author}`);
    assert.strictEqual(l3.author, 'Carol Cat', `line 3 author; got ${l3.author}`);
    assert.strictEqual(l1.message, 'add multi', `line 1 message; got ${l1.message}`);
    assert.strictEqual(l2.message, 'edit line two', `line 2 message; got ${l2.message}`);
    assert.strictEqual(l3.message, 'edit line three', `line 3 message; got ${l3.message}`);
  });

  /**
   * Enable gutter annotation on `uri` (toggling once more if a prior run left
   * it on), leaving annotation ENABLED.
   */
  async function enableAnnotationFor(uri: vscode.Uri): Promise<void> {
    await vscode.commands.executeCommand('intellig.toggleBlame', uri);
    const lastToast = stubs.informationMessageCalls[stubs.informationMessageCalls.length - 1];
    if (lastToast && /disabled/i.test(lastToast.message)) {
      await vscode.commands.executeCommand('intellig.toggleBlame', uri);
    }
  }

  for (const preview of [false, true]) {
    it(`re-fetches blame for the newly active file on switch (preview=${preview})`, async () => {
      // Reproduces "open a different file, still shows the previous file's
      // blame". Each fixture file was added in its OWN commit, so file1's blame
      // comes from a DIFFERENT commit than file0. With gutter annotation left
      // enabled, switching the active editor to file1 must drive a blame fetch
      // for file1 — otherwise file0's annotation persists on file1.
      const repo = await createFixtureRepo({ commits: 3 });
      fixtures.push(repo);
      await useFixtureWorkspace(repo.rootPath);
      stubs = stubPrompts({});

      const file0 = vscode.Uri.file(path.join(repo.rootPath, 'file0.txt'));
      const file1 = vscode.Uri.file(path.join(repo.rootPath, 'file1.txt'));

      await enableAnnotationFor(file0);

      try {
        const services = getServices();
        assert.ok(services, 'services');
        const blamedPaths: string[] = [];
        const origGetBlame = services.blameService.getBlame.bind(services.blameService);
        (services.blameService as unknown as { getBlame: IBlameService['getBlame'] }).getBlame = ((
          ...args: Parameters<IBlameService['getBlame']>
        ) => {
          blamedPaths.push(args[1]);
          return origGetBlame(...args);
        }) as IBlameService['getBlame'];

        try {
          const doc = await vscode.workspace.openTextDocument(file1);
          await vscode.window.showTextDocument(doc, { preview });
          await waitFor(() => blamedPaths.some((p) => p.endsWith('file1.txt')), 8_000);
        } finally {
          (services.blameService as unknown as { getBlame: IBlameService['getBlame'] }).getBlame =
            origGetBlame;
        }

        assert.ok(
          blamedPaths.some((p) => p.endsWith('file1.txt')),
          `switching to file1 must re-fetch its blame (else file0's annotation ` +
            `persists); blamed after switch=${JSON.stringify(blamedPaths)}`
        );
      } finally {
        await vscode.commands
          .executeCommand('intellig.toggleBlame', file0)
          .then(undefined, () => undefined);
      }
    });
  }

  it('handles an untracked file gracefully (no error toast)', async () => {
    const repo = await createFixtureRepo({ commits: 2 });
    fixtures.push(repo);
    await useFixtureWorkspace(repo.rootPath);
    // An untracked file: git blame yields only uncommitted lines, so the gutter
    // renders nothing — but the command must not throw or surface an error.
    fs.writeFileSync(path.join(repo.rootPath, 'untracked.txt'), 'new content\n');
    stubs = stubPrompts({});

    const uri = vscode.Uri.file(path.join(repo.rootPath, 'untracked.txt'));
    await annotateAndCollectBlamedPaths(uri);

    assert.strictEqual(
      stubs.errorMessageCalls.length,
      0,
      `annotating an untracked file must not surface an error toast; ` +
        `err=${JSON.stringify(stubs.errorMessageCalls.map((c) => c.message))}`
    );
    assert.ok(
      stubs.informationMessageCalls.some((c) => /blame annotations/i.test(c.message)),
      'the command should still report its enabled/disabled state'
    );
  });
});

/**
 * Tier-2 E2E — the Branches tree's Worktrees category, against real git.
 *
 * The rows come from the production provider (`getChildren` on the Worktrees
 * category) and every action runs through its registered command with that
 * row as the clicked item, so the spine's target extraction and repository
 * resolution are exercised as the menu would exercise them. Outcomes are read
 * from `git worktree list --porcelain` and the disk, not from toasts.
 *
 * Not covered here (still human): the menus themselves (which entries a row
 * shows is the context value's job, asserted below) and the icons' pixels.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';
import { getBranchTreeProvider } from '../support/activatedExtension';
import type { BranchTreeItem } from '../../../src/branches/BranchTreeProvider';

describe('e2e — Worktrees in the Branches tree', function () {
  this.timeout(60_000);

  let fix: Fixture;
  let stubs: PromptStubs | undefined;
  let opened: Array<{ path: string; forceNewWindow: boolean }>;
  let restoreExecute: (() => void) | undefined;

  /** `<repo>/../<name>`, the sibling folder each fixture worktree lives in. */
  const sibling = (name: string): string => path.join(path.dirname(fix.rootPath), name);

  beforeEach(async () => {
    fix = await createFixtureRepo();
    await useFixtureWorkspace(fix.rootPath);
    await execGit(fix.rootPath, ['worktree', 'add', '-b', 'wt-a', sibling('wt-normal'), 'HEAD']);
    await execGit(fix.rootPath, ['worktree', 'add', '-b', 'wt-b', sibling('wt-locked'), 'HEAD']);
    await execGit(fix.rootPath, [
      'worktree',
      'lock',
      '--reason',
      'on a USB disk',
      sibling('wt-locked'),
    ]);
    await execGit(fix.rootPath, ['worktree', 'add', '-b', 'wt-c', sibling('wt-gone'), 'HEAD']);
    fs.rmSync(sibling('wt-gone'), { recursive: true, force: true });

    // Opening a folder would replace the test host's window: record it instead.
    opened = [];
    const original = vscode.commands.executeCommand;
    (vscode.commands as { executeCommand: unknown }).executeCommand = (
      id: string,
      ...args: unknown[]
    ): Thenable<unknown> => {
      if (id === 'vscode.openFolder') {
        opened.push({
          path: (args[0] as vscode.Uri).fsPath,
          forceNewWindow: (args[1] as { forceNewWindow: boolean }).forceNewWindow,
        });
        return Promise.resolve(undefined);
      }
      return original(id, ...args);
    };
    restoreExecute = (): void => {
      (vscode.commands as { executeCommand: unknown }).executeCommand = original;
    };
  });

  afterEach(async () => {
    restoreExecute?.();
    restoreExecute = undefined;
    stubs?.restore();
    stubs = undefined;
    await clearWorkspace();
    await fix?.cleanup();
  });

  /**
   * The fixture repository's Worktrees category. A worktree nested in the
   * repository is discovered as a repository of its own, which turns the
   * tree into per-repository nodes; descend into the fixture's.
   */
  async function worktreesCategory(): Promise<BranchTreeItem> {
    const provider = getBranchTreeProvider();
    assert.ok(provider, 'the Branches tree provider must be live');
    let root = await provider.getChildren();
    const repoNode = root.find(
      (n) =>
        n.itemType === 'repository' &&
        n.repository &&
        fs.realpathSync.native(n.repository.rootUri.fsPath) === fs.realpathSync.native(fix.rootPath)
    );
    if (repoNode) {
      root = await provider.getChildren(repoNode);
    }
    const category = root.find((n) => n.label === 'Worktrees');
    assert.ok(category, `a Worktrees category: ${root.map((n) => String(n.label)).join(', ')}`);
    return category;
  }

  async function rows(): Promise<Map<string, BranchTreeItem>> {
    const provider = getBranchTreeProvider()!;
    const children = await provider.getChildren(await worktreesCategory());
    return new Map(children.map((row) => [String(row.label), row]));
  }

  async function row(name: string): Promise<BranchTreeItem> {
    const found = (await rows()).get(name);
    assert.ok(found, `a row for ${name}`);
    return found;
  }

  async function porcelain(): Promise<string> {
    return (await execGit(fix.rootPath, ['worktree', 'list', '--porcelain'])).stdout;
  }

  /** The porcelain record of the worktree whose folder is `name`. */
  async function record(name: string): Promise<string | undefined> {
    return (await porcelain())
      .split(/\n\n/)
      .find((r) => r.split('\n')[0].endsWith(`${path.sep}${name}`));
  }

  it('lists every worktree with its state, main first, and what each offers', async () => {
    const listed = await rows();
    const [first, ...linked] = [...listed.keys()];
    assert.strictEqual(first, path.basename(fix.rootPath), 'the main worktree comes first');
    assert.deepStrictEqual(linked.sort(), ['wt-gone', 'wt-locked', 'wt-normal']);
    const words = (name: string): string[] => (listed.get(name)!.contextValue ?? '').split(' ');

    assert.ok(String(listed.get('wt-locked')!.description).includes('Locked'));
    assert.match(String(listed.get('wt-locked')!.tooltip), /Locked: on a USB disk/);
    assert.ok(String(listed.get('wt-gone')!.description).includes('Prunable'));

    assert.deepStrictEqual(words(path.basename(fix.rootPath)), ['intellig.worktree']);
    assert.deepStrictEqual(words('wt-normal'), [
      'intellig.worktree',
      'canOpen',
      'canRemove',
      'canLock',
    ]);
    assert.deepStrictEqual(words('wt-locked'), [
      'intellig.worktree',
      'canOpen',
      'canRemove',
      'canUnlock',
    ]);
    assert.deepStrictEqual(words('wt-gone'), ['intellig.worktree', 'canRemove', 'canLock']);
  });

  it('intellig.worktree.lock / unlock — lock with a reason, then unlock', async () => {
    stubs = stubPrompts({ inputBox: () => 'travelling' });
    await vscode.commands.executeCommand('intellig.worktree.lock', await row('wt-normal'));
    assert.match((await record('wt-normal')) ?? '', /^locked travelling$/m);

    await vscode.commands.executeCommand('intellig.worktree.unlock', await row('wt-locked'));
    assert.doesNotMatch(
      (await record('wt-locked')) ?? '',
      /^locked/m,
      `errors=${JSON.stringify(stubs.errorMessageCalls)}`
    );
  });

  it('intellig.worktree.remove — removes a locked worktree after one confirm', async () => {
    stubs = stubPrompts({ warningMessage: () => 'Remove' });
    await vscode.commands.executeCommand('intellig.worktree.remove', await row('wt-locked'));

    assert.strictEqual(stubs.warningMessageCalls.length, 1);
    assert.match(stubs.warningMessageCalls[0].message, /locked \(on a USB disk\)/);
    assert.ok(!fs.existsSync(sibling('wt-locked')), 'the folder is deleted');
    assert.strictEqual(
      await record('wt-locked'),
      undefined,
      `errors=${JSON.stringify(stubs.errorMessageCalls)}`
    );
  });

  it('intellig.worktree.prune — drops the missing worktree record after a confirm naming it', async () => {
    stubs = stubPrompts({ warningMessage: () => 'Prune Worktrees' });
    await vscode.commands.executeCommand('intellig.worktree.prune', await worktreesCategory());

    assert.match(stubs.warningMessageCalls[0].message, /wt-gone/);
    assert.strictEqual(await record('wt-gone'), undefined);
    assert.ok(await record('wt-normal'), 'a worktree that is still there stays');
  });

  it('intellig.worktree.openInNewWindow / openInCurrentWindow — open the row folder', async () => {
    stubs = stubPrompts({});
    await vscode.commands.executeCommand(
      'intellig.worktree.openInNewWindow',
      await row('wt-normal')
    );
    await vscode.commands.executeCommand(
      'intellig.worktree.openInCurrentWindow',
      await row('wt-normal')
    );
    assert.deepStrictEqual(
      opened.map((o) => ({ ...o, path: fs.realpathSync.native(o.path) })),
      [
        { path: fs.realpathSync.native(sibling('wt-normal')), forceNewWindow: true },
        { path: fs.realpathSync.native(sibling('wt-normal')), forceNewWindow: false },
      ]
    );
  });

  it('opening a worktree whose folder is gone says so instead of opening it', async () => {
    stubs = stubPrompts({});
    await vscode.commands.executeCommand('intellig.worktree.openInNewWindow', await row('wt-gone'));
    assert.deepStrictEqual(opened, []);
    assert.match(stubs.warningMessageCalls[0]?.message ?? '', /no longer exists/);
  });

  it('a lock made in a terminal repaints the tree, and a row rendered before it acts on it', async () => {
    const stale = await row('wt-normal');
    const provider = getBranchTreeProvider()!;
    let repaints = 0;
    // Let the fixture's own refreshes settle, so only the lock can repaint.
    await new Promise((r) => setTimeout(r, 1500));
    const listener = provider.onDidChangeTreeData(() => {
      repaints += 1;
    });
    try {
      await execGit(fix.rootPath, [
        'worktree',
        'lock',
        '--reason',
        'from the terminal',
        sibling('wt-normal'),
      ]);
      const deadline = Date.now() + 15_000;
      while (repaints === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      listener.dispose();
    }
    assert.ok(repaints > 0, 'the Branches tree repaints after a lock from the terminal');

    stubs = stubPrompts({ inputBox: () => 'from the menu' });
    await vscode.commands.executeCommand('intellig.worktree.lock', stale);
    assert.match(stubs.warningMessageCalls[0]?.message ?? '', /already locked/);
    assert.deepStrictEqual(stubs.inputBoxCalls, [], 'no reason is asked for');
    assert.match((await record('wt-normal')) ?? '', /^locked from the terminal$/m);
  });

  it('a worktree with a non-ASCII path shows its real name, in the tree and the picker', async () => {
    await execGit(fix.rootPath, ['worktree', 'add', '-b', 'wt-cafe', sibling('wt-café'), 'HEAD']);
    const cafe = await row('wt-café');
    assert.match(String(cafe.description), /^wt-cafe/);
    assert.match(String(cafe.tooltip), /wt-café/);

    let offered: string[] = [];
    stubs = stubPrompts({
      quickPick: (items: unknown) => {
        offered = (items as Array<{ description?: string }>).map((i) => i.description ?? '');
        return undefined;
      },
    });
    await vscode.commands.executeCommand('intellig.branch.removeWorktree', cafe);
    assert.ok(
      offered.some((d) => d.endsWith(`${path.sep}wt-café`)),
      `the picker names the real folder: ${JSON.stringify(offered)}`
    );
    assert.ok(!offered.some((d) => d.includes('\\303')), 'no C-quoted escapes reach the picker');
  });

  it('Remove… on a locked worktree with uncommitted work warns that it will be lost', async () => {
    const work = path.join(sibling('wt-locked'), 'work-in-progress.txt');
    fs.writeFileSync(work, 'not committed\n');

    stubs = stubPrompts({ warningMessage: () => undefined });
    await vscode.commands.executeCommand('intellig.worktree.remove', await row('wt-locked'));
    assert.match(
      stubs.warningMessageCalls[0]?.message ?? '',
      /locked \(on a USB disk\) and has uncommitted changes, which will be lost/
    );
    assert.ok(fs.existsSync(work), 'dismissing the confirm keeps the work');
    stubs.restore();

    stubs = stubPrompts({ warningMessage: () => 'Remove' });
    await vscode.commands.executeCommand('intellig.worktree.remove', await row('wt-locked'));
    assert.ok(!fs.existsSync(sibling('wt-locked')), 'confirming removes it, work and all');
  });

  it('a worktree nested inside the repository can be removed', async () => {
    const nested = path.join(fix.rootPath, '.worktrees', 'nested');
    await execGit(fix.rootPath, ['worktree', 'add', '-b', 'wt-n', nested, 'HEAD']);
    const nestedRow = await row('nested');
    assert.ok((nestedRow.contextValue ?? '').split(' ').includes('canRemove'));

    stubs = stubPrompts({ warningMessage: () => 'Remove' });
    await vscode.commands.executeCommand('intellig.worktree.remove', nestedRow);
    assert.ok(!fs.existsSync(nested), `errors=${JSON.stringify(stubs.errorMessageCalls)}`);
  });

  it('Lock… on a selection of rows locks each of them', async () => {
    await execGit(fix.rootPath, ['worktree', 'add', '-b', 'wt-d', sibling('wt-extra'), 'HEAD']);
    const a = await row('wt-normal');
    const b = await row('wt-extra');
    stubs = stubPrompts({ inputBox: () => 'batch' });
    await vscode.commands.executeCommand('intellig.worktree.lock', a, [a, b]);
    assert.match((await record('wt-normal')) ?? '', /^locked batch$/m);
    assert.match((await record('wt-extra')) ?? '', /^locked batch$/m);
  });
});

/**
 * The Branches tree's Worktrees category: the worktrees a repository shows,
 * one row each, main first, each row's state in its description, icon and
 * tooltip, and the actions it offers as words of its context value — the
 * words the menus in package.json match.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { errAsync, okAsync } from 'neverthrow';
import { BranchTreeProvider, CONTEXT_VALUES } from '../../../src/branches/BranchTreeProvider';
import {
  isOpenInWindow,
  windowRoots,
  WORKTREE_CONTEXT,
  worktreeCapabilities,
  worktreeRows,
  worktreesForDisplay,
  WorktreeTreeItem,
} from '../../../src/branches/worktreeTreeItems';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import type { IGitService } from '../../../src/git-core/interfaces/IGitService';
import { CommandFailedError } from '../../../src/git-core/errors';
import type {
  IWorktreeCapableService,
  IWorktreeEntry,
} from '../../../src/git-core/ops/WorktreeOps';
import { createMockGitService, attachedRepo } from '../../mocks/mockGitService';
import { Uri } from '../../mocks/vscode';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';
import { writableWorkspace } from '../../typed/windowStub';

const REPO = { rootUri: Uri.file('/repo/main') } as unknown as IRepository;

function entry(over: Partial<IWorktreeEntry>): IWorktreeEntry {
  return {
    path: '/repo/wt',
    head: 'a'.repeat(40),
    branch: 'refs/heads/feature',
    isMain: false,
    isDetached: false,
    isBare: false,
    isLocked: false,
    isPrunable: false,
    ...over,
  };
}

const MAIN = entry({ path: '/repo/main', branch: 'refs/heads/main', isMain: true });

function listing(list: IWorktreeEntry[]): IWorktreeCapableService {
  return { listWorktrees: () => okAsync(list) } as unknown as IWorktreeCapableService;
}

/** A git service exposing these worktrees. */
function gitServiceWith(list: IWorktreeEntry[] | IWorktreeCapableService): IGitService {
  return { worktrees: Array.isArray(list) ? listing(list) : list } as unknown as IGitService;
}

/** A folder that exists, so the listing does not read the worktree as missing. */
function folder(name: string): string {
  return fs.mkdtempSync(path.join(SCRATCH_ROOT, `${name}-`));
}

function setWorkspaceFolders(paths: string[] | undefined): void {
  writableWorkspace().workspaceFolders = paths?.map((p, index) => ({
    uri: Uri.file(p),
    name: path.basename(p),
    index,
  }));
}

function words(item: { contextValue?: string }): string[] {
  return (item.contextValue ?? '').split(' ');
}

describe('worktreeCapabilities', () => {
  it('offers everything but unlock on an ordinary linked worktree', () => {
    assert.deepStrictEqual(worktreeCapabilities(entry({}), false), {
      canOpen: true,
      canRemove: true,
      canLock: true,
      canUnlock: false,
    });
  });

  it('never removes or locks the main worktree', () => {
    const can = worktreeCapabilities(MAIN, false);
    assert.strictEqual(can.canRemove, false);
    assert.strictEqual(can.canLock, false);
    assert.strictEqual(can.canOpen, true);
  });

  it('neither opens nor removes the worktree this window has open', () => {
    const can = worktreeCapabilities(entry({}), true);
    assert.strictEqual(can.canOpen, false);
    assert.strictEqual(can.canRemove, false);
  });

  it('offers unlock instead of lock on a locked worktree', () => {
    const can = worktreeCapabilities(entry({ isLocked: true }), false);
    assert.strictEqual(can.canLock, false);
    assert.strictEqual(can.canUnlock, true);
  });

  it('does not open a worktree whose folder is gone', () => {
    assert.strictEqual(worktreeCapabilities(entry({ isPrunable: true }), false).canOpen, false);
  });
});

describe('WorktreeTreeItem', () => {
  it('labels the row with the folder name and describes branch and state', () => {
    const item = new WorktreeTreeItem(
      entry({ path: '/x/wt-locked', isLocked: true, lockReason: 'USB' }),
      REPO,
      false
    );
    assert.strictEqual(item.label, 'wt-locked');
    assert.strictEqual(item.description, 'feature · Locked');
    assert.match(String(item.tooltip), /Worktree: \/x\/wt-locked/);
    assert.match(String(item.tooltip), /Locked: USB/);
  });

  it('describes a detached worktree by its commit and a missing one as Prunable', () => {
    const item = new WorktreeTreeItem(
      entry({ branch: undefined, isDetached: true, isPrunable: true }),
      REPO,
      false
    );
    assert.strictEqual(item.description, 'detached at aaaaaaa · Prunable');
  });

  it('marks the main worktree in its description', () => {
    assert.strictEqual(new WorktreeTreeItem(MAIN, REPO, true).description, 'main · main worktree');
  });

  it('puts exactly the offered actions into the context value', () => {
    const item = new WorktreeTreeItem(entry({ isLocked: true }), REPO, false);
    assert.deepStrictEqual(words(item), ['intellig.worktree', 'canOpen', 'canRemove', 'canUnlock']);
  });

  it('carries its repository, so the command spine resolves the right one', () => {
    assert.strictEqual(new WorktreeTreeItem(entry({}), REPO, false).repository, REPO);
  });
});

describe('worktreesForDisplay', () => {
  async function display(list: IWorktreeEntry[], repo = REPO): Promise<IWorktreeEntry[]> {
    return (await worktreesForDisplay(listing(list), repo))._unsafeUnwrap();
  }

  it('puts the main worktree first', async () => {
    const linked = entry({ path: folder('wt') });
    assert.deepStrictEqual(
      (await display([linked, MAIN])).map((wt) => wt.isMain),
      [true, false]
    );
  });

  it('leaves out a bare main, which is not a checkout (git4idea parity)', async () => {
    const bare = entry({ path: '/srv/repo.git', branch: undefined, isBare: true, isMain: true });
    const linked = entry({ path: folder('wt') });
    assert.deepStrictEqual(
      (await display([bare, linked])).map((wt) => wt.path),
      [linked.path]
    );
  });

  it("gives a submodule's checkout its own path back from the git dir git reports", async () => {
    const root = folder('sub');
    const gitDir = folder('modules-sub');
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${gitDir}\n`);
    const repo = { rootUri: Uri.file(root) } as unknown as IRepository;
    const [main] = await display([entry({ path: gitDir, isMain: true })], repo);
    assert.strictEqual(main.path, root);
  });

  it('marks a linked worktree whose folder is gone as prunable, even unflagged by git', async () => {
    const [, gone] = await display([MAIN, entry({ path: '/repo/no-such-folder' })]);
    assert.strictEqual(gone.isPrunable, true);
  });
});

describe('worktreeRows', () => {
  afterEach(() => setWorkspaceFolders(undefined));

  it('marks the worktree this repository is rooted at as open here', async () => {
    const linked = entry({ path: folder('wt') });
    const rows = (await worktreeRows(gitServiceWith([MAIN, linked]), REPO)) as WorktreeTreeItem[];
    assert.ok(!words(rows[0]).includes('canOpen'), 'the open worktree does not offer Open');
    assert.ok(words(rows[1]).includes('canOpen'));
  });

  it('treats a worktree that is another folder of this workspace as open here', async () => {
    const linked = entry({ path: folder('wt') });
    setWorkspaceFolders(['/repo/main', linked.path]);
    const rows = (await worktreeRows(gitServiceWith([MAIN, linked]), REPO)) as WorktreeTreeItem[];
    assert.ok(!words(rows[1]).includes('canRemove'), 'never offer to delete an open folder');
    assert.ok(!words(rows[1]).includes('canOpen'));
  });

  it('renders a failed listing as one row saying so, without menus', async () => {
    const failing = {
      listWorktrees: () => errAsync(new CommandFailedError(128, 'fatal: not a git repository')),
    } as unknown as IWorktreeCapableService;
    const rows = await worktreeRows(gitServiceWith(failing), REPO);
    assert.strictEqual(rows.length, 1);
    assert.match(String(rows[0].label), /Failed to list worktrees/);
    assert.strictEqual(rows[0].contextValue, '');
  });
});

describe('isOpenInWindow', () => {
  afterEach(() => setWorkspaceFolders(undefined));

  it('matches a workspace folder reached through a symlink to the same folder', () => {
    const real = folder('wt-real');
    const link = `${real}-link`;
    fs.symlinkSync(real, link);
    setWorkspaceFolders(['/elsewhere', link]);
    const roots = windowRoots(REPO);
    assert.ok(isOpenInWindow(entry({ path: real }), roots));
    assert.ok(!isOpenInWindow(entry({ path: `${real}-other` }), roots));
  });

  it('matches a missing worktree under a symlinked parent', () => {
    const parent = folder('wt-parent');
    const link = `${parent}-link`;
    fs.symlinkSync(parent, link);
    setWorkspaceFolders([path.join(parent, 'gone')]);
    assert.ok(isOpenInWindow(entry({ path: path.join(link, 'gone') }), windowRoots(REPO)));
  });
});

describe('package.json worktree menus', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    contributes: { menus: Record<string, Array<{ command: string; when?: string }>> };
  };
  const rowMenus = pkg.contributes.menus['view/item/context'].filter((m) =>
    (m.when ?? '').includes(WORKTREE_CONTEXT.replace('.', '\\.'))
  );
  const capabilityWords = Object.keys(worktreeCapabilities(MAIN, false));
  /** How a when-clause regex names a capability word: `\bcanOpen\b`, backslashes literal. */
  const gate = (word: string): string => `\\b${word}\\b`;

  it('gates every worktree row menu item on exactly one word the rows can carry', () => {
    assert.ok(rowMenus.length > 0, 'the worktree row menus are found');
    for (const menu of rowMenus) {
      const used = capabilityWords.filter((w) => menu.when!.includes(gate(w)));
      assert.strictEqual(
        used.length,
        1,
        `${menu.command} is gated on one capability: ${menu.when}`
      );
      const words = [...menu.when!.matchAll(/\\b(can[A-Z]\w*)\\b/g)].map((m) => m[1]);
      assert.deepStrictEqual(words, used, `${menu.command} names no unknown word: ${menu.when}`);
    }
  });

  it('gives every capability a menu item', () => {
    for (const word of capabilityWords) {
      assert.ok(
        rowMenus.some((m) => m.when!.includes(gate(word))),
        `a menu item is gated on ${word}`
      );
    }
  });
});

describe('BranchTreeProvider — Worktrees category', () => {
  it('ends each repository with a Worktrees category the worktree menus bind to', async () => {
    const provider = new BranchTreeProvider(createMockGitService(attachedRepo()));
    provider.setRepository(attachedRepo());
    const root = await provider.getChildren();
    const worktrees = root[root.length - 1];
    assert.strictEqual(worktrees.label, 'Worktrees');
    assert.strictEqual(worktrees.contextValue, CONTEXT_VALUES.WORKTREES_CATEGORY);
  });

  it('expands into the rows the git service lists for that repository', async () => {
    const repo = attachedRepo();
    const linked = entry({ path: '/elsewhere/wt' });
    const service = Object.assign(createMockGitService(repo), {
      worktrees: listing([MAIN, linked]),
    }) as IGitService;
    const provider = new BranchTreeProvider(service);
    provider.setRepository(repo);
    const root = await provider.getChildren();
    const rows = await provider.getChildren(root[root.length - 1]);
    assert.deepStrictEqual(
      rows.map((r) => r.label),
      ['main', 'wt']
    );
  });
});

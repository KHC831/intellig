/**
 * Wave D — Branches & Tags parity tests.
 *
 * Covers:
 *  Item 1 — Incoming/outgoing arrows on the branch popup:
 *    - buildSectionedItems renders ↑N / ↓N when branch.ahead / branch.behind
 *      are set (regression pin for the display logic that already exists).
 *    - enrichBranchesWithIncomingOutgoing: calls the fetcher per local branch
 *      with an upstream, maps incoming→behind / outgoing→ahead on a clone,
 *      skips no-upstream branches, does not mutate the input, handles
 *      noUpstream:true results.
 *
 *  Item 2 — Delete remote tag command wiring:
 *    - intellig.tag.deleteRemote exists in package.json contributes.commands.
 *    - intellig.tag.deleteRemote appears in view/item/context menu under
 *      viewItem == intellig.tag.
 *    - BranchContextMenuCommands._handleTagDeleteRemote calls
 *      gitService.deleteRemoteTag with the tag name (and default remote).
 *    - Error path: deleteRemoteTag throws → showErrorMessage routes through
 *      sanitizeGitError (credential-safe).
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type {
  IBranch,
  IGitService,
  IRepository,
  ITag,
} from '../../../src/git-core/interfaces/IGitService';
import type { IIncomingOutgoing } from '../../../src/git-core/ops/IncomingOutgoingOps';
import {
  buildSectionedItems,
  enrichBranchesWithIncomingOutgoing,
} from '../../../src/branches/BranchPopup';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import { Uri } from '../../mocks/vscode';
import { writableWindow } from '../../typed/windowStub';

// ─── package.json helpers ─────────────────────────────────────────────────────

function loadPackageJson(): Record<string, unknown> {
  const p = path.resolve(process.cwd(), 'package.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

interface MenuEntry {
  command: string;
  when: string;
  group: string;
}

function getMenuEntries(): MenuEntry[] {
  const pkg = loadPackageJson();
  const contributes = pkg.contributes as Record<string, unknown>;
  const menus = contributes.menus as Record<string, unknown>;
  return menus['view/item/context'] as MenuEntry[];
}

function getCommandIds(): string[] {
  const pkg = loadPackageJson();
  const contributes = pkg.contributes as Record<string, unknown>;
  const commands = contributes.commands as Array<{ command: string }>;
  return commands.map((c) => c.command);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    remotes: [],
    submodules: [],
  };
}

const localMainWithCounts: IBranch = {
  name: 'main',
  type: 'local',
  commit: 'aaa1111',
  isHead: true,
  upstream: { remote: 'origin', name: 'main' },
  ahead: 2,
  behind: 3,
};

const localFeatureWithUpstream: IBranch = {
  name: 'feature/x',
  type: 'local',
  commit: 'bbb2222',
  isHead: false,
  upstream: { remote: 'origin', name: 'feature/x' },
};

const localNoUpstream: IBranch = {
  name: 'local-only',
  type: 'local',
  commit: 'ccc3333',
  isHead: false,
};

// ─── Helpers for BranchContextMenuCommands ────────────────────────────────────

interface DeleteRemoteTagCall {
  name: string;
  remote?: string;
}

function makeGitServiceWithDeleteRemoteTag(opts: {
  deleteRemoteTagImpl?: (_repo: IRepository, name: string, remote?: string) => Promise<void>;
}): IGitService & { _deleteRemoteTagCalls: DeleteRemoteTagCall[] } {
  const calls: DeleteRemoteTagCall[] = [];
  return {
    _deleteRemoteTagCalls: calls,
    onDidChangeRepository: () => ({ dispose: () => {} }),
    getBranches: async () => [],
    getTags: async () => [],
    deleteRemoteTag: async (_repo: IRepository, name: string, remote?: string): Promise<void> => {
      calls.push({ name, remote });
      if (opts.deleteRemoteTagImpl) {
        await opts.deleteRemoteTagImpl(_repo, name, remote);
      }
    },
    reloadRepository: async () => {},
  } as unknown as IGitService & { _deleteRemoteTagCalls: DeleteRemoteTagCall[] };
}

function makeMinimalBranchTreeProvider(): BranchTreeProvider {
  return {
    getRepository: () => makeRepo(),
    refresh: () => {},
    onDidChangeTreeData: { event: () => ({ dispose: () => {} }) },
  } as unknown as BranchTreeProvider;
}

type CmdsInternal = {
  _handleTagDeleteRemote(item: { tag?: ITag }): Promise<void>;
};

// ─── Item 1a: incoming/outgoing display via buildSectionedItems ───────────────

describe('Wave D — incoming/outgoing badge rendering in buildSectionedItems', () => {
  it('renders ↑N ahead badge in description when branch.ahead is set', () => {
    const items = buildSectionedItems({
      localBranches: [localMainWithCounts],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      currentBranchName: 'main',
    });
    const mainItem = items.find((i) => i.branch?.name === 'main');
    assert.ok(mainItem, 'main branch item must be in the list');
    assert.ok(
      typeof mainItem.description === 'string' && mainItem.description.includes('↑2'),
      `Expected description to contain ↑2; got: "${mainItem.description ?? 'undefined'}"`
    );
  });

  it('renders ↓N behind badge in description when branch.behind is set', () => {
    const items = buildSectionedItems({
      localBranches: [localMainWithCounts],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      currentBranchName: 'main',
    });
    const mainItem = items.find((i) => i.branch?.name === 'main');
    assert.ok(mainItem, 'main branch item must be in the list');
    assert.ok(
      typeof mainItem.description === 'string' && mainItem.description.includes('↓3'),
      `Expected description to contain ↓3; got: "${mainItem.description ?? 'undefined'}"`
    );
  });

  it('omits arrow badges when branch has no ahead/behind counts', () => {
    const noCounts: IBranch = {
      name: 'clean',
      type: 'local',
      commit: 'ddd4444',
      isHead: false,
    };
    const items = buildSectionedItems({
      localBranches: [noCounts],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
    });
    const item = items.find((i) => i.branch?.name === 'clean');
    assert.ok(item, 'clean branch item must be in the list');
    const desc = typeof item.description === 'string' ? item.description : '';
    assert.ok(!desc.includes('↑'), `Expected no ↑ in description; got: "${desc}"`);
    assert.ok(!desc.includes('↓'), `Expected no ↓ in description; got: "${desc}"`);
  });
});

// ─── Item 1b: enrichBranchesWithIncomingOutgoing ──────────────────────────────

describe('Wave D — enrichBranchesWithIncomingOutgoing', () => {
  it('calls the fetcher for each local branch that has an upstream', async () => {
    const fetched: string[] = [];
    const fetcher = async (_repo: IRepository, branch: string): Promise<IIncomingOutgoing> => {
      fetched.push(branch);
      return {
        branch,
        incoming: 5,
        outgoing: 2,
        noUpstream: false,
        upstream: `origin/${branch}`,
      };
    };

    const repo = makeRepo();
    const enriched = await enrichBranchesWithIncomingOutgoing(
      repo,
      [localMainWithCounts, localFeatureWithUpstream, localNoUpstream],
      fetcher
    );

    // Only upstream-bearing branches should be fetched.
    assert.deepStrictEqual(fetched.sort(), ['feature/x', 'main']);

    // Each enriched branch carries the fetched counts (incoming→behind, outgoing→ahead).
    const mainEnriched = enriched.find((b) => b.name === 'main');
    assert.ok(mainEnriched, 'main should be in enriched output');
    assert.strictEqual(mainEnriched.behind, 5, 'behind = incoming from the fetcher');
    assert.strictEqual(mainEnriched.ahead, 2, 'ahead = outgoing from the fetcher');

    const featureEnriched = enriched.find((b) => b.name === 'feature/x');
    assert.ok(featureEnriched, 'feature/x should be in enriched output');
    assert.strictEqual(featureEnriched.behind, 5);
    assert.strictEqual(featureEnriched.ahead, 2);
  });

  it('does NOT call the fetcher for branches with no upstream', async () => {
    const fetched: string[] = [];
    const fetcher = async (_repo: IRepository, branch: string): Promise<IIncomingOutgoing> => {
      fetched.push(branch);
      return { branch, incoming: 0, outgoing: 0, noUpstream: false };
    };

    const repo = makeRepo();
    await enrichBranchesWithIncomingOutgoing(repo, [localNoUpstream], fetcher);

    assert.deepStrictEqual(fetched, [], 'fetcher must not be called for no-upstream branches');
  });

  it('preserves no-upstream branches in the output list without ahead/behind', async () => {
    const fetcher = async (_repo: IRepository, branch: string): Promise<IIncomingOutgoing> => ({
      branch,
      incoming: 9,
      outgoing: 7,
      noUpstream: false,
    });

    const repo = makeRepo();
    const enriched = await enrichBranchesWithIncomingOutgoing(
      repo,
      [localMainWithCounts, localNoUpstream],
      fetcher
    );

    const noUpstreamOut = enriched.find((b) => b.name === 'local-only');
    assert.ok(noUpstreamOut, 'local-only should appear in the output');
    assert.strictEqual(
      noUpstreamOut.ahead,
      undefined,
      'no-upstream branch must not receive an ahead count'
    );
    assert.strictEqual(noUpstreamOut.behind, undefined);
  });

  it('does not mutate the original IBranch objects', async () => {
    const original: IBranch = {
      name: 'main',
      type: 'local',
      commit: 'abc',
      isHead: false,
      upstream: { remote: 'origin', name: 'main' },
    };
    const fetcher = async (_repo: IRepository, branch: string): Promise<IIncomingOutgoing> => ({
      branch,
      incoming: 3,
      outgoing: 1,
      noUpstream: false,
    });

    const repo = makeRepo();
    await enrichBranchesWithIncomingOutgoing(repo, [original], fetcher);

    assert.strictEqual(original.ahead, undefined, 'original IBranch must not be mutated');
    assert.strictEqual(original.behind, undefined);
  });

  it('sets ahead=0 and behind=0 when the fetcher returns noUpstream:true', async () => {
    // When git says noUpstream on a branch that has upstream in IBranch
    // (e.g. the remote was deleted), surface 0/0 so the description still
    // renders "current" not "current ↑undefined".
    const fetcher = async (_repo: IRepository, branch: string): Promise<IIncomingOutgoing> => ({
      branch,
      incoming: 0,
      outgoing: 0,
      noUpstream: true,
    });

    const repo = makeRepo();
    const enriched = await enrichBranchesWithIncomingOutgoing(repo, [localMainWithCounts], fetcher);
    const out = enriched.find((b) => b.name === 'main');
    assert.ok(out);
    assert.strictEqual(out.ahead, 0);
    assert.strictEqual(out.behind, 0);
  });
});

// ─── Item 2a: package.json — intellig.tag.deleteRemote command ───────────────

describe('Wave D — intellig.tag.deleteRemote in package.json', () => {
  it('intellig.tag.deleteRemote is declared in contributes.commands', () => {
    const ids = getCommandIds();
    assert.ok(
      ids.includes('intellig.tag.deleteRemote'),
      `intellig.tag.deleteRemote not found in commands; tag commands: ${ids.filter((c) => c.startsWith('intellig.tag.')).join(', ')}`
    );
  });

  it('intellig.tag.deleteRemote appears in view/item/context menu for viewItem == intellig.tag', () => {
    const entries = getMenuEntries();
    const tagEntries = entries.filter((e) => e.when === 'viewItem == intellig.tag');
    const entry = tagEntries.find((e) => e.command === 'intellig.tag.deleteRemote');
    assert.ok(
      entry,
      `intellig.tag.deleteRemote not in intellig.tag menu. Tag entries: ${tagEntries.map((e) => e.command).join(', ')}`
    );
  });

  it('intellig.tag.deleteRemote uses section@order group format', () => {
    const entries = getMenuEntries();
    const entry = entries.find((e) => e.command === 'intellig.tag.deleteRemote');
    assert.ok(entry, 'command must be in the menu (checked by sibling test)');
    assert.ok(entry.group.includes('@'), `group "${entry.group}" must use section@order format`);
  });
});

// ─── Item 2b: BranchContextMenuCommands — _handleTagDeleteRemote ─────────────

describe('Wave D — BranchContextMenuCommands._handleTagDeleteRemote', () => {
  const mockTag: ITag = {
    name: 'v2.0.0',
    commit: 'deadbeef1234567',
    isAnnotated: true,
  };

  it('calls deleteRemoteTag with the tag name on confirm', async () => {
    const gitService = makeGitServiceWithDeleteRemoteTag({});
    const cmds = new BranchContextMenuCommands(gitService, makeMinimalBranchTreeProvider());

    const w = writableWindow();
    const originalShowWarning = w.showWarningMessage;
    w.showWarningMessage = async () => 'Delete from Remote' as unknown as undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    await (cmds as unknown as CmdsInternal)._handleTagDeleteRemote({ tag: mockTag });

    w.showWarningMessage = originalShowWarning;

    assert.strictEqual(
      gitService._deleteRemoteTagCalls.length,
      1,
      'deleteRemoteTag should be called exactly once'
    );
    assert.strictEqual(gitService._deleteRemoteTagCalls[0].name, 'v2.0.0');
  });

  it('does NOT call deleteRemoteTag when the user dismisses the confirm dialog', async () => {
    const gitService = makeGitServiceWithDeleteRemoteTag({});
    const cmds = new BranchContextMenuCommands(gitService, makeMinimalBranchTreeProvider());

    const w = writableWindow();
    const originalShowWarning = w.showWarningMessage;
    w.showWarningMessage = async () => undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    await (cmds as unknown as CmdsInternal)._handleTagDeleteRemote({ tag: mockTag });

    w.showWarningMessage = originalShowWarning;

    assert.deepStrictEqual(
      gitService._deleteRemoteTagCalls,
      [],
      'deleteRemoteTag must not be called on cancel'
    );
  });

  it('routes deleteRemoteTag errors through sanitizeGitError to showErrorMessage', async () => {
    const gitService = makeGitServiceWithDeleteRemoteTag({
      deleteRemoteTagImpl: async () => {
        throw new Error('remote: Repository not found at https://user:hunter2@github.com/org/repo');
      },
    });
    const cmds = new BranchContextMenuCommands(gitService, makeMinimalBranchTreeProvider());

    const errorMessages: string[] = [];
    const w = writableWindow();
    const originalShowWarning = w.showWarningMessage;
    const originalShowError = w.showErrorMessage;
    w.showWarningMessage = async () => 'Delete from Remote' as unknown as undefined;
    w.showErrorMessage = async (msg: string) => {
      errorMessages.push(msg);
      return undefined;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    await (cmds as unknown as CmdsInternal)._handleTagDeleteRemote({ tag: mockTag });

    w.showWarningMessage = originalShowWarning;
    w.showErrorMessage = originalShowError;

    assert.strictEqual(errorMessages.length, 1, 'error toast should be shown once');
    // sanitizeGitError strips credentials from the URL — no credentials in toast.
    assert.ok(
      !errorMessages[0].includes('hunter2'),
      `Credential leaked in error toast: "${errorMessages[0]}"`
    );
  });
});

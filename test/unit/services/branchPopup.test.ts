/**
 * Unit tests for the BranchPopup sectioned data pipeline.
 *
 * These tests exercise the pure helper functions exported from BranchPopup:
 *   - buildSectionedItems()
 *   - buildRemoteBranchActionMenu()
 *   - buildLocalBranchActionMenu()
 *   - buildTagActionMenu()
 *   - updateRecentLru()
 *   - detectIndentablePrefixes()
 *   - formatBranchLabel()
 *
 * Full integration tests for the BranchPopup UI (QuickPick host APIs) live in
 * the extension test suite and are not in scope for unit tests.
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { okAsync, errAsync } from 'neverthrow';
import { CommandFailedError } from '../../../src/git-core/errors';
import {
  IBranch,
  IGitService,
  IRepository,
  ITag,
} from '../../../src/git-core/interfaces/IGitService';
import {
  AUTO_INDENT_MIN_GROUP_SIZE,
  BranchPopup,
  FAVORITE_BRANCHES_STATE_KEY,
  IBranchPopupSettings,
  IBranchQuickPickItem,
  RECENT_BRANCHES_MAX,
  buildBranchPopupHeaderButtons,
  buildLocalBranchActionMenu,
  buildRemoteBranchActionMenu,
  buildSectionedItems,
  buildSettingsToggleItems,
  buildTagActionMenu,
  detectIndentablePrefixes,
  formatBranchLabel,
  readLegacyFavorites,
  readBranchPopupSettings,
  updateFavoritesList,
  updateRecentLru,
} from '../../../src/branches/BranchPopup';
import { BranchTreeProvider, type IFavoritesStore } from '../../../src/branches/BranchTreeProvider';
import { createMockGitService, attachedRepo } from '../../mocks/mockGitService';
import { EventEmitter, Uri } from '../../mocks/vscode';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const localMain: IBranch = {
  name: 'main',
  type: 'local',
  commit: 'aaa1111',
  isHead: true,
  upstream: { remote: 'origin', name: 'main' },
};
const localDevelop: IBranch = {
  name: 'develop',
  type: 'local',
  commit: 'bbb2222',
  isHead: false,
};
const localFeatureAuth: IBranch = {
  name: 'feature/auth',
  type: 'local',
  commit: 'ccc3333',
  isHead: false,
};
const localFeatureDashboard: IBranch = {
  name: 'feature/dashboard',
  type: 'local',
  commit: 'ddd4444',
  isHead: false,
};
const localFeatureApi: IBranch = {
  name: 'feature/api',
  type: 'local',
  commit: 'eee5555',
  isHead: false,
};
const localBugfixLogin: IBranch = {
  name: 'bugfix/login',
  type: 'local',
  commit: 'fff6666',
  isHead: false,
};

const remoteMain: IBranch = {
  name: 'origin/main',
  type: 'remote',
  commit: 'aaa1111',
  isHead: false,
};
const remoteDevelop: IBranch = {
  name: 'origin/develop',
  type: 'remote',
  commit: 'bbb2222',
  isHead: false,
};
const remoteFeatureAuth: IBranch = {
  name: 'origin/feature/auth',
  type: 'remote',
  commit: 'ccc3333',
  isHead: false,
};

const tagV1: ITag = {
  name: 'v1.0.0',
  commit: '1111111',
  isAnnotated: true,
  message: 'Release 1.0.0',
};
const tagV2: ITag = {
  name: 'v1.1.0',
  commit: '2222222',
  isAnnotated: true,
};

// Convenience: unwrap a string label (QuickPick items allow label string only in our shape).
function label(item: vscode.QuickPickItem): string {
  return typeof item.label === 'string' ? item.label : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// updateRecentLru
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — updateRecentLru', () => {
  it('prepends a new entry to the front of the LRU', () => {
    const next = updateRecentLru(['a', 'b', 'c'], 'd');
    assert.deepStrictEqual(next, ['d', 'a', 'b', 'c']);
  });

  it('dedupes existing entries (moves to front)', () => {
    const next = updateRecentLru(['a', 'b', 'c'], 'b');
    assert.deepStrictEqual(next, ['b', 'a', 'c']);
  });

  it('caps the LRU at RECENT_BRANCHES_MAX (5) entries', () => {
    const next = updateRecentLru(['a', 'b', 'c', 'd', 'e'], 'f');
    assert.strictEqual(next.length, RECENT_BRANCHES_MAX);
    assert.deepStrictEqual(next, ['f', 'a', 'b', 'c', 'd']);
  });

  it('returns a new array (does not mutate input)', () => {
    const input = ['a', 'b'];
    const next = updateRecentLru(input, 'c');
    assert.notStrictEqual(next, input);
    assert.deepStrictEqual(input, ['a', 'b']);
  });

  it('handles empty input', () => {
    const next = updateRecentLru([], 'x');
    assert.deepStrictEqual(next, ['x']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectIndentablePrefixes / formatBranchLabel
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — detectIndentablePrefixes', () => {
  it('identifies `/`-prefixes with ≥3 siblings', () => {
    const prefixes = detectIndentablePrefixes([
      'main',
      'develop',
      'feature/auth',
      'feature/dashboard',
      'feature/api',
      'bugfix/login',
      'bugfix/crash',
    ]);
    assert.ok(prefixes.has('feature/'), 'feature/ should be indentable (3 siblings)');
    assert.ok(!prefixes.has('bugfix/'), 'bugfix/ should NOT be indentable (only 2 siblings)');
  });

  it('requires at least AUTO_INDENT_MIN_GROUP_SIZE siblings', () => {
    assert.strictEqual(AUTO_INDENT_MIN_GROUP_SIZE, 3);
    const few = detectIndentablePrefixes(['feature/a', 'feature/b']);
    assert.strictEqual(few.size, 0);
  });

  it('ignores names without a `/`', () => {
    const prefixes = detectIndentablePrefixes(['main', 'develop', 'release']);
    assert.strictEqual(prefixes.size, 0);
  });
});

describe('BranchPopup — formatBranchLabel', () => {
  it('prefixes the current branch with ●', () => {
    const out = formatBranchLabel('main', new Set<string>(), /* isCurrent */ true);
    assert.strictEqual(out, '● main');
  });

  it('indents non-current branches whose name starts with an indentable prefix', () => {
    const out = formatBranchLabel('feature/auth', new Set(['feature/']), false);
    assert.strictEqual(out, '  feature/auth');
  });

  it('does NOT indent branches outside an indentable group', () => {
    const out = formatBranchLabel('main', new Set(['feature/']), false);
    assert.strictEqual(out, 'main');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSectionedItems
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — buildSectionedItems', () => {
  it('emits separator headers in Recent → Local → Remote → Tags order', () => {
    const items = buildSectionedItems({
      localBranches: [localMain, localDevelop],
      remoteBranches: [remoteMain, remoteDevelop],
      tags: [tagV1],
      recentBranchNames: ['develop'],
      currentBranchName: 'main',
    });

    const separatorLabels = items
      .filter((i) => i.kind === vscode.QuickPickItemKind.Separator)
      .map((i) => label(i));

    assert.deepStrictEqual(separatorLabels, ['Recent', 'Local', 'Remote', 'Tags']);
  });

  it('excludes the current branch from the Recent section', () => {
    const items = buildSectionedItems({
      localBranches: [localMain, localDevelop],
      remoteBranches: [],
      tags: [],
      // Recent list contains `main` (current) and `develop`; current must be filtered out.
      recentBranchNames: ['main', 'develop'],
      currentBranchName: 'main',
    });

    const recentStart = items.findIndex(
      (i) => i.kind === vscode.QuickPickItemKind.Separator && label(i) === 'Recent'
    );
    const localStart = items.findIndex(
      (i) => i.kind === vscode.QuickPickItemKind.Separator && label(i) === 'Local'
    );
    const recentItems = items.slice(recentStart + 1, localStart);
    assert.strictEqual(recentItems.length, 1, 'should only contain develop, not main');
    assert.strictEqual(recentItems[0].branch?.name, 'develop');
  });

  it('suppresses the Recent section entirely when empty (no header)', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      currentBranchName: 'main',
    });
    const hasRecentHeader = items.some(
      (i) => i.kind === vscode.QuickPickItemKind.Separator && label(i) === 'Recent'
    );
    assert.strictEqual(hasRecentHeader, false);
  });

  it('suppresses Remote and Tags sections when their lists are empty', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      currentBranchName: 'main',
    });
    const separators = items
      .filter((i) => i.kind === vscode.QuickPickItemKind.Separator)
      .map((i) => label(i));
    assert.deepStrictEqual(separators, ['Local']);
  });

  it('renders the current branch with a ● marker', () => {
    const items = buildSectionedItems({
      localBranches: [localMain, localDevelop],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      currentBranchName: 'main',
    });
    const mainItem = items.find((i) => i.branch?.name === 'main');
    assert.ok(mainItem, 'main should be in the list');
    assert.ok(label(mainItem).startsWith('● '), 'main should be marked with ●');
  });

  it('preserves origin/ prefix in remote branch labels', () => {
    const items = buildSectionedItems({
      localBranches: [],
      remoteBranches: [remoteMain],
      tags: [],
      recentBranchNames: [],
      currentBranchName: undefined,
    });
    const remoteItem = items.find((i) => i.branch?.name === 'origin/main');
    assert.ok(remoteItem);
    assert.ok(
      label(remoteItem).includes('origin/main'),
      'remote label should include the remote-qualified name'
    );
  });

  it('auto-indents local branches in a `/`-prefix group of ≥3', () => {
    const items = buildSectionedItems({
      localBranches: [
        localMain,
        localDevelop,
        localFeatureAuth,
        localFeatureDashboard,
        localFeatureApi,
        localBugfixLogin,
      ],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      currentBranchName: 'main',
    });

    const featureAuthItem = items.find((i) => i.branch?.name === 'feature/auth');
    assert.ok(featureAuthItem);
    assert.ok(
      label(featureAuthItem).startsWith('  '),
      'feature/auth should be indented (3 feature/ siblings)'
    );

    const bugfixItem = items.find((i) => i.branch?.name === 'bugfix/login');
    assert.ok(bugfixItem);
    assert.ok(
      !label(bugfixItem).startsWith('  '),
      'bugfix/login should NOT be indented (only 1 sibling)'
    );
  });

  it('places Recent items even when the underlying branch is remote-qualified', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [remoteFeatureAuth],
      tags: [],
      recentBranchNames: ['origin/feature/auth'],
      currentBranchName: 'main',
    });

    const recentHeader = items.findIndex(
      (i) => i.kind === vscode.QuickPickItemKind.Separator && label(i) === 'Recent'
    );
    assert.ok(recentHeader >= 0, 'Recent section should be present');
    const firstRecent = items[recentHeader + 1];
    assert.strictEqual(firstRecent.branch?.name, 'origin/feature/auth');
    assert.strictEqual(firstRecent.section, 'recent');
  });

  it('drops recent entries whose branch no longer exists', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [],
      tags: [],
      recentBranchNames: ['deleted-branch', 'also-gone'],
      currentBranchName: 'main',
    });

    const hasRecent = items.some(
      (i) => i.kind === vscode.QuickPickItemKind.Separator && label(i) === 'Recent'
    );
    assert.strictEqual(hasRecent, false, 'empty resolved Recent must not emit a header');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Remote-branch action menu
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — buildRemoteBranchActionMenu', () => {
  const items = buildRemoteBranchActionMenu(remoteMain);

  it('includes Checkout, Checkout and Rebase onto Current, Pull using Merge/Rebase, Compare, Cherry-Pick, Delete', () => {
    const labels = items.map((i) => label(i));
    assert.ok(
      labels.some((l) => l.includes('Checkout')),
      'expected Checkout'
    );
    assert.ok(
      labels.some((l) => l.includes('Checkout and Rebase onto Current')),
      'expected Checkout and Rebase onto Current'
    );
    assert.ok(
      labels.some((l) => l.includes('Pull into Current Using Merge')),
      'expected Pull into Current Using Merge'
    );
    assert.ok(
      labels.some((l) => l.includes('Pull into Current Using Rebase')),
      'expected Pull into Current Using Rebase'
    );
    assert.ok(
      labels.some((l) => l.includes('Compare with Current')),
      'expected Compare with Current'
    );
    assert.ok(
      labels.some((l) => l.includes('Cherry-Pick Commits')),
      'expected Cherry-Pick Commits'
    );
    assert.ok(
      labels.some((l) => l.includes('Delete')),
      'expected Delete'
    );
  });

  it('routes each entry to an existing `intellig.*` command ID', () => {
    const expected = new Set([
      'intellig.remoteBranch.checkoutAsLocal',
      'intellig.branch.checkoutAndRebase',
      'intellig.remoteBranch.pullUsingMerge',
      'intellig.remoteBranch.pullUsingRebase',
      'intellig.branch.compareWithCurrent',
      'intellig.remoteBranch.cherryPickCommits',
      'intellig.remoteBranch.deleteRemote',
    ]);
    for (const item of items) {
      assert.ok(item.commandId, `${label(item)} missing commandId`);
      assert.ok(
        expected.has(item.commandId),
        `unknown commandId ${item.commandId ?? ''} on ${label(item)}`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Local-branch action menu
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — buildLocalBranchActionMenu', () => {
  const items = buildLocalBranchActionMenu(localDevelop, 'main');

  it('includes IntelliJ-parity entries: Checkout, New Branch from…, Rename…, Delete, Compare, Merge into Current, Rebase Current onto…, Push…', () => {
    const labels = items.map((i) => label(i));
    assert.ok(
      labels.some((l) => l.startsWith('$(arrow-right) Checkout')),
      'Checkout'
    );
    assert.ok(
      labels.some((l) => l.includes('New Branch from')),
      'New Branch from…'
    );
    assert.ok(
      labels.some((l) => l.includes('Rename…')),
      'Rename…'
    );
    assert.ok(
      labels.some((l) => l === '$(trash) Delete'),
      'Delete'
    );
    assert.ok(
      labels.some((l) => l.includes('Compare with Current')),
      'Compare with Current'
    );
    assert.ok(
      labels.some((l) => l.includes('Merge into Current')),
      'Merge into Current'
    );
    assert.ok(
      labels.some((l) => l.includes('Rebase Current onto')),
      'Rebase Current onto…'
    );
    assert.ok(
      labels.some((l) => l.includes('Push…')),
      'Push…'
    );
  });

  it('places Rename… and Delete LAST, after the operational actions (git4idea order)', () => {
    const actions = items.map((i) => i.action);
    const renameIdx = actions.indexOf('rename');
    const deleteIdx = actions.indexOf('delete');

    // Rename and Delete are the final two entries…
    assert.strictEqual(deleteIdx, actions.length - 1, 'Delete must be the last item');
    assert.strictEqual(renameIdx, actions.length - 2, 'Rename… must be the second-to-last item');
    // …with Rename preceding Delete.
    assert.ok(renameIdx < deleteIdx, 'Rename… must precede Delete');

    // Every operational action precedes Rename/Delete.
    for (const op of [
      'compare',
      'local.mergeIntoCurrent',
      'local.rebaseCurrentOnto',
      'local.push',
    ] as const) {
      const idx = actions.indexOf(op);
      assert.ok(idx !== -1, `expected operational action ${op}`);
      assert.ok(idx < renameIdx, `${op} must precede Rename…`);
    }
  });

  it('routes each command-dispatched entry to an existing `intellig.branch.*` command ID', () => {
    const expected = new Set([
      'intellig.branch.checkout',
      'intellig.branch.newBranchFrom',
      'intellig.branch.rename',
      'intellig.branch.delete',
      'intellig.branch.compareWithCurrent',
      'intellig.branch.mergeIntoCurrent',
      'intellig.branch.rebaseCurrentOnto',
      'intellig.branch.push',
    ]);
    // `Set Upstream…` is handled inline by the popup (nested QuickPick), so it
    // intentionally carries no commandId — every OTHER entry must route to a
    // registered command.
    for (const item of items) {
      if (item.action === 'local.setUpstream') {
        assert.strictEqual(item.commandId, undefined, 'Set Upstream… is inline-handled');
        continue;
      }
      assert.ok(item.commandId, `${label(item)} missing commandId`);
      assert.ok(expected.has(item.commandId), `unknown commandId ${item.commandId ?? ''}`);
    }
  });

  it('offers a `Set Upstream…` entry positioned after Push… and before Rename…/Delete', () => {
    const labels = items.map((i) => label(i));
    assert.ok(
      labels.some((l) => l.includes('Set Upstream…')),
      'Set Upstream… entry present'
    );

    const actions = items.map((i) => i.action);
    const pushIdx = actions.indexOf('local.push');
    const setUpstreamIdx = actions.indexOf('local.setUpstream');
    const renameIdx = actions.indexOf('rename');

    assert.ok(setUpstreamIdx !== -1, 'expected local.setUpstream action');
    assert.ok(pushIdx < setUpstreamIdx, 'Set Upstream… must follow Push…');
    assert.ok(setUpstreamIdx < renameIdx, 'Set Upstream… must precede Rename…');
  });

  it('interpolates branch name into `New Branch from …` and `Rebase Current onto …` labels', () => {
    const labels = items.map((i) => label(i));
    assert.ok(
      labels.some((l) => l.includes(`New Branch from '${localDevelop.name}'…`)),
      "New Branch from '<branch>'…"
    );
    assert.ok(
      labels.some((l) => l.includes(`Rebase Current onto '${localDevelop.name}'`)),
      "Rebase Current onto '<branch>'"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Set Upstream… inline handler
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — _handleSetUpstream', () => {
  const repo = {
    rootUri: Uri.file('/repo'),
    head: { name: 'refs/heads/develop', commit: 'bbb2222', ahead: 0, behind: 0 },
  } as unknown as IRepository;

  interface HandlerSeam {
    _handleSetUpstream(
      repo: IRepository,
      branch: IBranch
    ): Promise<{ cancelled: boolean; action?: string }>;
    _showBranchActionMenu(
      repo: IRepository,
      branch: IBranch,
      currentBranchName?: string
    ): Promise<{ cancelled: boolean; action?: string }>;
  }

  // Build a BranchPopup with a stub git service and capture the calls. The
  // status-bar listener is harmless; `dispose()` cleans it up.
  function makePopup(overrides: Partial<IGitService>): {
    popup: BranchPopup;
    setUpstreamCalls: Array<[string, string]>;
  } {
    const repoChangeEmitter = new EventEmitter<IRepository>();
    const setUpstreamCalls: Array<[string, string]> = [];
    const gitService = {
      getRepositories: () => [],
      getRepository: async () => undefined,
      onDidChangeRepository: repoChangeEmitter.event,
      reloadRepository: async () => undefined,
      setBranchUpstream: (_r: IRepository, local: string, upstream: string) => {
        setUpstreamCalls.push([local, upstream]);
        return okAsync(undefined);
      },
      ...overrides,
    } as unknown as IGitService;
    return { popup: new BranchPopup(gitService), setUpstreamCalls };
  }

  let oQuickPick: typeof vscode.window.showQuickPick;
  let oInfo: typeof vscode.window.showInformationMessage;
  let oErr: typeof vscode.window.showErrorMessage;
  let infos: string[];
  let errors: string[];

  beforeEach(() => {
    oQuickPick = vscode.window.showQuickPick;
    oInfo = vscode.window.showInformationMessage;
    oErr = vscode.window.showErrorMessage;
    infos = [];
    errors = [];
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = (
      m: string
    ): Promise<string | undefined> => {
      infos.push(m);
      return Promise.resolve(undefined);
    };
    (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = (
      m: string
    ): Promise<string | undefined> => {
      errors.push(m);
      return Promise.resolve(undefined);
    };
  });

  afterEach(() => {
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = oQuickPick;
    (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
      oInfo;
    (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = oErr;
  });

  it('sets the chosen remote ref as upstream and shows a success toast', async () => {
    const { popup, setUpstreamCalls } = makePopup({
      getBranches: async () => [localDevelop, remoteMain, remoteDevelop, remoteFeatureAuth],
    });
    // The nested picker resolves to the origin/feature/auth item.
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = (
      items: Array<{ branch: IBranch }>
    ): Promise<unknown> =>
      Promise.resolve(items.find((i) => i.branch.name === 'origin/feature/auth'));

    try {
      const result = await (popup as unknown as HandlerSeam)._handleSetUpstream(repo, localDevelop);
      assert.strictEqual(result.cancelled, false);
      assert.deepStrictEqual(setUpstreamCalls, [['develop', 'origin/feature/auth']]);
      assert.strictEqual(infos.length, 1);
      assert.ok(infos[0].includes("'develop' now tracks 'origin/feature/auth'"), infos[0]);
      assert.strictEqual(errors.length, 0);
    } finally {
      popup.dispose();
    }
  });

  it('does NOT call setBranchUpstream and informs the user when there are no remote branches', async () => {
    const { popup, setUpstreamCalls } = makePopup({
      getBranches: async () => [localDevelop, localMain],
    });
    let pickerShown = false;
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick =
      (): Promise<unknown> => {
        pickerShown = true;
        return Promise.resolve(undefined);
      };

    try {
      const result = await (popup as unknown as HandlerSeam)._handleSetUpstream(repo, localDevelop);
      assert.strictEqual(result.cancelled, true);
      assert.strictEqual(setUpstreamCalls.length, 0, 'no op when no remotes');
      assert.strictEqual(pickerShown, false, 'no picker when no remotes');
      assert.strictEqual(infos.length, 1);
      assert.ok(infos[0].includes('No remote branches'), infos[0]);
    } finally {
      popup.dispose();
    }
  });

  it('does NOT call setBranchUpstream when the user cancels the picker', async () => {
    const { popup, setUpstreamCalls } = makePopup({
      getBranches: async () => [localDevelop, remoteMain],
    });
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = (): Promise<unknown> =>
      Promise.resolve(undefined);

    try {
      const result = await (popup as unknown as HandlerSeam)._handleSetUpstream(repo, localDevelop);
      assert.strictEqual(result.cancelled, true);
      assert.strictEqual(setUpstreamCalls.length, 0, 'no op on cancelled pick');
      assert.strictEqual(infos.length, 0);
    } finally {
      popup.dispose();
    }
  });

  it('surfaces a sanitized error toast when setBranchUpstream fails', async () => {
    const { popup } = makePopup({
      getBranches: async () => [localDevelop, remoteMain],
      setBranchUpstream: () =>
        errAsync(
          new CommandFailedError(1, '', 'fatal: https://alice:secret@example.com/repo.git denied')
        ),
    });
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = (
      items: Array<{ branch: IBranch }>
    ): Promise<unknown> => Promise.resolve(items[0]);

    try {
      const result = await (popup as unknown as HandlerSeam)._handleSetUpstream(repo, localDevelop);
      assert.strictEqual(result.cancelled, true);
      assert.strictEqual(errors.length, 1);
      assert.ok(errors[0].startsWith('Failed to set upstream:'), errors[0]);
      assert.ok(!errors[0].includes('alice:secret'), 'must not leak credentials');
    } finally {
      popup.dispose();
    }
  });

  // Wiring guard: proves _showBranchActionMenu intercepts the accepted
  // Set Upstream… entry and routes it to _handleSetUpstream INSTEAD of
  // _dispatchSelectedAction. Without the interception the entry (which has no
  // commandId) would fall through to the "Coming soon: …" branch and never
  // call setBranchUpstream — so this fails if the interception is removed.
  it('routes the accepted Set Upstream… entry through _handleSetUpstream (not "Coming soon" dispatch)', async () => {
    const { popup, setUpstreamCalls } = makePopup({
      getBranches: async () => [localDevelop, remoteMain, remoteFeatureAuth],
    });
    // The action-menu QuickPick carries an entry with action local.setUpstream;
    // the nested remote-picker carries items whose branch is a remote. Use that
    // shape difference to drive both showQuickPick calls from one stub.
    (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = (
      items: IBranchQuickPickItem[]
    ): Promise<unknown> => {
      const setUpstreamItem = items.find((i) => i.action === 'local.setUpstream');
      if (setUpstreamItem) {
        return Promise.resolve(setUpstreamItem); // action menu → pick Set Upstream…
      }
      return Promise.resolve(items.find((i) => i.branch?.name === 'origin/feature/auth'));
    };

    try {
      const result = await (popup as unknown as HandlerSeam)._showBranchActionMenu(
        repo,
        localDevelop,
        'main'
      );
      assert.strictEqual(result.action, 'local.setUpstream', 'reached the inline handler');
      assert.deepStrictEqual(setUpstreamCalls, [['develop', 'origin/feature/auth']]);
      assert.ok(
        !infos.some((m) => m.startsWith('Coming soon')),
        'must NOT fall through to the Coming soon dispatch'
      );
    } finally {
      popup.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tag action menu
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — buildTagActionMenu', () => {
  const items = buildTagActionMenu(tagV1);

  it('includes IntelliJ-parity entries: Checkout (Detached), New Branch from Tag…, Cherry-Pick, Delete, Push', () => {
    const labels = items.map((i) => label(i));
    assert.ok(
      labels.some((l) => l.includes('Checkout (Detached)')),
      'Checkout (Detached)'
    );
    assert.ok(
      labels.some((l) => l.includes('New Branch from Tag…')),
      'New Branch from Tag…'
    );
    assert.ok(
      labels.some((l) => l.endsWith('Cherry-Pick')),
      'Cherry-Pick'
    );
    assert.ok(
      labels.some((l) => l.includes('Merge into Current')),
      'Merge into Current'
    );
    assert.ok(
      labels.some((l) => l === '$(trash) Delete'),
      'Delete'
    );
    assert.ok(
      labels.some((l) => l.endsWith('Push')),
      'Push'
    );
  });

  it('routes each entry to an existing `intellig.tag.*` command ID', () => {
    const expected = new Set([
      'intellig.tag.checkoutDetached',
      'intellig.tag.newBranchFrom',
      'intellig.tag.cherryPick',
      'intellig.tag.mergeIntoCurrent',
      'intellig.tag.delete',
      'intellig.tag.push',
    ]);
    for (const item of items) {
      assert.ok(item.commandId, `${label(item)} missing commandId`);
      assert.ok(expected.has(item.commandId), `unknown commandId ${item.commandId ?? ''}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-repo isolation for Recent LRU (data shape contract)
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — Recent LRU per-repo shape', () => {
  // We do not instantiate BranchPopup here (createStatusBarItem isn't mocked);
  // we just verify the LRU-update math works correctly when partitioned by
  // repo-root key, which is exactly how BranchPopup.recordCheckout stores it.
  const repoA: IRepository = {
    rootUri: vscode.Uri.file('/a'),
    state: 'idle',
    remotes: [],
    submodules: [],
  };
  const repoB: IRepository = {
    rootUri: vscode.Uri.file('/b'),
    state: 'idle',
    remotes: [],
    submodules: [],
  };

  it('maintains independent LRUs per repo-root key', () => {
    const map: Record<string, string[]> = {};

    map[repoA.rootUri.fsPath] = updateRecentLru(map[repoA.rootUri.fsPath] ?? [], 'feature/x');
    map[repoB.rootUri.fsPath] = updateRecentLru(map[repoB.rootUri.fsPath] ?? [], 'bugfix/y');
    map[repoA.rootUri.fsPath] = updateRecentLru(map[repoA.rootUri.fsPath], 'main');

    assert.deepStrictEqual(map[repoA.rootUri.fsPath], ['main', 'feature/x']);
    assert.deepStrictEqual(map[repoB.rootUri.fsPath], ['bugfix/y']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Kept-for-compat tests from the previous flat-picker era
// (data-structure tests that still make sense on the redesigned popup)
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup - Branch Data Structures', () => {
  it('supports local branch type', () => {
    assert.strictEqual(localMain.type, 'local');
    assert.strictEqual(localMain.isHead, true);
  });

  it('supports remote branch type', () => {
    assert.strictEqual(remoteMain.type, 'remote');
    assert.strictEqual(remoteMain.name, 'origin/main');
  });

  it('supports upstream information', () => {
    assert.ok(localMain.upstream);
    assert.strictEqual(localMain.upstream.remote, 'origin');
  });

  it('supports tag shape', () => {
    assert.strictEqual(tagV1.name, 'v1.0.0');
    assert.strictEqual(tagV2.isAnnotated, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Favorites
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — updateFavoritesList', () => {
  it('appends a new branch when favorite=true', () => {
    const next = updateFavoritesList(['main'], 'develop', true);
    assert.deepStrictEqual(next, ['main', 'develop']);
  });

  it('removes a branch when favorite=false', () => {
    const next = updateFavoritesList(['main', 'develop'], 'develop', false);
    assert.deepStrictEqual(next, ['main']);
  });

  it('deduplicates existing entries on re-add (preserves insertion order)', () => {
    const next = updateFavoritesList(['main', 'develop', 'feature/x'], 'develop', true);
    // develop is removed then re-appended → moves to the end.
    assert.deepStrictEqual(next, ['main', 'feature/x', 'develop']);
  });

  it("is a no-op when removing a branch that isn't starred", () => {
    const next = updateFavoritesList(['main'], 'ghost', false);
    assert.deepStrictEqual(next, ['main']);
  });

  it('returns a new array (does not mutate input)', () => {
    const input = ['a', 'b'];
    const next = updateFavoritesList(input, 'c', true);
    assert.notStrictEqual(next, input);
    assert.deepStrictEqual(input, ['a', 'b']);
  });
});

describe('BranchPopup — readLegacyFavorites', () => {
  function mkMemento(initial?: unknown): vscode.Memento {
    const store = new Map<string, unknown>();
    if (initial !== undefined) {
      store.set(FAVORITE_BRANCHES_STATE_KEY, initial);
    }
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        return store.has(key) ? (store.get(key) as T) : defaultValue;
      },
      update: async (k: string, v: unknown): Promise<void> => {
        if (v === undefined) {
          store.delete(k);
        } else {
          store.set(k, v);
        }
      },
      keys: () => Array.from(store.keys()),
    } as unknown as vscode.Memento;
  }

  it('returns an empty array when no favorites are stored', () => {
    assert.deepStrictEqual(readLegacyFavorites(mkMemento()), []);
  });

  it('returns a copy (not the stored reference)', () => {
    const mem = mkMemento(['main']);
    const first = readLegacyFavorites(mem);
    first.push('tampered');
    const second = readLegacyFavorites(mem);
    assert.deepStrictEqual(second, ['main']);
  });

  it('returns [] when the stored value is not an array (defensive)', () => {
    const mem = mkMemento({ not: 'an array' });
    assert.deepStrictEqual(readLegacyFavorites(mem), []);
  });

  it('returns [] when no workspaceState is provided', () => {
    assert.deepStrictEqual(readLegacyFavorites(undefined), []);
  });
});

describe('BranchPopup — buildSectionedItems renders Favorites', () => {
  it('emits a `★ Favorites` separator above Recent/Local when favorites exist', () => {
    const items = buildSectionedItems({
      localBranches: [localMain, localDevelop, localFeatureAuth],
      remoteBranches: [],
      tags: [],
      recentBranchNames: ['develop'],
      favoriteBranchNames: ['feature/auth'],
      currentBranchName: 'main',
    });
    const sepLabels = items
      .filter((i) => i.kind === vscode.QuickPickItemKind.Separator)
      .map((i) => (typeof i.label === 'string' ? i.label : ''));
    assert.strictEqual(
      sepLabels[0],
      '★ Favorites',
      `expected Favorites first, got: ${sepLabels.join(', ')}`
    );
  });

  it('suppresses the Favorites section when the list is empty', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      favoriteBranchNames: [],
      currentBranchName: 'main',
    });
    const hasFav = items.some(
      (i) =>
        i.kind === vscode.QuickPickItemKind.Separator &&
        typeof i.label === 'string' &&
        i.label.includes('Favorites')
    );
    assert.strictEqual(hasFav, false);
  });

  it('filters out favorites that reference branches no longer present', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      favoriteBranchNames: ['ghost-branch', 'main'],
      currentBranchName: undefined,
    });
    // Favorites header present, only `main` underneath (ghost-branch skipped).
    const favStartIdx = items.findIndex(
      (i) =>
        i.kind === vscode.QuickPickItemKind.Separator &&
        typeof i.label === 'string' &&
        i.label.includes('Favorites')
    );
    assert.ok(favStartIdx >= 0, 'Favorites separator should be present');
    // Walk items after the Favorites header until the next separator; those
    // are the favorites rows.
    const favRows: typeof items = [];
    for (let i = favStartIdx + 1; i < items.length; i++) {
      if (items[i].kind === vscode.QuickPickItemKind.Separator) {
        break;
      }
      favRows.push(items[i]);
    }
    assert.strictEqual(
      favRows.length,
      1,
      `expected only main under Favorites, got ${favRows.length}`
    );
    assert.strictEqual(favRows[0].branch?.name, 'main');
  });

  it('suppresses Favorites header when all favorites reference missing branches', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      favoriteBranchNames: ['ghost-one', 'ghost-two'],
      currentBranchName: undefined,
    });
    const hasFav = items.some(
      (i) =>
        i.kind === vscode.QuickPickItemKind.Separator &&
        typeof i.label === 'string' &&
        i.label.includes('Favorites')
    );
    assert.strictEqual(
      hasFav,
      false,
      'Favorites header must not appear when resolved list is empty'
    );
  });

  it('renders per-branch star buttons on Local / Remote items (empty star when not favorite)', () => {
    const items = buildSectionedItems({
      localBranches: [localMain, localDevelop],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      favoriteBranchNames: ['develop'],
      currentBranchName: 'main',
    });
    const devRow = items.find((i) => i.branch?.name === 'develop' && i.section === 'local');
    const mainRow = items.find((i) => i.branch?.name === 'main' && i.section === 'local');
    assert.ok(
      devRow?.buttons && devRow.buttons.length === 1,
      'develop row should have star button'
    );
    assert.ok(mainRow?.buttons && mainRow.buttons.length === 1, 'main row should have star button');
    // develop is starred → full star tooltip
    assert.strictEqual(devRow.buttons[0].tooltip, 'Unstar');
    assert.strictEqual(mainRow.buttons[0].tooltip, 'Add to Favorites');
  });
});

// ─── R6-Gap-C: BranchPopup._initializeStatusBar multi-root selection ─────────
describe('BranchPopup - R6-Gap-C multi-root status-bar init', () => {
  function makeRepo(branchName: string, rootPath: string): IRepository {
    return {
      rootUri: Uri.file(rootPath),
      state: 'idle',
      head: {
        name: `refs/heads/${branchName}`,
        commit: 'deadbeefcafebabe0000000000000000deadbeef',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
  }

  it("selects the active-editor's repo (repoB), not repositories[0] (repoA)", async () => {
    const repoA = makeRepo('main-A', '/repo-a');
    const repoB = makeRepo('main-B', '/repo-b');

    const repoChangeEmitter = new EventEmitter<IRepository>();
    const gitService = {
      getRepositories: () => [repoA, repoB],
      getRepository: async () => undefined,
      onDidChangeRepository: repoChangeEmitter.event,
    } as unknown as IGitService;

    // Capture the status bar item so we can read its text.
    const originalCreate = vscode.window.createStatusBarItem;
    let capturedItem:
      | {
          text: string;
          tooltip: unknown;
          command: unknown;
          show: () => void;
          hide: () => void;
          dispose: () => void;
        }
      | undefined;
    (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem = () => {
      capturedItem = {
        text: '',
        tooltip: undefined,
        command: undefined,
        show: () => {},
        hide: () => {},
        dispose: () => {},
      };
      return capturedItem;
    };

    const originalActive = (vscode.window as unknown as { activeTextEditor: unknown })
      .activeTextEditor;
    try {
      // Point the active editor at a file under /repo-b.
      (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
        document: {
          uri: Uri.file('/repo-b/src/foo.ts'),
        },
      };

      const popup = new BranchPopup(gitService);
      // _initializeStatusBar is async; wait a tick.
      await new Promise((r) => setTimeout(r, 10));

      assert.ok(capturedItem, 'Status bar item should have been created');
      assert.ok(
        capturedItem.text.includes('main-B'),
        `expected active-editor repo's branch "main-B" in status text, got "${capturedItem.text}"`
      );
      assert.ok(
        !capturedItem.text.includes('main-A'),
        `did NOT expect repositories[0]'s branch "main-A" in status text, got "${capturedItem.text}"`
      );

      popup.dispose();
    } finally {
      (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = originalActive;
      (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem =
        originalCreate;
    }
  });
});

// `_dispatchSelectedAction` catch block must run the raw command-execution
// error through `sanitizeGitError` before pushing it into the
// showErrorMessage toast template. Branch commands often surface
// `git push`/`git pull` stderr that contains credentialed remote URLs and
// POSIX home paths; without sanitisation these leak into the user's
// notification history.
describe('BranchPopup TL-72 — action-path toast routes through sanitizeGitError', () => {
  it('_dispatchSelectedAction sanitizes credentialed URL + home path in toast', async () => {
    const RAW = 'fail: https://alice:secret@example.com/repo.git\n/Users/alice/project';
    const EXPECTED = 'fail: https://<redacted>@example.com/repo.git\n~/project';

    const repoChangeEmitter = new EventEmitter<IRepository>();
    const gitService = {
      getRepositories: () => [],
      getRepository: async () => undefined,
      onDidChangeRepository: repoChangeEmitter.event,
    } as unknown as IGitService;

    // Stub commands.getCommands and commands.executeCommand to drive
    // the catch block. getCommands returns the registered list (so the
    // dispatcher proceeds past the "Coming soon" fallback);
    // executeCommand throws with a credentialed payload.
    const oGetCommands = vscode.commands.getCommands;
    const oExec = vscode.commands.executeCommand;
    (vscode.commands as unknown as { getCommands: unknown }).getCommands = (): Thenable<string[]> =>
      Promise.resolve(['intellig.branch.checkout']);
    (vscode.commands as unknown as { executeCommand: unknown }).executeCommand =
      (): Promise<never> => Promise.reject(new Error(RAW));

    const errors: string[] = [];
    const oErr = vscode.window.showErrorMessage;
    (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = (
      m: string
    ): Promise<string | undefined> => {
      errors.push(m);
      return Promise.resolve(undefined);
    };

    try {
      const popup = new BranchPopup(gitService);
      try {
        const selected: IBranchQuickPickItem = {
          label: '$(git-branch) feature/x',
          commandId: 'intellig.branch.checkout',
          branch: {
            name: 'feature/x',
            type: 'local',
            commit: 'abcdef0',
            isHead: false,
          },
        };

        const result = await (
          popup as unknown as {
            _dispatchSelectedAction: (
              repo: IRepository | undefined,
              s: IBranchQuickPickItem
            ) => Promise<{ cancelled: boolean }>;
          }
        )._dispatchSelectedAction(undefined, selected);

        assert.strictEqual(result.cancelled, true);
        assert.strictEqual(errors.length, 1, 'expected one error toast');
        assert.strictEqual(errors[0], `Branch operation failed: ${EXPECTED}`);
        assert.ok(!errors[0].includes('alice:secret'), 'toast must not leak credentials');
        assert.ok(!errors[0].includes('/Users/alice'), 'toast must not leak home path');
      } finally {
        popup.dispose();
      }
    } finally {
      (vscode.commands as unknown as { getCommands: unknown }).getCommands = oGetCommands;
      (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = oExec;
      (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = oErr;
    }
  });
});

// BranchPopup runs its own status-bar item parallel to StatusBarService.
// When the empty-repo shape from GitService.loadRepository is
// `{ name: 'main', commit: '' }`, branch on `name && !commit` first and
// render the same `(no commits yet)` label as StatusBarService — without
// this guard the two surfaces silently disagree.
describe('BranchPopup — empty-repo status-bar parity', () => {
  it('renders "$(git-branch) <name> (no commits yet)" for an empty repo', async () => {
    const repoChangeEmitter = new EventEmitter<IRepository>();
    const emptyRepo: IRepository = {
      rootUri: Uri.file('/test/empty-repo'),
      state: 'idle',
      head: { name: 'main', commit: '', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
    const gitService = {
      getRepositories: () => [emptyRepo],
      getRepository: async () => emptyRepo,
      onDidChangeRepository: repoChangeEmitter.event,
    } as unknown as IGitService;

    const originalCreate = vscode.window.createStatusBarItem;
    let capturedItem:
      | {
          text: string;
          tooltip: string | undefined;
          command: unknown;
          show: () => void;
          hide: () => void;
          dispose: () => void;
        }
      | undefined;
    (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem = () => {
      capturedItem = {
        text: '',
        tooltip: undefined,
        command: undefined,
        show: () => {},
        hide: () => {},
        dispose: () => {},
      };
      return capturedItem;
    };

    try {
      const popup = new BranchPopup(gitService);
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(capturedItem, 'expected status-bar item');
      assert.ok(
        capturedItem.text.includes('$(git-branch) main (no commits yet)'),
        `expected empty-repo label, got "${capturedItem.text}"`
      );
      assert.ok(
        typeof capturedItem.tooltip === 'string' && capturedItem.tooltip.includes('no commits yet'),
        `expected empty-repo tooltip, got ${JSON.stringify(capturedItem.tooltip)}`
      );
      popup.dispose();
    } finally {
      (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem =
        originalCreate;
    }
  });

  it('renders the configured initial branch (e.g. "trunk"), not always "main"', async () => {
    const repoChangeEmitter = new EventEmitter<IRepository>();
    const trunkRepo: IRepository = {
      rootUri: Uri.file('/test/trunk-repo'),
      state: 'idle',
      head: { name: 'trunk', commit: '', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
    const gitService = {
      getRepositories: () => [trunkRepo],
      getRepository: async () => trunkRepo,
      onDidChangeRepository: repoChangeEmitter.event,
    } as unknown as IGitService;

    const originalCreate = vscode.window.createStatusBarItem;
    let capturedItem: { text: string; tooltip: string | undefined } | undefined;
    (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem = () => {
      capturedItem = {
        text: '',
        tooltip: undefined,
      };
      Object.assign(capturedItem, {
        command: undefined,
        show: () => {},
        hide: () => {},
        dispose: () => {},
      });
      return capturedItem;
    };

    try {
      const popup = new BranchPopup(gitService);
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(capturedItem);
      assert.ok(
        capturedItem.text.includes('trunk (no commits yet)'),
        `expected trunk in label, got "${capturedItem.text}"`
      );
      popup.dispose();
    } finally {
      (vscode.window as unknown as { createStatusBarItem: unknown }).createStatusBarItem =
        originalCreate;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Header actions — git4idea GitBranchesTreePopup header (New Branch / Fetch /
// Settings gear). Mirrors backend/resources/intellij.vcs.git.backend.xml
// (Git.CreateNewBranch, Git.Branches.Popup.Fetch) and shared
// GitBranchesTreePopupSettings.
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — buildBranchPopupHeaderButtons', () => {
  it('exposes New Branch, Fetch, and Settings header buttons in that order', () => {
    const buttons = buildBranchPopupHeaderButtons();
    assert.deepStrictEqual(
      buttons.map((b) => b.action),
      ['new-branch', 'fetch', 'settings']
    );
  });

  it('wires New Branch to the intellig.branch.new command', () => {
    const newBranch = buildBranchPopupHeaderButtons().find((b) => b.action === 'new-branch');
    assert.ok(newBranch);
    assert.strictEqual(newBranch.commandId, 'intellig.branch.new');
  });

  it('wires Fetch to the existing intellig.fetch command', () => {
    const fetch = buildBranchPopupHeaderButtons().find((b) => b.action === 'fetch');
    assert.ok(fetch);
    assert.strictEqual(fetch.commandId, 'intellig.fetch');
  });

  it('leaves the Settings gear without a command (it opens the in-popup toggle menu)', () => {
    const settings = buildBranchPopupHeaderButtons().find((b) => b.action === 'settings');
    assert.ok(settings);
    assert.strictEqual(settings.commandId, undefined);
  });

  it('gives every header button a non-empty tooltip', () => {
    for (const b of buildBranchPopupHeaderButtons()) {
      assert.ok(
        typeof b.tooltip === 'string' && b.tooltip.length > 0,
        `expected tooltip for action ${b.action}`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings toggle menu — git4idea GitBranchesTreePopupSettings gear toggles
// (group by directory, show recent branches, show tags).
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — buildSettingsToggleItems', () => {
  const allOn: IBranchPopupSettings = {
    groupByDirectory: true,
    showRecentBranches: true,
    showTags: true,
  };

  it('emits one toggle per setting: groupByDirectory, showRecentBranches, showTags', () => {
    const items = buildSettingsToggleItems(allOn);
    assert.deepStrictEqual(
      items.map((i) => i.setting),
      ['groupByDirectory', 'showRecentBranches', 'showTags']
    );
  });

  it('marks a toggle picked when its setting is enabled', () => {
    const items = buildSettingsToggleItems({ ...allOn, showTags: true });
    const tags = items.find((i) => i.setting === 'showTags');
    assert.ok(tags);
    assert.strictEqual(tags.picked, true);
  });

  it('marks a toggle un-picked when its setting is disabled', () => {
    const items = buildSettingsToggleItems({ ...allOn, showTags: false });
    const tags = items.find((i) => i.setting === 'showTags');
    assert.ok(tags);
    assert.strictEqual(tags.picked, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readBranchPopupSettings — reads the additive intellig.branches.* settings,
// defaulting to the existing always-on behaviour.
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — readBranchPopupSettings', () => {
  // Drive config through the production `vscode.workspace` handle (the same
  // instance readBranchPopupSettings reads) so the spec exercises the real
  // configuration round-trip rather than a side-channel.
  async function setBranchSetting(key: string, value: boolean | undefined): Promise<void> {
    await vscode.workspace
      .getConfiguration('intellig')
      .update(`branches.${key}`, value, vscode.ConfigurationTarget.Global);
  }

  afterEach(async () => {
    await setBranchSetting('showTags', undefined);
    await setBranchSetting('showRecentBranches', undefined);
    await setBranchSetting('groupByDirectory', undefined);
  });

  it('defaults all toggles to true (preserves existing popup behaviour)', () => {
    const settings = readBranchPopupSettings();
    assert.deepStrictEqual(settings, {
      showTags: true,
      showRecentBranches: true,
      groupByDirectory: true,
    });
  });

  it('reflects a user-disabled showTags setting', async () => {
    await setBranchSetting('showTags', false);
    assert.strictEqual(readBranchPopupSettings().showTags, false);
  });

  it('reflects a user-disabled groupByDirectory setting', async () => {
    await setBranchSetting('groupByDirectory', false);
    assert.strictEqual(readBranchPopupSettings().groupByDirectory, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSectionedItems — settings-toggle integration
// ─────────────────────────────────────────────────────────────────────────────

describe('BranchPopup — buildSectionedItems settings toggles', () => {
  it('suppresses the Tags section when showTags is false', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [],
      tags: [tagV1, tagV2],
      recentBranchNames: [],
      currentBranchName: 'main',
      showTags: false,
    });
    assert.ok(!items.some((i) => label(i) === 'Tags'), 'Tags header should be suppressed');
    assert.ok(!items.some((i) => i.tag), 'no tag items should be emitted');
  });

  it('still renders the Tags section when showTags is true (default)', () => {
    const items = buildSectionedItems({
      localBranches: [localMain],
      remoteBranches: [],
      tags: [tagV1],
      recentBranchNames: [],
      currentBranchName: 'main',
    });
    assert.ok(
      items.some((i) => label(i) === 'Tags'),
      'Tags header should be present by default'
    );
  });

  it('suppresses the Recent section when showRecentBranches is false', () => {
    const items = buildSectionedItems({
      localBranches: [localMain, localDevelop],
      remoteBranches: [],
      tags: [],
      recentBranchNames: ['develop'],
      currentBranchName: 'main',
      showRecentBranches: false,
    });
    assert.ok(!items.some((i) => label(i) === 'Recent'), 'Recent header should be suppressed');
  });

  it('drops auto-indent when groupByDirectory is false', () => {
    const items = buildSectionedItems({
      localBranches: [localFeatureAuth, localFeatureDashboard, localFeatureApi],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      currentBranchName: 'main',
      groupByDirectory: false,
    });
    const featureItem = items.find((i) => i.branch?.name === 'feature/auth');
    assert.ok(featureItem);
    assert.strictEqual(
      label(featureItem),
      'feature/auth',
      'label should not carry the 2-space indent prefix when grouping is off'
    );
  });

  it('keeps auto-indent when groupByDirectory is true (default)', () => {
    const items = buildSectionedItems({
      localBranches: [localFeatureAuth, localFeatureDashboard, localFeatureApi],
      remoteBranches: [],
      tags: [],
      recentBranchNames: [],
      currentBranchName: 'main',
    });
    const featureItem = items.find((i) => i.branch?.name === 'feature/auth');
    assert.ok(featureItem);
    assert.strictEqual(label(featureItem), '  feature/auth');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unified favorites store — the popup and the Branches tree must share ONE
// favorites set (git4idea parity: a single GitRepositoryModel.favoriteRefs).
// Before unification the popup persisted to workspaceState under
// `intellig.favoriteBranches` while the tree used globalState under
// `intellig.branchTree.favorites`, so a branch starred on one surface never
// appeared on the other.
// ─────────────────────────────────────────────────────────────────────────────

class InMemoryFavoritesStore implements IFavoritesStore {
  private _data: string[];
  private readonly _onDidChangeFavorites = new EventEmitter<void>();
  readonly onDidChangeFavorites = this._onDidChangeFavorites.event;
  constructor(initial: string[] = []) {
    this._data = [...initial];
  }
  read(): string[] {
    return [...this._data];
  }
  write(favorites: string[]): void {
    this._data = [...favorites];
    this._onDidChangeFavorites.fire();
  }
  dispose(): void {
    this._onDidChangeFavorites.dispose();
  }
}

function mkFavoritesGitService(): IGitService {
  return createMockGitService(attachedRepo('main', 'b'.repeat(40)));
}

describe('BranchPopup — favorites share the injected store with the branch tree', () => {
  it('reads favorites the branch tree wrote through the shared store', () => {
    const store = new InMemoryFavoritesStore();
    const tree = new BranchTreeProvider(mkFavoritesGitService(), undefined, store);
    const popup = new BranchPopup(mkFavoritesGitService(), undefined, undefined, store);

    tree.toggleFavorite('feature/auth');

    assert.deepStrictEqual(popup.getFavorites(), ['feature/auth']);
    popup.dispose();
    tree.dispose();
  });

  it('writes favorites the branch tree can read through the shared store', async () => {
    const store = new InMemoryFavoritesStore();
    const popup = new BranchPopup(mkFavoritesGitService(), undefined, undefined, store);

    await popup.updateFavorites('release', true);

    // A tree over the same store loads the popup's star at construction.
    const tree = new BranchTreeProvider(mkFavoritesGitService(), undefined, store);
    assert.strictEqual(tree.isFavorite('release'), true);
    assert.deepStrictEqual(store.read(), ['release']);
    popup.dispose();
    tree.dispose();
  });

  it('reflects a popup star in an ALREADY-OPEN tree without reconstructing it', async () => {
    const store = new InMemoryFavoritesStore();
    const tree = new BranchTreeProvider(mkFavoritesGitService(), undefined, store);
    const popup = new BranchPopup(mkFavoritesGitService(), undefined, undefined, store);

    let treeChanges = 0;
    const sub = tree.onDidChangeTreeData(() => {
      treeChanges += 1;
    });

    await popup.updateFavorites('release', true);

    assert.strictEqual(
      tree.isFavorite('release'),
      true,
      'the existing tree instance must see a star added via the popup'
    );
    assert.ok(treeChanges > 0, 'the tree must fire a data-change so the view repaints');

    sub.dispose();
    popup.dispose();
    tree.dispose();
  });
});

describe('BranchPopup — legacy favorites migration', () => {
  function mkWorkspaceState(initial?: Record<string, unknown>): vscode.Memento {
    const store = new Map<string, unknown>(Object.entries(initial ?? {}));
    return {
      get<T>(key: string, def?: T): T | undefined {
        return store.has(key) ? (store.get(key) as T) : def;
      },
      update: async (k: string, v: unknown): Promise<void> => {
        if (v === undefined) {
          store.delete(k);
        } else {
          store.set(k, v);
        }
      },
      keys: () => Array.from(store.keys()),
    } as unknown as vscode.Memento;
  }

  it('unions pre-existing workspace favorites into the shared store on construction', () => {
    const ws = mkWorkspaceState({ [FAVORITE_BRANCHES_STATE_KEY]: ['main', 'develop'] });
    const store = new InMemoryFavoritesStore(['main', 'release']);
    const popup = new BranchPopup(mkFavoritesGitService(), ws, undefined, store);

    assert.deepStrictEqual(store.read(), ['main', 'release', 'develop']);
    popup.dispose();
  });

  it('clears the legacy workspace favorites key after migration', () => {
    const ws = mkWorkspaceState({ [FAVORITE_BRANCHES_STATE_KEY]: ['main'] });
    const store = new InMemoryFavoritesStore();
    const popup = new BranchPopup(mkFavoritesGitService(), ws, undefined, store);

    assert.strictEqual(ws.get(FAVORITE_BRANCHES_STATE_KEY), undefined);
    assert.deepStrictEqual(store.read(), ['main']);
    popup.dispose();
  });

  it('is a no-op when there are no legacy favorites to migrate', () => {
    const ws = mkWorkspaceState();
    const store = new InMemoryFavoritesStore(['kept']);
    const popup = new BranchPopup(mkFavoritesGitService(), ws, undefined, store);

    assert.deepStrictEqual(store.read(), ['kept']);
    popup.dispose();
  });
});

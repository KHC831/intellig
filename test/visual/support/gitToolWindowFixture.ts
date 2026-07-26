/**
 * Production CSS stack and markup for the tabbed Git tool window specs.
 *
 * CSS: the host emits one <style> block in GitToolWindowProvider._getHtml —
 * codicon @font-face, then _getThreePanelStyles(), then toolWindowTabStyles().
 * gitToolWindowCss() renders the SAME producers: the five-sheet concat is the
 * production function itself, so the tab-sheet order a spec measures cannot
 * drift from the one the document ships. What is still mirrored here rather
 * than imported is the outer order (three-panel styles before the tab sheets)
 * and the codicon omission — that block interpolates a webview asset URI no
 * plain browser page can resolve, and no spec here asserts an icon glyph.
 *
 * Markup: wrapTabbedBody plus the four production tab-body renderers, driven
 * by canned states built here. The LOG tab body is the one part that cannot be
 * produced without a live provider (it is assembled inline in _getHtml from
 * graph state), so it ships empty; every spec activates one of the four
 * renderable tabs and the empty log panel stays display:none, never measured.
 */

import { wrapTabbedBody } from '../../../src/git-core/gitToolWindow/html/commonHtml';
import { renderConsoleTabBody } from '../../../src/git-core/gitToolWindow/html/consoleHtml';
import { renderHistoryTabBody } from '../../../src/git-core/gitToolWindow/html/historyHtml';
import { renderIncomingTabBody } from '../../../src/git-core/gitToolWindow/html/incomingHtml';
import { renderUpdateInfoTabBody } from '../../../src/git-core/gitToolWindow/html/updateInfoHtml';
import { toolWindowTabStyles } from '../../../src/git-core/gitToolWindow/GitToolWindowProvider';
import { buildThreePanelStyles } from '../../../src/git-core/gitToolWindow/provider/stylesBuilder';
import type { TabId } from '../../../src/git-core/gitToolWindow/tabRouter';
import type { IConsoleEntry } from '../../../src/git-core/interfaces/IGitToolWindowProvider';
import type { ICommit } from '../../../src/git-core/interfaces/IGitService';
import type { IHistoryTabState } from '../../../src/git-core/gitToolWindow/tabs/HistoryTab';
import type { IIncomingTabState } from '../../../src/git-core/gitToolWindow/tabs/IncomingTab';
import type { IUpdateInfoTabState } from '../../../src/git-core/gitToolWindow/tabs/UpdateInfoTab';
import type { IUpdateRepoResult } from '../../../src/sync/updateProject';

/** The tool window's full stylesheet, in the provider's emit order. */
export function gitToolWindowCss(): string {
  return `${buildThreePanelStyles()}\n${toolWindowTabStyles()}`;
}

export interface ITabbedBodyStates {
  activeTab: TabId;
  console?: IConsoleEntry[];
  history?: IHistoryTabState;
  incoming?: IIncomingTabState;
  updateInfo?: IUpdateInfoTabState;
}

/** The tabbed document body, every panel rendered by its production builder. */
export function tabbedBody(states: ITabbedBodyStates): string {
  return wrapTabbedBody({
    activeTab: states.activeTab,
    logBodyHtml: '',
    consoleBodyHtml: renderConsoleTabBody(states.console ?? []),
    historyBodyHtml: renderHistoryTabBody(states.history),
    incomingBodyHtml: renderIncomingTabBody(states.incoming),
    updateInfoBodyHtml: renderUpdateInfoTabBody(states.updateInfo),
  });
}

/** No-timezone-suffix ISO strings parse as local time, so HH:mm:ss is stable. */
const FIXED_TIME = new Date('2026-07-26T12:34:56.789');

export function consoleEntry(overrides: Partial<IConsoleEntry> = {}): IConsoleEntry {
  return {
    timestamp: FIXED_TIME,
    command: 'git fetch origin --prune',
    output: '',
    isError: false,
    ...overrides,
  };
}

/** `count` distinct successful entries, for content taller than a viewport. */
export function consoleEntries(count: number): IConsoleEntry[] {
  return Array.from({ length: count }, (_, i) =>
    consoleEntry({ command: `git log --oneline --max-count=${i + 1}` })
  );
}

export function commit(overrides: Partial<ICommit> = {}): ICommit {
  const author = { name: 'Alex Doe', email: 'alex@example.com' };
  return {
    hash: '1111111111111111111111111111111111111111',
    shortHash: '1111111',
    message: 'Refactor the parser',
    author,
    committer: author,
    parents: [],
    authorDate: FIXED_TIME,
    commitDate: FIXED_TIME,
    ...overrides,
  };
}

/**
 * A linear three-commit window. The first commit carries a 12-character short
 * hash on purpose: git's %h abbreviation grows past 7 characters in large
 * repos, and the hash-overlaps-subject regression only reproduces past 7.
 */
export function historyCommits(): ICommit[] {
  const c3 = commit({
    hash: '3333333333333333333333333333333333333333',
    shortHash: '3333333',
    message: 'Initial import',
  });
  const c2 = commit({
    hash: '2222222222222222222222222222222222222222',
    shortHash: '2222222',
    message: 'Wire the toolbar actions',
    parents: [c3.hash],
  });
  const c1 = commit({
    hash: '1111111111111111111111111111111111111111',
    shortHash: 'a1b2c3d4e5f6',
    message: 'Size the hash column from content',
    parents: [c2.hash],
  });
  return [c1, c2, c3];
}

export function historyState(overrides: Partial<IHistoryTabState> = {}): IHistoryTabState {
  const commits = historyCommits();
  return {
    filePath: 'src/git-core/gitParser.ts',
    commits,
    selectedCommit: commits[1].hash,
    compareCommit: commits[2].hash,
    branchFilter: undefined,
    lineRange: undefined,
    followRenames: true,
    availableBranches: [
      { name: 'main', type: 'local', commit: commits[0].hash, isHead: true },
      { name: 'origin/main', type: 'remote', commit: commits[0].hash, isHead: false },
    ],
    error: undefined,
    loading: false,
    affectedPaths: [],
    affectedPathsLoading: false,
    affectedPathsError: undefined,
    containingBranches: undefined,
    ...overrides,
  };
}

export function incomingState(overrides: Partial<IIncomingTabState> = {}): IIncomingTabState {
  const commits = [
    commit({
      hash: '4444444444444444444444444444444444444444',
      shortHash: '4444444',
      message: 'Add the release notes',
    }),
    commit({
      hash: '5555555555555555555555555555555555555555',
      shortHash: '5555555',
      message: 'Fix the flaky watcher test',
    }),
  ];
  return {
    branch: 'main',
    upstream: 'origin/main',
    incomingCount: commits.length,
    outgoingCount: 0,
    noUpstream: false,
    commits,
    selectedCommit: commits[0].hash,
    error: undefined,
    loading: false,
    ...overrides,
  };
}

function repoResult(overrides: Partial<IUpdateRepoResult>): IUpdateRepoResult {
  return {
    name: 'intellig',
    rootPath: '/work/intellig',
    branch: 'main',
    rebase: false,
    incoming: 3,
    status: 'updated',
    ...overrides,
  };
}

/** One repo per outcome, so every status class renders at once. */
export function updateInfoState(): IUpdateInfoTabState {
  const repos: IUpdateRepoResult[] = [
    repoResult({ name: 'app', rootPath: '/work/app', status: 'updated', incoming: 3 }),
    repoResult({ name: 'lib', rootPath: '/work/lib', status: 'up-to-date', incoming: 0 }),
    repoResult({
      name: 'tools',
      rootPath: '/work/tools',
      status: 'conflict',
      incoming: 2,
      detail: 'CONFLICT (content): merge conflict in src/main.ts',
    }),
    repoResult({
      name: 'docs',
      rootPath: '/work/docs',
      status: 'error',
      incoming: 0,
      detail: 'fetch failed: could not resolve host',
    }),
    repoResult({ name: 'infra', rootPath: '/work/infra', status: 'skipped', incoming: 0 }),
  ];
  return {
    summary: {
      method: 'merge',
      repos,
      totalIncoming: repos.reduce((sum, r) => sum + r.incoming, 0),
      allClean: false,
    },
  };
}

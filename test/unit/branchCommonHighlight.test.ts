/**
 * Selecting a non-checked-out branch in the Branches tree highlights the log
 * rows whose commits are COMMON to that branch and the current (HEAD) branch
 * (IntelliJ CurrentBranchHighlighter). Selecting the current branch clears it.
 *
 * The provider computes the common set once (GitService.getCommonCommits),
 * intersects it with the loaded rows, and posts a `highlightCommonCommits`
 * partial-update message; it also remembers the set so a full re-render keeps
 * the highlight class.
 */

import '../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import {
  IAuthor,
  ICommit,
  IGitService,
  IRepository,
} from '../../src/git-core/interfaces/IGitService';
import { Uri } from '../mocks/vscode';
import { createMockGitService } from '../mocks/mockGitService';

const AUTHOR: IAuthor = { name: 'A', email: 'a@x' };

function mkCommit(hash: string): ICommit {
  const d = new Date(2020, 0, 1);
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message: hash,
    author: AUTHOR,
    committer: AUTHOR,
    parents: [],
    authorDate: d,
    commitDate: d,
  };
}

function repoOnBranch(name: string): IRepository {
  return {
    rootUri: Uri.file('/repo'),
    state: 'idle',
    head: { name, commit: 'h0', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

interface PostedMessage {
  type?: string;
  hashes?: string[];
}

describe('Branch common-commit highlight', () => {
  let provider: GitToolWindowProvider;
  let posted: PostedMessage[];
  const repo = repoOnBranch('main');

  function attachView(): void {
    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
    (provider as any)._view = {
      webview: {
        get html(): string {
          return '';
        },
        set html(_v: string) {},
        options: {},
        cspSource: 'test:',
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: (m: PostedMessage) => {
          posted.push(m);
          return Promise.resolve(true);
        },
        asWebviewUri: (u: unknown) => u,
      },
      visible: true,
      onDidChangeVisibility: () => ({ dispose: () => {} }),
      onDidDispose: () => ({ dispose: () => {} }),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
  }

  function setup(gitService: IGitService): void {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setAvailableRepositories([repo]);
    provider.attachGitService(gitService);
    // Loaded log window: c1, c2, c3 (c4 is common but off-window).
    provider.updateLogState([mkCommit('c1'), mkCommit('c2'), mkCommit('c3')], new Map(), new Map());
    posted = [];
    attachView();
  }

  afterEach(() => {
    provider.dispose();
  });

  it('posts the loaded common commits when a non-current branch is selected', async () => {
    setup(
      createMockGitService(repo, {
        // c2 + c4 common; c4 is not in the loaded window, so only c2 is sent.
        getCommonCommits: async () => ['c2', 'c4'],
      })
    );

    await provider.highlightBranchCommonCommits('feature');

    const msg = posted.find((m) => m.type === 'highlightCommonCommits');
    assert.ok(msg, 'a highlightCommonCommits message must be posted');
    assert.deepStrictEqual(msg?.hashes, ['c2'], 'only loaded common rows are highlighted');
  });

  it('clears the highlight (empty payload) when the current branch is selected', async () => {
    setup(createMockGitService(repo, { getCommonCommits: async () => ['c2'] }));

    await provider.highlightBranchCommonCommits('feature');
    posted = [];
    await provider.highlightBranchCommonCommits('main'); // the checked-out branch

    const msg = posted.find((m) => m.type === 'highlightCommonCommits');
    assert.ok(msg, 'a clear message must be posted');
    assert.deepStrictEqual(msg?.hashes, [], 'selecting HEAD clears the highlight');
  });

  it('does not call getCommonCommits for the current branch (pure clear)', async () => {
    let calls = 0;
    setup(
      createMockGitService(repo, {
        getCommonCommits: async () => {
          calls += 1;
          return [];
        },
      })
    );

    await provider.highlightBranchCommonCommits('main');
    assert.strictEqual(calls, 0, 'no reachability query for the already-checked-out branch');
  });

  it('renders the common-commit class on matching rows on a full re-render', async () => {
    setup(createMockGitService(repo, { getCommonCommits: async () => ['c2'] }));
    await provider.highlightBranchCommonCommits('feature');

    const html = provider._getThreePanelHtmlContent(
      (provider as unknown as { _view: { webview: import('vscode').Webview } })._view.webview,
      [mkCommit('c1'), mkCommit('c2'), mkCommit('c3')].map((commit) => ({
        commit,
        graphColumn: 0,
        graphLines: [],
        branches: [],
        tags: [],
      }))
    );
    // The row for c2 must carry the highlight class; c1 must not.
    const classOf = (hash: string): string => {
      const m = html.match(new RegExp(`class="([^"]*)"\\s+data-hash="${hash}"`));
      if (!m) {
        throw new assert.AssertionError({ message: `row for ${hash} must render` });
      }
      return m[1];
    };
    assert.ok(classOf('c2').includes('commit-row-common'), 'c2 (common) carries the class');
    assert.ok(!classOf('c1').includes('commit-row-common'), 'c1 (not common) does not');
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Branch common-commit highlight — stale-result race guard', () => {
  let provider: GitToolWindowProvider;
  let posted: PostedMessage[];
  const repo = repoOnBranch('main');

  function lastHighlight(): PostedMessage | undefined {
    return [...posted].reverse().find((m) => m.type === 'highlightCommonCommits');
  }

  function setup(getCommonCommits: (repo: IRepository, ref: string) => Promise<string[]>): void {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setAvailableRepositories([repo]);
    provider.attachGitService(createMockGitService(repo, { getCommonCommits }));
    provider.updateLogState([mkCommit('c1'), mkCommit('c2'), mkCommit('c3')], new Map(), new Map());
    posted = [];
    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
    (provider as any)._view = {
      webview: {
        get html(): string {
          return '';
        },
        set html(_v: string) {},
        options: {},
        cspSource: 'test:',
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: (m: PostedMessage) => {
          posted.push(m);
          return Promise.resolve(true);
        },
        asWebviewUri: (u: unknown) => u,
      },
      visible: true,
      onDidChangeVisibility: () => ({ dispose: () => {} }),
      onDidDispose: () => ({ dispose: () => {} }),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
  }

  afterEach(() => {
    provider.dispose();
  });

  it('a slow earlier selection cannot overwrite a faster later one', async () => {
    const dA = deferred<string[]>();
    const dB = deferred<string[]>();
    setup((_repo, ref) => (ref === 'A' ? dA.promise : dB.promise));

    const pA = provider.highlightBranchCommonCommits('A'); // gen 1, in flight
    const pB = provider.highlightBranchCommonCommits('B'); // gen 2, in flight
    dB.resolve(['c2']); // the LATER selection resolves first
    await pB;
    dA.resolve(['c1']); // the EARLIER selection resolves LAST (stale)
    await pA;

    assert.deepStrictEqual(lastHighlight()?.hashes, ['c2'], 'B (latest) wins');
    assert.ok(
      !posted.some((m) => m.type === 'highlightCommonCommits' && m.hashes?.includes('c1')),
      'stale A result must never be applied'
    );
  });

  it('an in-flight highlight that resolves AFTER a clear is dropped', async () => {
    const dApplied = deferred<string[]>();
    const dStale = deferred<string[]>();
    setup((_repo, ref) => (ref === 'first' ? dApplied.promise : dStale.promise));

    // Apply an initial highlight so the later clear actually posts [].
    const p1 = provider.highlightBranchCommonCommits('first');
    dApplied.resolve(['c2']);
    await p1;

    const pStale = provider.highlightBranchCommonCommits('second'); // in flight
    provider.clearCommonCommitHighlight(); // user selects HEAD / deselects
    dStale.resolve(['c1']); // resolves AFTER the clear
    await pStale;

    assert.deepStrictEqual(lastHighlight()?.hashes, [], 'highlight stays cleared');
    assert.ok(
      !posted.some((m) => m.type === 'highlightCommonCommits' && m.hashes?.includes('c1')),
      'stale result after clear must not re-apply'
    );
  });
});

describe('Branch common-commit highlight — multi-root owning repo', () => {
  it('resolves the common set against the branch’s OWNING repo, not the context repo', async () => {
    const contextRepo = repoOnBranch('main');
    const ownerRepo: IRepository = {
      rootUri: Uri.file('/other-root'),
      state: 'idle',
      head: { name: 'release', commit: 'h9', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
    const seen: IRepository[] = [];
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setAvailableRepositories([contextRepo]); // context = the first root
    provider.attachGitService(
      createMockGitService(contextRepo, {
        getCommonCommits: async (r) => {
          seen.push(r);
          return [];
        },
      })
    );

    await provider.highlightBranchCommonCommits('feature', ownerRepo);

    assert.deepStrictEqual(seen, [ownerRepo], 'getCommonCommits ran against the owning repo');
    provider.dispose();
  });

  it('treats the OWNING repo’s current branch as the clear case (no query)', async () => {
    const contextRepo = repoOnBranch('main');
    const ownerRepo = repoOnBranch('feature'); // its own HEAD is "feature"
    ownerRepo.rootUri = Uri.file('/owner');
    let calls = 0;
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setAvailableRepositories([contextRepo]);
    provider.attachGitService(
      createMockGitService(contextRepo, {
        getCommonCommits: async () => {
          calls += 1;
          return [];
        },
      })
    );

    // "feature" is the owning repo's checked-out branch → clear, no query —
    // even though it is NOT the context repo's current branch ("main").
    await provider.highlightBranchCommonCommits('feature', ownerRepo);
    assert.strictEqual(calls, 0, 'owning-repo HEAD selection clears without a reachability query');
    provider.dispose();
  });
});

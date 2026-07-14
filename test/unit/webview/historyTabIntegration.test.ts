/**
 * End-to-end-ish History tab test: drive the REAL GitToolWindowProvider
 * (attachGitService → loadFileHistory → render the full document), run the
 * assembled inline script in jsdom, and assert the History details panel
 * populates and its interactions post the right messages. This is the surface
 * that only shows up on F5; no other lane exercises the tab path.
 */
import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitToolWindowProvider } from '../../../src/git-core/gitToolWindow/GitToolWindowProvider';
import type { ICommitNode } from '../../../src/git-core/commitGraph';
import { Uri } from '../../mocks/vscode';
import { bootWebviewEntry } from '../../helpers/bootWebviewEntry';
import { createMockGitService } from '../../mocks/mockGitService';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';

/** Inner HTML of the assembled document's `<body>` (island + panels + tags). */
function bodyOf(html: string): string {
  const match = /<body>([\s\S]*)<\/body>/.exec(html);
  return match ? match[1] : html;
}
import type {
  ICommit,
  IGitService,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';

function mockWebview(): vscode.Webview {
  return {
    cspSource: 'vscode-webview://mock',
    asWebviewUri: (uri: Uri): Uri => uri,
  } as unknown as vscode.Webview;
}

const REPO = {
  rootUri: Uri.file('/repo'),
  state: 'idle',
  remotes: [],
  submodules: [],
} as unknown as IRepository;

function sampleCommit(): ICommit {
  return {
    hash: 'abc1234def5678abc1234def5678abc1234def56',
    shortHash: 'abc1234',
    message: 'Fix the history thing',
    body: 'Body text.',
    author: { name: 'Alice', email: 'alice@example.com' },
    committer: { name: 'Alice', email: 'alice@example.com' },
    parents: ['def5678abc1234def5678abc1234def5678abc12'],
    authorDate: new Date('2024-03-04T10:00:00Z'),
    commitDate: new Date('2024-03-04T10:00:00Z'),
  } as unknown as ICommit;
}

function historyGitService(): IGitService {
  return createMockGitService(REPO, {
    getFileHistory: async () => [sampleCommit()],
    getCommitDiff: async () => [{ path: 'src/a.ts', status: 'modified', hunks: [], binary: false }],
    getContainingBranches: async () => ['main', 'origin/main'],
    getBranches: async () => [],
  } as unknown as Partial<IGitService>);
}

async function driveToHistory(): Promise<GitToolWindowProvider> {
  const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  provider.setAvailableRepositories([REPO] as Parameters<
    typeof provider.setAvailableRepositories
  >[0]);
  provider.attachGitService(historyGitService());
  await provider.loadFileHistory('src/a.ts');
  return provider;
}

describe('History tab — real provider end-to-end', () => {
  it('injects a non-null history details model and the details container', async () => {
    const provider = await driveToHistory();
    const html = provider._getThreePanelHtmlContent(mockWebview(), [] as ICommitNode[]);
    assert.ok(html.includes('id="history-details-panel"'), 'history details container present');
    assert.ok(html.includes('id="intellig-init"'), 'init island present');
    assert.ok(
      /historyDetails&quot;:\s*\{/.test(html),
      'history model injected into the island (non-null)'
    );
    assert.ok(
      html.includes('Fix the history thing'),
      'selected commit subject reaches the document'
    );
  });

  it('populates #history-details-panel when the entry runs', async () => {
    const provider = await driveToHistory();
    const html = provider._getThreePanelHtmlContent(mockWebview(), [] as ICommitNode[]);
    const h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(html) });
    assert.deepStrictEqual(
      h.errors.map((e) => e.message),
      [],
      'no script errors'
    );
    const hdp = h.document.getElementById('history-details-panel');
    assert.ok(hdp, '#history-details-panel exists');
    assert.ok(hdp.querySelector('.details-panel'), 'details panel rendered inside the container');
    assert.ok(
      hdp.textContent && hdp.textContent.includes('Fix the history thing'),
      'commit subject rendered'
    );
    assert.ok(hdp.querySelector('.changed-file-item[data-commit-hash]'), 'changed files rendered');
    assert.ok(
      !hdp.textContent.includes('loading…'),
      'containing branches resolved (not stuck loading)'
    );
    h.dispose();
  });

  it('double-clicking a changed file in History opens its diff (commit not in the Log window)', async () => {
    const provider = await driveToHistory();
    let fired: { commitHash: string; filePath: string } | undefined;
    provider.onDidRequestCommitDiff((e) => {
      fired = e;
    });
    // The Log window is empty (commitNodes []), so this only works if the host
    // also recognizes History-tab commits.
    (provider as unknown as { _handleMessage(m: unknown): void })._handleMessage({
      type: 'doubleClickFile',
      commitHash: sampleCommit().hash,
      path: 'src/a.ts',
    });
    assert.ok(fired, 'a diff request must fire for a History-tab commit');
    assert.strictEqual(fired?.commitHash, sampleCommit().hash);
  });

  it('queries the file OWN repo in a multi-repo workspace (not getRepositories first)', async () => {
    const repoA = {
      rootUri: Uri.file('/repoA'),
      state: 'idle',
      remotes: [],
      submodules: [],
    } as unknown as IRepository;
    const repoB = {
      rootUri: Uri.file('/repoB'),
      state: 'idle',
      remotes: [],
      submodules: [],
    } as unknown as IRepository;
    const seen: string[] = [];
    const gitService = createMockGitService(repoA, {
      getRepositories: () => [repoA, repoB],
      getFileHistory: async (repo: IRepository) => {
        seen.push(repo.rootUri.fsPath);
        return [sampleCommit()];
      },
      getCommitDiff: async () => [],
      getContainingBranches: async () => [],
      getBranches: async () => [],
    } as unknown as Partial<IGitService>);

    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setAvailableRepositories([repoA, repoB] as Parameters<
      typeof provider.setAvailableRepositories
    >[0]);
    provider.attachGitService(gitService);
    // The file lives in repoB; the command resolves repoB and passes its root.
    await provider.loadFileHistory('src/a.ts', repoB.rootUri.fsPath);

    assert.deepStrictEqual(
      seen,
      [repoB.rootUri.fsPath],
      'file history must be fetched from the file own repo, not the first repo'
    );
  });

  it('clicking a parent hash in the History details navigates within History (not the hidden Log)', async () => {
    // Two-commit history where the selected commit's parent is the second
    // commit — so the parent IS a row in the file's history list.
    const parentHash = 'def5678abc1234def5678abc1234def5678abc12';
    const child = sampleCommit(); // parents: [parentHash]
    const parentCommit = {
      ...sampleCommit(),
      hash: parentHash,
      shortHash: 'def5678',
      message: 'Parent commit',
      parents: [],
    } as unknown as ICommit;
    const gitService = createMockGitService(REPO, {
      getFileHistory: async () => [child, parentCommit],
      getCommitDiff: async () => [
        { path: 'src/a.ts', status: 'modified', hunks: [], binary: false },
      ],
      getContainingBranches: async () => ['main'],
      getBranches: async () => [],
    } as unknown as Partial<IGitService>);
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setAvailableRepositories([REPO] as Parameters<
      typeof provider.setAvailableRepositories
    >[0]);
    provider.attachGitService(gitService);
    await provider.loadFileHistory('src/a.ts', REPO.rootUri.fsPath);

    const html = provider._getThreePanelHtmlContent(mockWebview(), [] as ICommitNode[]);
    const h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(html) });
    const hdp = h.document.getElementById('history-details-panel');
    assert.ok(hdp, '#history-details-panel exists');
    const parent = hdp.querySelector('.parent-hash[data-parent-hash]');
    assert.ok(parent, 'a parent hash is rendered');
    parent.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    const selectCommit = h.posted.find((m) => (m as { type?: string }).type === 'selectCommit');
    const historySelect = h.posted.find(
      (m) => (m as { type?: string; rev?: string }).type === 'history.selectRevision'
    );
    assert.ok(
      !selectCommit,
      'must NOT post selectCommit (that targets the hidden Log graph, a dead click on the History tab)'
    );
    assert.ok(
      historySelect,
      'must post history.selectRevision so the History details follow the parent'
    );
    assert.strictEqual((historySelect as { rev?: string }).rev, parentHash);
    h.dispose();
  });

  it('clicking a commit row posts history.selectRevision (selection wiring intact)', async () => {
    const provider = await driveToHistory();
    const html = provider._getThreePanelHtmlContent(mockWebview(), [] as ICommitNode[]);
    const h = bootWebviewEntry(ENTRY, { bodyHtml: bodyOf(html) });
    const row = h.document.querySelector('.history-commit-row');
    assert.ok(row, 'a commit row is rendered in the list');
    row.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    const selectMsg = h.posted.find(
      (m) => (m as { type?: string }).type === 'history.selectRevision'
    );
    assert.ok(selectMsg, 'clicking a commit row posts history.selectRevision');
    h.dispose();
  });
});

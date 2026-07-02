/**
 * Integration: the REAL GitToolWindowProvider must render the Update Info tab
 * from a summary handed to `setUpdateSummary` — the wiring that was missing
 * (the provider registered a no-op handler and rendered a static "coming soon"
 * stub while the whole backend existed). Mirrors the History-tab end-to-end
 * test's provider harness.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitToolWindowProvider } from '../../../src/git-core/gitToolWindow/GitToolWindowProvider';
import type { ICommitNode } from '../../../src/git-core/commitGraph';
import { Uri, setMockConfigValue } from '../../mocks/vscode';
import { createMockGitService } from '../../mocks/mockGitService';
import { summarizeUpdate } from '../../../src/sync/updateProject';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';

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

function summary() {
  return summarizeUpdate('rebase', [
    {
      name: 'alpha',
      rootPath: '/repo',
      branch: 'main',
      rebase: true,
      incoming: 4,
      status: 'updated' as const,
    },
    {
      name: 'beta',
      rootPath: '/beta',
      branch: 'dev',
      rebase: true,
      incoming: 0,
      status: 'error' as const,
      detail: 'refusing to merge unrelated histories',
    },
  ]);
}

describe('Update Info tab — real provider integration', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    setMockConfigValue('intellig', 'useTabbedGitToolWindow', true);
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.attachGitService(createMockGitService(REPO, {} as Partial<IGitService>));
  });

  afterEach(() => {
    provider.dispose();
  });

  it('renders the summary rows once setUpdateSummary is called and the tab is active', async () => {
    provider.setUpdateSummary(summary());
    await provider.focusTab('updateInfo');

    const html = provider._getThreePanelHtmlContent(mockWebview(), [] as ICommitNode[]);
    assert.ok(html.includes('alpha'), 'first repo row rendered');
    assert.ok(html.includes('beta'), 'second repo row rendered');
    assert.ok(/refusing to merge unrelated histories/.test(html), 'error detail surfaced');
    assert.ok(!/coming soon/i.test(html), 'the placeholder stub is gone');
    assert.ok(/Updated .*repositor/i.test(html) || /commit/i.test(html), 'headline present');
  });

  it('shows the empty state before any update has run', async () => {
    await provider.focusTab('updateInfo');
    const html = provider._getThreePanelHtmlContent(mockWebview(), [] as ICommitNode[]);
    assert.ok(/no update has run/i.test(html), 'empty-state message present');
  });
});

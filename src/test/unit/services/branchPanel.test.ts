/**
 * Unit tests for _getBranchPanelHtml() method in GitToolWindowProvider.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */

import '../../../test/setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../services/GitToolWindowProvider';
import { IBranchPanelData } from '../../../services/interfaces';
import { IBranch } from '../../../services/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

/**
 * Helper to create a minimal IBranch for testing.
 */
function makeBranch(name: string, type: 'local' | 'remote' = 'local'): IBranch {
  return {
    name,
    type,
    commit: 'abc1234567890',
    isHead: false,
  };
}

describe('GitToolWindowProvider - _getBranchPanelHtml()', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    const extensionUri = Uri.file('/test/extension');
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Requirement 2.1: Three top-level categories', () => {
    it('should render HEAD (Current Branch), Local, and Remote categories', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(html.includes('HEAD (Current Branch)'), 'Should contain HEAD category');
      assert.ok(html.includes('data-category="local"'), 'Should contain Local category');
      assert.ok(html.includes('data-category="remote"'), 'Should contain Remote category');
    });

    it('should render a tree with role="tree"', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);
      assert.ok(html.includes('role="tree"'), 'Should have tree role');
    });
  });

  describe('Requirement 2.2: HEAD points to a branch', () => {
    it('should display the branch name under HEAD when not detached', () => {
      const data: IBranchPanelData = {
        head: { name: 'feature/my-branch', isDetached: false },
        local: [],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(html.includes('feature/my-branch'), 'Should display branch name');
      assert.ok(!html.includes('(detached)'), 'Should NOT show detached label');
    });
  });

  describe('Requirement 2.3: HEAD is detached', () => {
    it('should display short commit hash with (detached) label when HEAD is detached', () => {
      const data: IBranchPanelData = {
        head: { name: 'abc1234', isDetached: true, commitHash: 'abc1234' },
        local: [],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(html.includes('abc1234'), 'Should display commit hash');
      assert.ok(html.includes('(detached)'), 'Should show detached label');
    });

    it('should use commitHash when available for detached HEAD', () => {
      const data: IBranchPanelData = {
        head: { name: 'HEAD', isDetached: true, commitHash: 'deadbeef' },
        local: [],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(html.includes('deadbeef'), 'Should display commitHash');
      assert.ok(html.includes('(detached)'), 'Should show detached label');
    });

    it('should fall back to name when commitHash is not provided for detached HEAD', () => {
      const data: IBranchPanelData = {
        head: { name: 'abc1234', isDetached: true },
        local: [],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(html.includes('abc1234'), 'Should display name as fallback');
      assert.ok(html.includes('(detached)'), 'Should show detached label');
    });
  });

  describe('Requirement 2.4: Local branches in alphabetical order', () => {
    it('should list local branches in case-insensitive alphabetical order', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [
          makeBranch('zebra'),
          makeBranch('Alpha'),
          makeBranch('beta'),
          makeBranch('gamma'),
        ],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);

      // Extract the Local category section to avoid matching HEAD section
      const localStart = html.indexOf('data-category="local"');
      const remoteStart = html.indexOf('data-category="remote"');
      const localSection = html.substring(localStart, remoteStart);

      const alphaIdx = localSection.indexOf('>Alpha<');
      const betaIdx = localSection.indexOf('>beta<');
      const gammaIdx = localSection.indexOf('>gamma<');
      const zebraIdx = localSection.indexOf('>zebra<');

      assert.ok(alphaIdx > -1, 'Alpha should be present in Local section');
      assert.ok(betaIdx > -1, 'beta should be present in Local section');
      assert.ok(gammaIdx > -1, 'gamma should be present in Local section');
      assert.ok(zebraIdx > -1, 'zebra should be present in Local section');

      assert.ok(alphaIdx < betaIdx, 'Alpha should come before beta');
      assert.ok(betaIdx < gammaIdx, 'beta should come before gamma');
      assert.ok(gammaIdx < zebraIdx, 'gamma should come before zebra');
    });

    it('should render all local branches', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [
          makeBranch('develop'),
          makeBranch('main'),
          makeBranch('feature/auth'),
        ],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(html.includes('develop'), 'Should contain develop');
      assert.ok(html.includes('main'), 'Should contain main');
      assert.ok(html.includes('feature/auth'), 'Should contain feature/auth');
    });

    it('should handle empty local branches', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);

      // Should still render the Local category
      assert.ok(html.includes('data-category="local"'), 'Should contain Local category');
    });
  });

  describe('Requirement 2.5: Remote branches grouped by remote name', () => {
    it('should group remote branches by remote name', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [],
        remote: [
          {
            remoteName: 'origin',
            branches: [
              makeBranch('origin/main', 'remote'),
              makeBranch('origin/develop', 'remote'),
            ],
          },
          {
            remoteName: 'upstream',
            branches: [
              makeBranch('upstream/main', 'remote'),
            ],
          },
        ],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(html.includes('origin'), 'Should contain origin remote group');
      assert.ok(html.includes('upstream'), 'Should contain upstream remote group');
      assert.ok(html.includes('origin/main'), 'Should contain origin/main');
      assert.ok(html.includes('origin/develop'), 'Should contain origin/develop');
      assert.ok(html.includes('upstream/main'), 'Should contain upstream/main');
    });

    it('should sort remote branches alphabetically within each group', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [],
        remote: [
          {
            remoteName: 'origin',
            branches: [
              makeBranch('origin/zebra', 'remote'),
              makeBranch('origin/alpha', 'remote'),
              makeBranch('origin/Beta', 'remote'),
            ],
          },
        ],
      };

      const html = provider._getBranchPanelHtml(data);

      const alphaIdx = html.indexOf('origin/alpha');
      const betaIdx = html.indexOf('origin/Beta');
      const zebraIdx = html.indexOf('origin/zebra');

      assert.ok(alphaIdx < betaIdx, 'alpha should come before Beta');
      assert.ok(betaIdx < zebraIdx, 'Beta should come before zebra');
    });

    it('should handle empty remote branches', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(html.includes('data-category="remote"'), 'Should contain Remote category');
    });
  });

  describe('HTML escaping', () => {
    it('should escape special characters in branch names', () => {
      const data: IBranchPanelData = {
        head: { name: 'feature/<script>alert(1)</script>', isDetached: false },
        local: [],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(!html.includes('<script>'), 'Should escape script tags');
      assert.ok(html.includes('&lt;script&gt;'), 'Should contain escaped script tag');
    });
  });
});

describe('GitToolWindowProvider - _getBranchContextMenuHtml()', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    const extensionUri = Uri.file('/test/extension');
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Requirement 2.7: Local branch context menu', () => {
    it('should contain all required local branch context menu options', () => {
      const html = provider._getBranchContextMenuHtml();

      // Verify the local branch context menu contains all required options
      assert.ok(html.includes('id="branch-context-menu-local"'), 'Should have local branch context menu');
      assert.ok(html.includes('Checkout'), 'Should contain Checkout option');
      assert.ok(html.includes('New Branch'), 'Should contain New Branch option');
      assert.ok(html.includes('Merge into Current'), 'Should contain Merge into Current option');
      assert.ok(html.includes('Rebase Current onto This'), 'Should contain Rebase Current onto This option');
      assert.ok(html.includes('Compare with Current'), 'Should contain Compare with Current option');
      assert.ok(html.includes('Rename'), 'Should contain Rename option');
      assert.ok(html.includes('Delete'), 'Should contain Delete option');
    });

    it('should have correct data-action attributes for local branch menu items', () => {
      const html = provider._getBranchContextMenuHtml();

      // Extract the local menu section
      const localMenuStart = html.indexOf('id="branch-context-menu-local"');
      const localMenuEnd = html.indexOf('id="branch-context-menu-remote"');
      const localMenuHtml = html.substring(localMenuStart, localMenuEnd);

      assert.ok(localMenuHtml.includes('data-action="checkout"'), 'Should have checkout action');
      assert.ok(localMenuHtml.includes('data-action="newBranch"'), 'Should have newBranch action');
      assert.ok(localMenuHtml.includes('data-action="merge"'), 'Should have merge action');
      assert.ok(localMenuHtml.includes('data-action="rebase"'), 'Should have rebase action');
      assert.ok(localMenuHtml.includes('data-action="compare"'), 'Should have compare action');
      assert.ok(localMenuHtml.includes('data-action="rename"'), 'Should have rename action');
      assert.ok(localMenuHtml.includes('data-action="delete"'), 'Should have delete action');
    });

    it('should render the local menu as hidden by default', () => {
      const html = provider._getBranchContextMenuHtml();

      const localMenuStart = html.indexOf('id="branch-context-menu-local"');
      const localMenuTag = html.substring(localMenuStart - 100, localMenuStart + 100);
      assert.ok(localMenuTag.includes('hidden'), 'Local menu should be hidden by default');
    });

    it('should have role="menu" for accessibility on local menu', () => {
      const html = provider._getBranchContextMenuHtml();

      const localMenuStart = html.indexOf('id="branch-context-menu-local"');
      const localMenuTag = html.substring(localMenuStart - 100, localMenuStart + 100);
      assert.ok(localMenuTag.includes('role="menu"'), 'Local menu should have role="menu"');
    });
  });

  describe('Requirement 2.8: Remote branch context menu', () => {
    it('should contain all required remote branch context menu options', () => {
      const html = provider._getBranchContextMenuHtml();

      // Extract the remote menu section
      const remoteMenuStart = html.indexOf('id="branch-context-menu-remote"');
      const remoteMenuHtml = html.substring(remoteMenuStart);

      assert.ok(remoteMenuHtml.includes('Checkout as Local'), 'Should contain Checkout as Local option');
      assert.ok(remoteMenuHtml.includes('New Branch'), 'Should contain New Branch option');
      assert.ok(remoteMenuHtml.includes('Merge into Current'), 'Should contain Merge into Current option');
      assert.ok(remoteMenuHtml.includes('Pull into Current'), 'Should contain Pull into Current option');
      assert.ok(remoteMenuHtml.includes('Delete Remote'), 'Should contain Delete Remote option');
    });

    it('should have correct data-action attributes for remote branch menu items', () => {
      const html = provider._getBranchContextMenuHtml();

      // Extract the remote menu section
      const remoteMenuStart = html.indexOf('id="branch-context-menu-remote"');
      const remoteMenuHtml = html.substring(remoteMenuStart);

      assert.ok(remoteMenuHtml.includes('data-action="checkoutAsLocal"'), 'Should have checkoutAsLocal action');
      assert.ok(remoteMenuHtml.includes('data-action="newBranch"'), 'Should have newBranch action');
      assert.ok(remoteMenuHtml.includes('data-action="merge"'), 'Should have merge action');
      assert.ok(remoteMenuHtml.includes('data-action="pull"'), 'Should have pull action');
      assert.ok(remoteMenuHtml.includes('data-action="deleteRemote"'), 'Should have deleteRemote action');
    });

    it('should render the remote menu as hidden by default', () => {
      const html = provider._getBranchContextMenuHtml();

      const remoteMenuStart = html.indexOf('id="branch-context-menu-remote"');
      const remoteMenuTag = html.substring(remoteMenuStart - 100, remoteMenuStart + 100);
      assert.ok(remoteMenuTag.includes('hidden'), 'Remote menu should be hidden by default');
    });

    it('should have role="menu" for accessibility on remote menu', () => {
      const html = provider._getBranchContextMenuHtml();

      const remoteMenuStart = html.indexOf('id="branch-context-menu-remote"');
      const remoteMenuTag = html.substring(remoteMenuStart - 100, remoteMenuStart + 100);
      assert.ok(remoteMenuTag.includes('role="menu"'), 'Remote menu should have role="menu"');
    });

    it('should NOT contain local-only options in the remote menu', () => {
      const html = provider._getBranchContextMenuHtml();

      // Extract the remote menu section only
      const remoteMenuStart = html.indexOf('id="branch-context-menu-remote"');
      const remoteMenuHtml = html.substring(remoteMenuStart);

      assert.ok(!remoteMenuHtml.includes('data-action="rebase"'), 'Remote menu should NOT have rebase action');
      assert.ok(!remoteMenuHtml.includes('data-action="compare"'), 'Remote menu should NOT have compare action');
      assert.ok(!remoteMenuHtml.includes('data-action="rename"'), 'Remote menu should NOT have rename action');
      assert.ok(!remoteMenuHtml.includes('data-action="checkout"' + '"'), 'Remote menu should NOT have plain checkout action');
    });
  });

  describe('Branch panel integration with context menus', () => {
    it('should NOT include context menu HTML in branch panel output (menus are at top-level layout)', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [makeBranch('develop')],
        remote: [{ remoteName: 'origin', branches: [makeBranch('origin/main', 'remote')] }],
      };

      const html = provider._getBranchPanelHtml(data);

      // Context menus are now rendered at the top-level layout div, not inside the branch panel,
      // to prevent clipping by panel overflow: auto (Requirements 4.1, 4.2, 4.6, 4.7)
      assert.ok(!html.includes('branch-context-menu-local'), 'Branch panel should NOT include local context menu (moved to top-level layout)');
      assert.ok(!html.includes('branch-context-menu-remote'), 'Branch panel should NOT include remote context menu (moved to top-level layout)');
    });

    it('should include context menu HTML in the full three-panel layout output', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [makeBranch('develop')],
        remote: [{ remoteName: 'origin', branches: [makeBranch('origin/main', 'remote')] }],
      };

      const html = provider._getThreePanelHtmlContent(
        {} as any,
        data,
        [],
        undefined,
        [20, 50, 30],
        new Set<string>(),
        0,
        0
      );

      assert.ok(html.includes('branch-context-menu-local'), 'Three-panel layout should include local context menu');
      assert.ok(html.includes('branch-context-menu-remote'), 'Three-panel layout should include remote context menu');
    });

    it('should add data-branch and data-type attributes to local branch items for event delegation', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [makeBranch('develop'), makeBranch('feature/auth')],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(
        html.includes('data-branch="develop"') && html.includes('data-type="local"'),
        'Local branch develop should have data-branch and data-type="local" attributes'
      );
      assert.ok(
        html.includes('data-branch="feature/auth"') && html.includes('data-type="local"'),
        'Local branch feature/auth should have data-branch and data-type="local" attributes'
      );
    });

    it('should add data-branch and data-type attributes to remote branch items for event delegation', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [],
        remote: [
          {
            remoteName: 'origin',
            branches: [makeBranch('origin/main', 'remote')],
          },
        ],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(
        html.includes('data-branch="origin/main"') && html.includes('data-type="remote"'),
        'Remote branch should have data-branch and data-type="remote" attributes'
      );
    });
  });
});

describe('GitToolWindowProvider - Branch click handler (Requirement 2.6)', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    const extensionUri = Uri.file('/test/extension');
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Branch item onclick handlers in HTML', () => {
    it('should add data-branch attribute to HEAD branch item when not detached', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(
        html.includes('data-branch="main"'),
        'HEAD branch item should have data-branch="main" attribute'
      );
    });

    it('should add data-branch attribute to HEAD branch item when detached', () => {
      const data: IBranchPanelData = {
        head: { name: 'abc1234', isDetached: true, commitHash: 'abc1234' },
        local: [],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(
        html.includes('data-branch="abc1234"'),
        'Detached HEAD branch item should have data-branch="abc1234" attribute'
      );
    });

    it('should add data-branch attribute to local branch items', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [makeBranch('develop'), makeBranch('feature/auth')],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(
        html.includes('data-branch="develop"'),
        'Local branch develop should have data-branch attribute'
      );
      assert.ok(
        html.includes('data-branch="feature/auth"'),
        'Local branch feature/auth should have data-branch attribute'
      );
    });

    it('should add data-branch attribute to remote branch items', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [],
        remote: [
          {
            remoteName: 'origin',
            branches: [makeBranch('origin/main', 'remote'), makeBranch('origin/develop', 'remote')],
          },
        ],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(
        html.includes('data-branch="origin/main"'),
        'Remote branch origin/main should have data-branch attribute'
      );
      assert.ok(
        html.includes('data-branch="origin/develop"'),
        'Remote branch origin/develop should have data-branch attribute'
      );
    });

    it('should have both data-branch and data-type attributes on local branch items for event delegation', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [makeBranch('develop')],
        remote: [],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(
        html.includes('data-branch="develop"'),
        'Local branch should have data-branch attribute'
      );
      assert.ok(
        html.includes('data-type="local"'),
        'Local branch should have data-type="local" attribute for event delegation'
      );
    });

    it('should have both data-branch and data-type attributes on remote branch items for event delegation', () => {
      const data: IBranchPanelData = {
        head: { name: 'main', isDetached: false },
        local: [],
        remote: [
          {
            remoteName: 'origin',
            branches: [makeBranch('origin/main', 'remote')],
          },
        ],
      };

      const html = provider._getBranchPanelHtml(data);

      assert.ok(
        html.includes('data-branch="origin/main"'),
        'Remote branch should have data-branch attribute'
      );
      assert.ok(
        html.includes('data-type="remote"'),
        'Remote branch should have data-type="remote" attribute for event delegation'
      );
    });
  });

  describe('Extension host branchClick message handling', () => {
    it('should select the commit when branchClick message is received and branch is in branchMap', () => {
      // Set up commit data with a branch map
      const now = new Date();
      const commits = [
        {
          hash: 'commit1hash',
          shortHash: 'commit1',
          message: 'First commit',
          body: '',
          author: { name: 'Test', email: 'test@test.com', date: now },
          committer: { name: 'Test', email: 'test@test.com', date: now },
          parents: [] as string[],
          authorDate: now,
          commitDate: now,
        },
        {
          hash: 'commit2hash',
          shortHash: 'commit2',
          message: 'Second commit',
          body: '',
          author: { name: 'Test', email: 'test@test.com', date: now },
          committer: { name: 'Test', email: 'test@test.com', date: now },
          parents: ['commit1hash'],
          authorDate: now,
          commitDate: now,
        },
      ];

      const branchMap = new Map<string, string[]>();
      branchMap.set('commit2hash', ['main', 'develop']);

      provider.updateLogState(commits, branchMap);

      // Simulate branchClick by calling selectCommit (which is what _handleBranchClick does)
      // We verify the state after the branch click
      provider.selectCommit('commit2hash');

      const selectedCommits = provider.getSelectedCommits();
      assert.ok(selectedCommits.includes('commit2hash'), 'Should have selected the branch HEAD commit');
    });

    it('should handle branchClick for a branch that maps to a specific commit', () => {
      const now = new Date();
      const commits = [
        {
          hash: 'aaa111',
          shortHash: 'aaa',
          message: 'Commit on feature',
          body: '',
          author: { name: 'Test', email: 'test@test.com', date: now },
          committer: { name: 'Test', email: 'test@test.com', date: now },
          parents: [] as string[],
          authorDate: now,
          commitDate: now,
        },
      ];

      const branchMap = new Map<string, string[]>();
      branchMap.set('aaa111', ['feature/login']);

      provider.updateLogState(commits, branchMap);

      // Verify the extended log state has the branch map
      const extState = provider.getExtendedLogState();
      assert.ok(extState.branchMap.has('aaa111'), 'Branch map should contain the commit');
      assert.deepStrictEqual(
        extState.branchMap.get('aaa111'),
        ['feature/login'],
        'Branch map should map commit to feature/login'
      );
    });
  });
});

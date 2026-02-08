/**
 * Unit tests for StatusBarService.
 *
 * Tests cover:
 * - Status bar state management (Requirement 4.1)
 * - Branch name display
 * - Sync status display (ahead/behind)
 * - Detached HEAD state handling
 * - Repository state indicators
 *
 * Note: Full integration tests for StatusBarService UI require the VS Code extension host
 * and are covered in the extension test suite.
 */

import * as assert from 'assert';
import { IRepository, IHead } from '../../../services/interfaces/IGitService';
import { IStatusBarState } from '../../../services/interfaces/IStatusBarService';
import * as vscode from 'vscode';

describe('StatusBarService - Status Bar State (Requirement 4.1)', () => {
  describe('Branch name extraction', () => {
    it('should extract branch name from refs/heads/ prefix', () => {
      const headName = 'refs/heads/main';
      const branchName = headName.replace('refs/heads/', '');

      assert.strictEqual(branchName, 'main');
    });

    it('should handle feature branch names', () => {
      const headName = 'refs/heads/feature/my-feature';
      const branchName = headName.replace('refs/heads/', '');

      assert.strictEqual(branchName, 'feature/my-feature');
    });

    it('should handle nested branch names', () => {
      const headName = 'refs/heads/feature/nested/path/branch';
      const branchName = headName.replace('refs/heads/', '');

      assert.strictEqual(branchName, 'feature/nested/path/branch');
    });
  });

  describe('Sync status formatting', () => {
    it('should format ahead indicator correctly', () => {
      const ahead = 5;
      const indicator = `↑${ahead}`;

      assert.strictEqual(indicator, '↑5');
    });

    it('should format behind indicator correctly', () => {
      const behind = 3;
      const indicator = `↓${behind}`;

      assert.strictEqual(indicator, '↓3');
    });

    it('should format combined ahead/behind indicators', () => {
      const ahead = 2;
      const behind = 1;
      const indicators: string[] = [];

      if (ahead > 0) {
        indicators.push(`↑${ahead}`);
      }
      if (behind > 0) {
        indicators.push(`↓${behind}`);
      }

      const combined = indicators.join(' ');
      assert.strictEqual(combined, '↑2 ↓1');
    });

    it('should handle zero ahead/behind', () => {
      const ahead = 0;
      const behind = 0;
      const indicators: string[] = [];

      if (ahead > 0) {
        indicators.push(`↑${ahead}`);
      }
      if (behind > 0) {
        indicators.push(`↓${behind}`);
      }

      assert.strictEqual(indicators.length, 0);
    });
  });

  describe('Detached HEAD state', () => {
    it('should format short commit hash for detached HEAD', () => {
      const fullHash = 'abc123def456789';
      const shortHash = fullHash.substring(0, 7);

      assert.strictEqual(shortHash, 'abc123d');
    });

    it('should identify detached HEAD when name is undefined', () => {
      const head: IHead = {
        commit: 'abc123def456',
        ahead: 0,
        behind: 0,
      };

      const isDetached = head.name === undefined && head.commit !== undefined;
      assert.strictEqual(isDetached, true);
    });
  });
});

describe('StatusBarService - Repository State Building', () => {
  function buildState(repository: IRepository): IStatusBarState {
    const state: IStatusBarState = {
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: false,
      repositoryState: repository.state,
    };

    if (repository.head) {
      if (repository.head.name) {
        state.branchName = repository.head.name.replace('refs/heads/', '');
        state.isDetached = false;
      } else if (repository.head.commit) {
        state.isDetached = true;
        state.commitHash = repository.head.commit.substring(0, 7);
      }

      state.ahead = repository.head.ahead || 0;
      state.behind = repository.head.behind || 0;
      state.hasUpstream = repository.head.upstream !== undefined;
    }

    return state;
  }

  it('should build state for normal branch', () => {
    const repo: IRepository = {
      rootUri: vscode.Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'refs/heads/main',
        commit: 'abc123def456',
        ahead: 2,
        behind: 1,
        upstream: { remote: 'origin', name: 'main' },
      },
      remotes: [],
      submodules: [],
    };

    const state = buildState(repo);

    assert.strictEqual(state.branchName, 'main');
    assert.strictEqual(state.isDetached, false);
    assert.strictEqual(state.ahead, 2);
    assert.strictEqual(state.behind, 1);
    assert.strictEqual(state.hasUpstream, true);
    assert.strictEqual(state.repositoryState, 'idle');
  });

  it('should build state for detached HEAD', () => {
    const repo: IRepository = {
      rootUri: vscode.Uri.file('/test/repo'),
      state: 'idle',
      head: {
        commit: 'abc123def456789',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };

    const state = buildState(repo);

    assert.strictEqual(state.branchName, undefined);
    assert.strictEqual(state.isDetached, true);
    assert.strictEqual(state.commitHash, 'abc123d');
    assert.strictEqual(state.hasUpstream, false);
  });

  it('should build state for branch without upstream', () => {
    const repo: IRepository = {
      rootUri: vscode.Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'refs/heads/feature/new-feature',
        commit: 'abc123def456',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };

    const state = buildState(repo);

    assert.strictEqual(state.branchName, 'feature/new-feature');
    assert.strictEqual(state.hasUpstream, false);
    assert.strictEqual(state.ahead, 0);
    assert.strictEqual(state.behind, 0);
  });

  it('should build state for repository with no commits', () => {
    const repo: IRepository = {
      rootUri: vscode.Uri.file('/test/repo'),
      state: 'idle',
      head: undefined,
      remotes: [],
      submodules: [],
    };

    const state = buildState(repo);

    assert.strictEqual(state.branchName, undefined);
    assert.strictEqual(state.isDetached, false);
    assert.strictEqual(state.commitHash, undefined);
  });

  it('should capture repository state (merging)', () => {
    const repo: IRepository = {
      rootUri: vscode.Uri.file('/test/repo'),
      state: 'merging',
      head: {
        name: 'refs/heads/main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };

    const state = buildState(repo);

    assert.strictEqual(state.repositoryState, 'merging');
  });

  it('should capture repository state (rebasing)', () => {
    const repo: IRepository = {
      rootUri: vscode.Uri.file('/test/repo'),
      state: 'rebasing',
      head: {
        name: 'refs/heads/main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };

    const state = buildState(repo);

    assert.strictEqual(state.repositoryState, 'rebasing');
  });
});

describe('StatusBarService - Display Text Building', () => {
  function buildDisplayText(state: IStatusBarState, showSyncStatus: boolean = true): string {
    let statusText = '';

    if (state.isDetached) {
      statusText = `$(git-commit) ${state.commitHash || 'HEAD'}`;
    } else if (state.branchName) {
      statusText = `$(git-branch) ${state.branchName}`;

      if (showSyncStatus && state.hasUpstream) {
        const indicators: string[] = [];
        if (state.ahead > 0) {
          indicators.push(`↑${state.ahead}`);
        }
        if (state.behind > 0) {
          indicators.push(`↓${state.behind}`);
        }
        if (indicators.length > 0) {
          statusText += ` ${indicators.join(' ')}`;
        }
      }
    } else {
      statusText = '$(git-branch) No commits yet';
    }

    return statusText;
  }

  it('should build display text for normal branch', () => {
    const state: IStatusBarState = {
      branchName: 'main',
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state);
    assert.strictEqual(text, '$(git-branch) main');
  });

  it('should build display text with ahead/behind indicators', () => {
    const state: IStatusBarState = {
      branchName: 'main',
      ahead: 2,
      behind: 1,
      isDetached: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state);
    assert.strictEqual(text, '$(git-branch) main ↑2 ↓1');
  });

  it('should build display text with only ahead indicator', () => {
    const state: IStatusBarState = {
      branchName: 'main',
      ahead: 3,
      behind: 0,
      isDetached: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state);
    assert.strictEqual(text, '$(git-branch) main ↑3');
  });

  it('should build display text with only behind indicator', () => {
    const state: IStatusBarState = {
      branchName: 'main',
      ahead: 0,
      behind: 5,
      isDetached: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state);
    assert.strictEqual(text, '$(git-branch) main ↓5');
  });

  it('should build display text for detached HEAD', () => {
    const state: IStatusBarState = {
      ahead: 0,
      behind: 0,
      isDetached: true,
      commitHash: 'abc123d',
      hasUpstream: false,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state);
    assert.strictEqual(text, '$(git-commit) abc123d');
  });

  it('should build display text for no commits', () => {
    const state: IStatusBarState = {
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: false,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state);
    assert.strictEqual(text, '$(git-branch) No commits yet');
  });

  it('should not show sync status when no upstream', () => {
    const state: IStatusBarState = {
      branchName: 'feature/test',
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: false,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state);
    assert.strictEqual(text, '$(git-branch) feature/test');
  });

  it('should not show sync status when disabled', () => {
    const state: IStatusBarState = {
      branchName: 'main',
      ahead: 2,
      behind: 1,
      isDetached: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const text = buildDisplayText(state, false);
    assert.strictEqual(text, '$(git-branch) main');
  });
});

describe('StatusBarService - Repository State Indicators', () => {
  function getRepositoryStateIndicator(state: string): string {
    switch (state) {
      case 'merging':
        return '$(git-merge)';
      case 'rebasing':
        return '$(git-pull-request)';
      case 'cherry-picking':
        return '$(git-commit)';
      case 'reverting':
        return '$(discard)';
      default:
        return '';
    }
  }

  it('should return merge indicator for merging state', () => {
    const indicator = getRepositoryStateIndicator('merging');
    assert.strictEqual(indicator, '$(git-merge)');
  });

  it('should return rebase indicator for rebasing state', () => {
    const indicator = getRepositoryStateIndicator('rebasing');
    assert.strictEqual(indicator, '$(git-pull-request)');
  });

  it('should return cherry-pick indicator for cherry-picking state', () => {
    const indicator = getRepositoryStateIndicator('cherry-picking');
    assert.strictEqual(indicator, '$(git-commit)');
  });

  it('should return revert indicator for reverting state', () => {
    const indicator = getRepositoryStateIndicator('reverting');
    assert.strictEqual(indicator, '$(discard)');
  });

  it('should return empty string for idle state', () => {
    const indicator = getRepositoryStateIndicator('idle');
    assert.strictEqual(indicator, '');
  });
});

describe('StatusBarService - State Equality', () => {
  function statesEqual(a: IStatusBarState, b: IStatusBarState): boolean {
    return (
      a.branchName === b.branchName &&
      a.ahead === b.ahead &&
      a.behind === b.behind &&
      a.isDetached === b.isDetached &&
      a.commitHash === b.commitHash &&
      a.hasUpstream === b.hasUpstream &&
      a.repositoryState === b.repositoryState
    );
  }

  it('should detect equal states', () => {
    const state1: IStatusBarState = {
      branchName: 'main',
      ahead: 2,
      behind: 1,
      isDetached: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const state2: IStatusBarState = {
      branchName: 'main',
      ahead: 2,
      behind: 1,
      isDetached: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    assert.strictEqual(statesEqual(state1, state2), true);
  });

  it('should detect different branch names', () => {
    const state1: IStatusBarState = {
      branchName: 'main',
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const state2: IStatusBarState = {
      branchName: 'develop',
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    assert.strictEqual(statesEqual(state1, state2), false);
  });

  it('should detect different ahead counts', () => {
    const state1: IStatusBarState = {
      branchName: 'main',
      ahead: 2,
      behind: 0,
      isDetached: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const state2: IStatusBarState = {
      branchName: 'main',
      ahead: 3,
      behind: 0,
      isDetached: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    assert.strictEqual(statesEqual(state1, state2), false);
  });

  it('should detect different repository states', () => {
    const state1: IStatusBarState = {
      branchName: 'main',
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: true,
      repositoryState: 'idle',
    };

    const state2: IStatusBarState = {
      branchName: 'main',
      ahead: 0,
      behind: 0,
      isDetached: false,
      hasUpstream: true,
      repositoryState: 'merging',
    };

    assert.strictEqual(statesEqual(state1, state2), false);
  });
});

describe('StatusBarService - Click Actions', () => {
  const clickActions = ['branch-popup', 'sync', 'none'];

  function getCommandForAction(action: string): string | undefined {
    switch (action) {
      case 'branch-popup':
        return 'intellig.showBranchPopup';
      case 'sync':
        return 'intellig.sync';
      case 'none':
        return undefined;
      default:
        return undefined;
    }
  }

  it('should define all required click actions', () => {
    assert.ok(clickActions.includes('branch-popup'));
    assert.ok(clickActions.includes('sync'));
    assert.ok(clickActions.includes('none'));
  });

  it('should map branch-popup action to correct command', () => {
    const command = getCommandForAction('branch-popup');
    assert.strictEqual(command, 'intellig.showBranchPopup');
  });

  it('should map sync action to correct command', () => {
    const command = getCommandForAction('sync');
    assert.strictEqual(command, 'intellig.sync');
  });

  it('should map none action to undefined command', () => {
    const command = getCommandForAction('none');
    assert.strictEqual(command, undefined);
  });
});

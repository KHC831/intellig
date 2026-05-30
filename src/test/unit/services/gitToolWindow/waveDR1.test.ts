/**
 * Wave D R1 — review-round consolidated tests.
 *
 * Covers:
 *  - Senior H-2 / R1-1: webview branchName injection guard + argv hardening
 *  - Senior H-1 / TLD-M-2 / R1-2: async race generation guard
 *  - TLD-M-1 / R1-3: post-then-render ordering (ADR-009 §3)
 *  - Senior M-1 / R1-4: focus toggle semantics
 *  - Senior M-2 / R1-5: setFocusedBranch preserves selection
 *  - Senior M-3 / R1-6: drop focusedPathHashes from wire (covered in
 *    focusBranch.test.ts; mirrored here in the snap-6 renderer suite)
 */

import '../../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  GitToolWindowProvider,
  type IExtendedLogState,
} from '../../../../ui-shell/GitToolWindowProvider';
import { Uri } from '../../../mocks/vscode';

interface R1Internals {
  _extendedLogState: IExtendedLogState;
  _focusedPathHashes: Set<string>;
  _focusGeneration: number;
  _attachedGitService?: unknown;
  _availableRepositories: unknown[];
  _selectedRepositoryIndex: number;
  _handleWebviewMessage(message: { type: string; branchName?: unknown }): void;
  _view?: { webview?: { postMessage: (msg: unknown) => Thenable<boolean> } };
}

function mkCommit(
  hash: string,
  parents: string[] = []
): {
  hash: string;
  shortHash: string;
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  parents: string[];
  authorDate: Date;
  commitDate: Date;
} {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: `commit ${hash}`,
    author: { name: 'a', email: 'a@x' },
    committer: { name: 'a', email: 'a@x' },
    parents,
    authorDate: new Date(0),
    commitDate: new Date(0),
  };
}

function stubWebview(provider: GitToolWindowProvider): {
  messages: Array<Record<string, unknown>>;
  htmlAssignments: number;
  postsAfterLastHtml: number;
} {
  const messages: Array<Record<string, unknown>> = [];
  let htmlAssignments = 0;
  let postsAfterLastHtml = 0;
  let lastEventType: 'html' | 'post' | null = null;
  const webviewProxy = {
    cspSource: 'test:',
    asWebviewUri: (u: vscode.Uri) => u,
    _html: '',
    get html() {
      return this._html;
    },
    set html(v: string) {
      this._html = v;
      htmlAssignments += 1;
      lastEventType = 'html';
    },
    postMessage: (msg: Record<string, unknown>) => {
      messages.push(msg);
      if (lastEventType === 'html') {
        postsAfterLastHtml += 1;
      }
      lastEventType = 'post';
      return Promise.resolve(true);
    },
  };
  (provider as unknown as { _view: unknown })._view = {
    webview: webviewProxy,
    visible: true,
    show: () => {},
    title: 'test',
    description: '',
    onDidDispose: () => ({ dispose: () => {} }),
    onDidChangeVisibility: () => ({ dispose: () => {} }),
  };
  return {
    messages,
    get htmlAssignments() {
      return htmlAssignments;
    },
    get postsAfterLastHtml() {
      return postsAfterLastHtml;
    },
  };
}

function attachStubMergeBase(
  provider: GitToolWindowProvider,
  resolver: (refA: string, refB: string) => string | undefined | Promise<string | undefined>
): { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const internals = provider as unknown as R1Internals;
  internals._attachedGitService = {
    getMergeBase: async (_repo: unknown, refA: string, refB: string) => {
      calls.push([refA, refB]);
      return resolver(refA, refB);
    },
  };
  internals._availableRepositories = [{ rootUri: { fsPath: '/tmp/repo' } }];
  internals._selectedRepositoryIndex = 0;
  return { calls };
}

describe('Wave D R1 — review-round fixes', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  // ─── R1-1: webview branchName injection guard ───────────────────────
  describe('R1-1 — webview branchName injection (Senior H-2)', () => {
    it('drops focusBranchOnGraph for branchName not in branchMap', () => {
      const internals = provider as unknown as R1Internals;
      const branchMap = new Map<string, string[]>();
      branchMap.set('aaa', ['feature']);
      provider.updateLogState([mkCommit('aaa')], branchMap);

      // Inject a malicious option-like string. Must NOT propagate to
      // setFocusedBranch.
      internals._handleWebviewMessage({
        type: 'focusBranchOnGraph',
        branchName: '--upload-pack=evil',
      });

      assert.strictEqual(
        internals._extendedLogState.focusedBranchName,
        null,
        'focusedBranchName must remain null when an unknown name is posted'
      );
    });

    it('drops focusBranchOnGraph for any string not in the live branch list', () => {
      const internals = provider as unknown as R1Internals;
      const branchMap = new Map<string, string[]>();
      branchMap.set('aaa', ['feature']);
      provider.updateLogState([mkCommit('aaa')], branchMap);

      internals._handleWebviewMessage({
        type: 'focusBranchOnGraph',
        branchName: 'unknown-branch',
      });

      assert.strictEqual(internals._extendedLogState.focusedBranchName, null);
    });

    it('still allows null branchName (clear focus path)', async () => {
      const internals = provider as unknown as R1Internals;
      const branchMap = new Map<string, string[]>();
      branchMap.set('aaa', ['feature']);
      provider.updateLogState([mkCommit('aaa')], branchMap);

      // Set focus first, then clear via null.
      await provider.setFocusedBranch('feature');
      assert.strictEqual(internals._extendedLogState.focusedBranchName, 'feature');

      internals._handleWebviewMessage({
        type: 'focusBranchOnGraph',
        branchName: null,
      });

      // Need to wait a microtask for the void Promise to resolve.
      await Promise.resolve();
      assert.strictEqual(internals._extendedLogState.focusedBranchName, null);
    });
  });

  // ─── R1-2: async race generation guard ──────────────────────────────
  describe('R1-2 — async race generation guard (Senior H-1, TLD-M-2)', () => {
    it('rapid focus(A) → focus(B) lands B as the final state even when A resolves last', async () => {
      const internals = provider as unknown as R1Internals;
      stubWebview(provider);

      const branchMap = new Map<string, string[]>();
      branchMap.set('aaa', ['feature-A']);
      branchMap.set('bbb', ['feature-B']);
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb')], branchMap);

      // Build deferred promises so we can resolve in arbitrary order.
      let resolveA: (v: string | undefined) => void = () => {};
      let resolveB: (v: string | undefined) => void = () => {};
      const promiseA = new Promise<string | undefined>((res) => (resolveA = res));
      const promiseB = new Promise<string | undefined>((res) => (resolveB = res));

      attachStubMergeBase(provider, (_refA, refB) => {
        if (refB === 'feature-A') {
          return promiseA;
        }
        if (refB === 'feature-B') {
          return promiseB;
        }
        return undefined;
      });

      // Kick off both focus calls; A first, B second.
      const opA = provider.setFocusedBranch('feature-A');
      const opB = provider.setFocusedBranch('feature-B');

      // Resolve B first (the "winning" intent), then A (the "stale"
      // intent — should bail).
      resolveB(undefined);
      await opB;
      resolveA(undefined);
      await opA;

      assert.strictEqual(
        internals._extendedLogState.focusedBranchName,
        'feature-B',
        'final focus must reflect the LAST intent (B), not the last-to-resolve (A)'
      );
    });

    it('updateLogState dropping the focused branch causes in-flight focus(A) to bail', async () => {
      const internals = provider as unknown as R1Internals;
      stubWebview(provider);

      const branchMap1 = new Map<string, string[]>();
      branchMap1.set('aaa', ['feature']);
      provider.updateLogState([mkCommit('aaa')], branchMap1);

      let resolveMergeBase: (v: string | undefined) => void = () => {};
      const mergeBaseP = new Promise<string | undefined>((res) => (resolveMergeBase = res));
      attachStubMergeBase(provider, () => mergeBaseP);

      const opA = provider.setFocusedBranch('feature');

      // Refresh removes 'feature' from the branch list.
      const branchMap2 = new Map<string, string[]>();
      branchMap2.set('aaa', ['main']);
      provider.updateLogState([mkCommit('aaa')], branchMap2);

      resolveMergeBase(undefined);
      await opA;

      assert.strictEqual(
        internals._extendedLogState.focusedBranchName,
        null,
        'focus must remain cleared (updateLogState dropped feature; focus(A) must bail)'
      );
    });
  });

  // ─── R1-3: post-then-render ordering (ADR-009 §3) ────────────────────
  describe('R1-3 — post-then-render ordering (TLD-M-1, ADR-009 §3)', () => {
    it('setFocusedBranch posts updateBranchFocus AFTER the html reassignment', async () => {
      const recorded = stubWebview(provider);

      const branchMap = new Map<string, string[]>();
      branchMap.set('aaa', ['feature']);
      provider.updateLogState([mkCommit('aaa')], branchMap);
      // Reset post-html-counter from updateLogState's render burst.
      const beforePosts = recorded.postsAfterLastHtml;

      attachStubMergeBase(provider, () => undefined);

      await provider.setFocusedBranch('feature');

      // After the call, at least one post (`updateBranchFocus`) should
      // be observed AFTER the most recent html assignment from
      // setFocusedBranch's own _updateWebview() call.
      const postsAfter = recorded.postsAfterLastHtml - beforePosts;
      assert.ok(
        postsAfter >= 1,
        `expected ≥1 post after the last html assignment; got ${postsAfter}`
      );
    });

    it('setFocusedBranch(null) posts updateBranchFocus AFTER the html reassignment', async () => {
      const recorded = stubWebview(provider);

      const branchMap = new Map<string, string[]>();
      branchMap.set('aaa', ['feature']);
      provider.updateLogState([mkCommit('aaa')], branchMap);

      const before = recorded.postsAfterLastHtml;
      await provider.setFocusedBranch(null);

      const postsAfter = recorded.postsAfterLastHtml - before;
      assert.ok(
        postsAfter >= 1,
        `null-clear path: expected ≥1 post after the last html assignment; got ${postsAfter}`
      );
    });
  });

  // ─── R1-4: focus toggle semantics ────────────────────────────────────
  describe('R1-4 — focus toggle (Senior M-1)', () => {
    it('getFocusedBranchName returns null initially', () => {
      assert.strictEqual(provider.getFocusedBranchName(), null);
    });

    it('getFocusedBranchName returns the focused name after setFocusedBranch', async () => {
      const branchMap = new Map<string, string[]>();
      branchMap.set('aaa', ['feature']);
      provider.updateLogState([mkCommit('aaa')], branchMap);

      await provider.setFocusedBranch('feature');
      assert.strictEqual(provider.getFocusedBranchName(), 'feature');

      // The toggle logic itself lives in extension.ts; we exercise the
      // accessor. Re-clicking the same branch in the command handler
      // computes `currentName === branchName ? null : branchName`.
      // Verify that flow with two manual calls.
      await provider.setFocusedBranch(null);
      assert.strictEqual(provider.getFocusedBranchName(), null);
    });
  });

  // ─── R1-1 part 2: argv hardening for getMergeBase ───────────────────
  describe('R1-1 — getMergeBase argv hardening (Senior H-2)', () => {
    it('GitService.getMergeBase passes --end-of-options before the refs', async () => {
      // Defer-load to avoid a top-level import cycle with the mocha
      // setup file when this file is run alone.
      const { GitService } = await import('../../../../git-core/GitService');
      const gitService = new GitService();

      const executedArgs: string[][] = [];
      class MockCli {
        async exec(args: string[]): Promise<{
          exitCode: number;
          stdout: string;
          stderr: string;
          combined: string;
        }> {
          executedArgs.push([...args]);
          return { exitCode: 0, stdout: 'mergebasehash\n', stderr: '', combined: '' };
        }
        async getRepositoryRoot(p: string): Promise<string> {
          return p;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        get onCommandExecuted(): any {
          return (): { dispose: () => void } => ({ dispose: () => {} });
        }
        dispose(): void {}
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (gitService as any)._gitCli = new MockCli();

      const mockRepo = {
        rootUri: Uri.file('/test/repo'),
        state: 'idle',
        head: {
          name: 'refs/heads/main',
          commit: 'abc',
          upstream: undefined,
          ahead: 0,
          behind: 0,
        },
        remotes: [],
        submodules: [],
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const out = await (gitService as any).getMergeBase(mockRepo, 'HEAD', 'feature');
      assert.strictEqual(out, 'mergebasehash');

      assert.strictEqual(executedArgs.length, 1);
      assert.deepStrictEqual(
        executedArgs[0],
        ['merge-base', '--end-of-options', 'HEAD', 'feature'],
        '--end-of-options must precede positional refs to defang option-injection'
      );

      gitService.dispose();
    });
  });

  // ─── R1-5: selection preservation ────────────────────────────────────
  describe('R1-5 — setFocusedBranch preserves selection (Senior M-2)', () => {
    it('does not clear selectedCommits / anchorHash / expandedCommit', async () => {
      const internals = provider as unknown as R1Internals;
      stubWebview(provider);

      const branchMap = new Map<string, string[]>();
      branchMap.set('aaa', ['feature']);
      provider.updateLogState(
        [mkCommit('aaa', ['bbb']), mkCommit('bbb', ['ccc']), mkCommit('ccc')],
        branchMap
      );

      // User multi-selects via shift-click semantics: bbb is the
      // anchor, range to ccc.
      provider.selectCommit('bbb');
      provider.rangeSelectCommit('ccc');
      const beforeSelected = new Set(internals._extendedLogState.selectedCommits);
      const beforeAnchor = internals._extendedLogState.anchorHash;
      const beforeExpanded = internals._extendedLogState.expandedCommit;
      assert.strictEqual(beforeSelected.size, 2, 'sanity: 2 selected pre-focus');

      attachStubMergeBase(provider, () => undefined);

      await provider.setFocusedBranch('feature');

      assert.deepStrictEqual(
        Array.from(internals._extendedLogState.selectedCommits).sort(),
        Array.from(beforeSelected).sort(),
        'selectedCommits must be preserved across focus'
      );
      assert.strictEqual(
        internals._extendedLogState.anchorHash,
        beforeAnchor,
        'anchorHash must be preserved across focus'
      );
      assert.strictEqual(
        internals._extendedLogState.expandedCommit,
        beforeExpanded,
        'expandedCommit must be preserved across focus'
      );
    });
  });
});

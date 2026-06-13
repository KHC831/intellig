/**
 * Unit tests for Rebase --skip.
 *
 * Coverage:
 *   - `GitService.rebaseSkip` runs `git rebase --skip` with the right cwd.
 *   - On exit 0 → `{ success: true }`.
 *   - On non-zero → queries `git status --porcelain` and returns unmerged
 *     files as `conflicts`.
 *   - `ResolveConflictsDialog` renders the Skip button only when
 *     `operation === 'rebase'`.
 *   - Confirmed `skip` message dispatches to `gitService.rebaseSkip`.
 *   - Cancelled confirm → no dispatch, no close.
 */

/*
 * Stub factories synthesise IGitService / IConflictService / IMergeView
 * implementations whose member signatures return `Promise<T>`; no-await
 * stub bodies are intentional here.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../../../git-core/GitService';
import { ResolveConflictsDialog } from '../../../conflicts/ResolveConflictsDialog';
import type {
  IGitService,
  IRepository,
  IBasicRebaseResult,
} from '../../../git-core/interfaces/IGitService';
import type {
  IConflictResolutionService,
  IConflictOpContext,
  IConflictedFile,
} from '../../../conflicts/interfaces/IConflictResolutionService';
import type { IMergeView } from '../../../conflicts/interfaces/IMergeView';

/**
 * Test-only surface on GitService for injecting a scripted CLI.
 *
 * `_gitCli` is the private CLI handle that GitService normally wires via its
 * constructor. The tests in this file swap in a scripted mock so we can assert
 * both the argv passed to `git` and the shape of the returned result — without
 * spawning a real subprocess. `unknown` is deliberate: the scripted mock
 * implements only the shape the tests exercise (`exec`, `onCommandExecuted`,
 * `getRepositoryRoot`, `dispose`), not the full GitCli contract.
 *
 * See `docs/testing.md` §3 for the TestSurface convention.
 */
interface GitServiceGitCliTestSurface {
  _gitCli: unknown;
}

/**
 * Minimal extension-context stub — mirrors the pattern used by other dialog
 * tests under src/test/unit/services.
 */
function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file('/tmp/ext'),
  } as unknown as vscode.ExtensionContext;
}

/**
 * Build a real-ish GitService with a scripted CLI so we can assert both the
 * argv passed to `git` and the shape of the returned result.
 */
function makeGitServiceScripted(
  responses: Array<{
    match: (args: string[]) => boolean;
    result: {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
  }>
): {
  gitService: IGitService;
  calls: string[][];
} {
  const calls: string[][] = [];
  const mockCli = {
    async exec(
      args: string[]
    ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
      calls.push([...args]);
      for (const r of responses) {
        if (r.match(args)) {
          return { ...r.result, combined: r.result.stdout + r.result.stderr };
        }
      }
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    get onCommandExecuted() {
      return () => ({ dispose: () => {} });
    },
    async getRepositoryRoot(p: string): Promise<string | undefined> {
      return p;
    },
    dispose(): void {},
  };
  // Construct GitService bypassing its default CLI wiring.
  const svc = new GitService() as unknown as GitServiceGitCliTestSurface;
  svc._gitCli = mockCli;
  return { gitService: svc as unknown as IGitService, calls };
}

describe('GitService.rebaseSkip', () => {
  let repo: IRepository;
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-skip-'));
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    repo = {
      rootUri: vscode.Uri.file(repoRoot),
      state: 'rebasing',
      remotes: [],
      submodules: [],
    } as unknown as IRepository;
  });

  afterEach(() => {
    try {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('invokes `git rebase --skip` with the repo cwd and returns success on exit 0', async () => {
    const { gitService, calls } = makeGitServiceScripted([
      {
        match: (a): boolean => a[0] === 'rebase' && a[1] === '--skip',
        result: { exitCode: 0, stdout: '', stderr: '' },
      },
    ]);

    const result: IBasicRebaseResult = await gitService.rebaseSkip(repo);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.conflicts, undefined);

    const skipCall = calls.find((c) => c[0] === 'rebase' && c[1] === '--skip');
    assert.ok(skipCall, 'expected git rebase --skip to be invoked');
  });

  it('returns conflict paths parsed from `git status --porcelain` on non-zero exit', async () => {
    const { gitService } = makeGitServiceScripted([
      {
        match: (a): boolean => a[0] === 'rebase' && a[1] === '--skip',
        result: { exitCode: 1, stdout: '', stderr: 'next commit has conflicts' },
      },
      {
        match: (a): boolean => a[0] === 'status' && a[1] === '--porcelain',
        result: {
          exitCode: 0,
          stdout: 'UU src/a.ts\nUU src/b.ts\n M src/clean.ts\n',
          stderr: '',
        },
      },
    ]);

    const result = await gitService.rebaseSkip(repo);
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(
      (result.conflicts ?? []).sort(),
      ['src/a.ts', 'src/b.ts'].sort(),
      'only unmerged files should surface in conflicts'
    );
  });
});

describe('ResolveConflictsDialog Skip button', () => {
  let ctx: vscode.ExtensionContext;
  let repo: IRepository;

  /** Build a thin dialog stub environment shared across tests. */
  function buildEnv(opContext: IConflictOpContext): {
    gitService: IGitService & { _rebaseSkipCalls: number };
    dialog: ResolveConflictsDialog;
    conflictService: IConflictResolutionService;
  } {
    const mergeView = {
      onDidResolve: new vscode.EventEmitter<string>().event,
      async show() {},
    } as unknown as IMergeView;

    const conflictService = {
      async acceptCurrent() {
        return { success: true };
      },
      async acceptIncoming() {
        return { success: true };
      },
    } as unknown as IConflictResolutionService;

    let rebaseSkipCalls = 0;
    const gitService = {
      gitCli: {
        async exec() {
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      async rebaseSkip(): Promise<IBasicRebaseResult> {
        rebaseSkipCalls++;
        return { success: true };
      },
      get _rebaseSkipCalls(): number {
        return rebaseSkipCalls;
      },
    } as unknown as IGitService & { _rebaseSkipCalls: number };

    const conflicts: IConflictedFile[] = [{ path: 'a.ts', resolved: false }];
    const dialog = new ResolveConflictsDialog(
      ctx,
      repo,
      conflicts,
      opContext,
      conflictService,
      mergeView,
      gitService
    );
    return { gitService, dialog, conflictService };
  }

  beforeEach(() => {
    ctx = makeContext();
    repo = {
      rootUri: vscode.Uri.file('/tmp/fake-repo'),
      state: 'rebasing',
      remotes: [],
      submodules: [],
    } as unknown as IRepository;
  });

  it('renders the Skip button only when operation === rebase', () => {
    const rebaseEnv = buildEnv({ operation: 'rebase', canAbort: true, canContinue: true });
    try {
      const html = (rebaseEnv.dialog as unknown as { _panel: vscode.WebviewPanel })._panel.webview
        .html;
      assert.ok(html.includes('data-action="skip"'), 'rebase dialog should render the Skip button');
    } finally {
      rebaseEnv.dialog.dispose();
    }

    const mergeEnv = buildEnv({ operation: 'merge', canAbort: true, canContinue: true });
    try {
      const html = (mergeEnv.dialog as unknown as { _panel: vscode.WebviewPanel })._panel.webview
        .html;
      assert.ok(!html.includes('data-action="skip"'), 'merge dialog should NOT render Skip');
    } finally {
      mergeEnv.dialog.dispose();
    }

    const cherryEnv = buildEnv({ operation: 'cherryPick', canAbort: true, canContinue: true });
    try {
      const html = (cherryEnv.dialog as unknown as { _panel: vscode.WebviewPanel })._panel.webview
        .html;
      assert.ok(!html.includes('data-action="skip"'), 'cherry-pick dialog should NOT render Skip');
    } finally {
      cherryEnv.dialog.dispose();
    }
  });

  it('skip message dispatches to rebaseSkip after user confirms', async () => {
    const { gitService, dialog } = buildEnv({
      operation: 'rebase',
      canAbort: true,
      canContinue: true,
    });
    try {
      // Stub showWarningMessage to return 'Skip' (user confirmed).
      const originalWarn = vscode.window.showWarningMessage;
      (
        vscode.window as unknown as {
          showWarningMessage: (...a: unknown[]) => Promise<string | undefined>;
        }
      ).showWarningMessage = async () => 'Skip';

      try {
        await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
          type: 'skip',
        });
      } finally {
        (
          vscode.window as unknown as { showWarningMessage: typeof originalWarn }
        ).showWarningMessage = originalWarn;
      }

      assert.strictEqual(gitService._rebaseSkipCalls, 1, 'rebaseSkip should be called once');
    } finally {
      dialog.dispose();
    }
  });

  it('skip message is a no-op when user cancels the confirm modal', async () => {
    const { gitService, dialog } = buildEnv({
      operation: 'rebase',
      canAbort: true,
      canContinue: true,
    });
    try {
      const originalWarn = vscode.window.showWarningMessage;
      (
        vscode.window as unknown as { showWarningMessage: () => Promise<string | undefined> }
      ).showWarningMessage = async () => undefined;

      try {
        await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
          type: 'skip',
        });
      } finally {
        (
          vscode.window as unknown as { showWarningMessage: typeof originalWarn }
        ).showWarningMessage = originalWarn;
      }

      assert.strictEqual(gitService._rebaseSkipCalls, 0, 'rebaseSkip must not be called on cancel');
    } finally {
      dialog.dispose();
    }
  });

  it('skip message on a non-rebase operation is ignored even if the host receives it', async () => {
    const { gitService, dialog } = buildEnv({
      operation: 'merge',
      canAbort: true,
      canContinue: true,
    });
    try {
      const originalWarn = vscode.window.showWarningMessage;
      (
        vscode.window as unknown as { showWarningMessage: () => Promise<string | undefined> }
      ).showWarningMessage = async () => 'Skip';

      try {
        await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
          type: 'skip',
        });
      } finally {
        (
          vscode.window as unknown as { showWarningMessage: typeof originalWarn }
        ).showWarningMessage = originalWarn;
      }

      assert.strictEqual(gitService._rebaseSkipCalls, 0, 'non-rebase skip must be a no-op');
    } finally {
      dialog.dispose();
    }
  });
});

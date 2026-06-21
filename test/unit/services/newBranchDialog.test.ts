/**
 * Unit tests for the New Branch Dialog.
 *
 * Covers:
 *  - `validateNewBranchName` — empty / whitespace / valid shapes / invalid chars.
 *  - `looksRemoteStartPoint` — bare `origin/main` → true; `HEAD`, commit
 *    hashes, tag-like `v1.2.3`, and `undefined` → false.
 *  - `GitService.createBranch` — arg construction for every option shape:
 *    legacy string startPoint, options object, force, track, checkout,
 *    checkout + force (uses `-B` in one atomic `git checkout`).
 *  - `NewBranchDialog._onMessage`:
 *      * cancel → dispose, no git call.
 *      * empty name → error toast (from the validator), no git call.
 *      * valid create → createBranch with correct option object; success
 *        toast + onBranchCreated fired; dialog disposed.
 *      * create error (e.g. branch exists w/o overwrite) → error toast,
 *        dialog remains open for retry.
 */

/*
 * Stub factories synthesise IGitService / gitCli implementations whose
 * member signatures return `Promise<T>`; no-await stub bodies are
 * intentional here.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitService } from '../../../src/git-core/GitService';
import {
  NewBranchDialog,
  INewBranchDialogOptions,
  looksRemoteStartPoint,
  validateNewBranchName,
} from '../../../src/branches/NewBranchDialog';
import {
  ICreateBranchOptions,
  IGitService,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    workspaceState: {} as vscode.Memento,
    globalState: {} as vscode.Memento,
    extensionPath: '/tmp/ext',
    storagePath: undefined,
    globalStoragePath: '/tmp/global',
    logPath: '/tmp/log',
    extensionUri: vscode.Uri.file('/tmp/ext'),
    storageUri: undefined,
    globalStorageUri: vscode.Uri.file('/tmp/global'),
    logUri: vscode.Uri.file('/tmp/log'),
    extensionMode: 3,
    asAbsolutePath: (rel: string): string => `/tmp/ext/${rel}`,
  } as unknown as vscode.ExtensionContext;
}

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

interface CreateBranchCall {
  repo: IRepository;
  name: string;
  options?: string | ICreateBranchOptions;
}

function makeGitService(shouldThrow?: Error): IGitService & { _createCalls: CreateBranchCall[] } {
  const calls: CreateBranchCall[] = [];
  return {
    _createCalls: calls,
    createBranch: async (
      repo: IRepository,
      name: string,
      options?: string | ICreateBranchOptions
    ) => {
      calls.push({ repo, name, options });
      if (shouldThrow) {
        throw shouldThrow;
      }
    },
  } as unknown as IGitService & { _createCalls: CreateBranchCall[] };
}

interface MessageLog {
  info: string[];
  error: string[];
}

function installMessageTrackers(): MessageLog {
  const log: MessageLog = { info: [], error: [] };
  (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = async (
    m: string
  ) => {
    log.info.push(m);
    return undefined;
  };
  (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = async (
    m: string
  ) => {
    log.error.push(m);
    return undefined;
  };
  return log;
}

class TestNewBranchDialog extends NewBranchDialog {
  public async simulateMessage(raw: unknown): Promise<void> {
    await (this as unknown as { _onMessage(m: unknown): Promise<void> })._onMessage(raw);
  }
  public disposed(): boolean {
    return (this as unknown as { _disposed: boolean })._disposed;
  }
}

function makeDialog(overrides: Partial<INewBranchDialogOptions> = {}): {
  dialog: TestNewBranchDialog;
  gitService: IGitService & { _createCalls: CreateBranchCall[] };
  onCreatedCalls: number;
} {
  const gitService =
    (overrides.gitService as (IGitService & { _createCalls: CreateBranchCall[] }) | undefined) ??
    makeGitService();
  let onCreatedCalls = 0;
  const dialog = new TestNewBranchDialog(makeContext(), {
    repo: overrides.repo ?? makeRepo(),
    gitService,
    startPoint: overrides.startPoint,
    defaultName: overrides.defaultName,
    onBranchCreated:
      overrides.onBranchCreated ??
      (() => {
        onCreatedCalls += 1;
      }),
  });
  return {
    dialog,
    gitService: gitService as IGitService & { _createCalls: CreateBranchCall[] },
    get onCreatedCalls() {
      return onCreatedCalls;
    },
  } as ReturnType<typeof makeDialog>;
}

// ─── validateNewBranchName ───────────────────────────────────────────────────

describe('validateNewBranchName', () => {
  it('rejects empty name', () => {
    assert.ok(validateNewBranchName(''));
  });

  it('rejects whitespace-only name', () => {
    assert.ok(validateNewBranchName('   '));
  });

  it('accepts simple name', () => {
    assert.strictEqual(validateNewBranchName('feature'), undefined);
  });

  it('accepts nested name', () => {
    assert.strictEqual(validateNewBranchName('feature/my-branch'), undefined);
  });

  it('accepts dots and hyphens', () => {
    assert.strictEqual(validateNewBranchName('release/v1.2.3-rc.1'), undefined);
  });

  it('rejects spaces', () => {
    assert.ok(validateNewBranchName('my branch'));
  });

  it('rejects colons', () => {
    assert.ok(validateNewBranchName('foo:bar'));
  });

  it('rejects quotes', () => {
    assert.ok(validateNewBranchName('foo"bar'));
  });

  // C-2: SR-3 ref-dash parity. Git parses `-foo` as a CLI flag,
  // bypassing argv-spawn defense. `.hidden` is invalid per
  // git-check-ref-format. Both must be rejected at the dialog boundary.
  it('rejects leading dash (R5 C-2)', () => {
    assert.ok(validateNewBranchName('-foo'));
  });

  it('rejects leading dot (R5 C-2)', () => {
    assert.ok(validateNewBranchName('.hidden'));
  });

  it('accepts dash after a leading letter (R5 C-2)', () => {
    // Only the first character is restricted; embedded dashes are fine.
    assert.strictEqual(validateNewBranchName('feature-x'), undefined);
  });
});

// ─── looksRemoteStartPoint ───────────────────────────────────────────────────

describe('looksRemoteStartPoint', () => {
  it('undefined → false', () => {
    assert.strictEqual(looksRemoteStartPoint(undefined), false);
  });

  it('HEAD → false (no slash)', () => {
    assert.strictEqual(looksRemoteStartPoint('HEAD'), false);
  });

  it('main → false (no slash)', () => {
    assert.strictEqual(looksRemoteStartPoint('main'), false);
  });

  it('origin/main → true', () => {
    assert.strictEqual(looksRemoteStartPoint('origin/main'), true);
  });

  it('upstream/feature/x → true', () => {
    assert.strictEqual(looksRemoteStartPoint('upstream/feature/x'), true);
  });

  it('refs/remotes/origin/main → true', () => {
    assert.strictEqual(looksRemoteStartPoint('refs/remotes/origin/main'), true);
  });

  it('commit hash abc1234 (no slash) → false', () => {
    assert.strictEqual(looksRemoteStartPoint('abc1234'), false);
  });

  it('commit-hash-prefixed slash path like abc1234/subtree → false', () => {
    // Heuristic: first segment hex-only = commit hash, not a remote.
    assert.strictEqual(looksRemoteStartPoint('abc1234/subtree'), false);
  });
});

// ─── GitService.createBranch arg construction ────────────────────────────────

describe('GitService.createBranch — arg order', () => {
  function installGitService(): { gitService: GitService; executed: string[][] } {
    const gitService = new GitService();
    const executed: string[][] = [];
    const gitCli = {
      onCommandExecuted: (): { dispose: () => void } => ({ dispose: (): void => {} }),
      exec: async (args: string[]) => {
        executed.push([...args]);
        return { exitCode: 0, stdout: '', stderr: '', combined: '' };
      },
      invalidateCache: () => {},
    };
    (gitService as unknown as { _gitCli: unknown })._gitCli = gitCli;
    return { gitService, executed };
  }

  it('legacy string startPoint → `git branch <name> <startPoint>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x', 'main');
    // startPoint follows `--end-of-options`.
    assert.deepStrictEqual(executed[0], ['branch', 'feature/x', '--end-of-options', 'main']);
  });

  it('no startPoint → `git branch <name>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x');
    assert.deepStrictEqual(executed[0], ['branch', 'feature/x']);
  });

  it('options.startPoint → `git branch <name> <startPoint>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x', { startPoint: 'main' });
    // startPoint follows `--end-of-options`.
    assert.deepStrictEqual(executed[0], ['branch', 'feature/x', '--end-of-options', 'main']);
  });

  it('options.force → `git branch -f <name> <startPoint>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x', { startPoint: 'main', force: true });
    // startPoint follows `--end-of-options`.
    assert.deepStrictEqual(executed[0], ['branch', '-f', 'feature/x', '--end-of-options', 'main']);
  });

  it('options.track → `git branch --track <name> <startPoint>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x', {
      startPoint: 'origin/main',
      track: true,
    });
    // startPoint follows `--end-of-options`.
    assert.deepStrictEqual(executed[0], [
      'branch',
      '--track',
      'feature/x',
      '--end-of-options',
      'origin/main',
    ]);
  });

  it('options.checkout → `git checkout -b <name> <startPoint>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x', {
      startPoint: 'main',
      checkout: true,
    });
    // startPoint follows `--end-of-options`.
    assert.deepStrictEqual(executed[0], [
      'checkout',
      '-b',
      'feature/x',
      '--end-of-options',
      'main',
    ]);
  });

  it('options.checkout + force → `git checkout -B <name> <startPoint>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x', {
      startPoint: 'main',
      checkout: true,
      force: true,
    });
    // startPoint follows `--end-of-options`.
    assert.deepStrictEqual(executed[0], [
      'checkout',
      '-B',
      'feature/x',
      '--end-of-options',
      'main',
    ]);
  });

  it('options.checkout + track → `git checkout -b <name> --track <startPoint>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x', {
      startPoint: 'origin/main',
      checkout: true,
      track: true,
    });
    // startPoint follows `--end-of-options`.
    assert.deepStrictEqual(executed[0], [
      'checkout',
      '-b',
      'feature/x',
      '--track',
      '--end-of-options',
      'origin/main',
    ]);
  });

  // C-2: service-boundary defense. Even if an upstream caller
  // skips validateNewBranchName, createBranch must reject names that
  // git would parse as CLI flags (`-foo`) or invalid ref shapes (`.hidden`).
  it('rejects leading dash at the service boundary (R5 C-2)', async () => {
    const { gitService, executed } = installGitService();
    await assert.rejects(
      () => gitService.createBranch(makeRepo(), '-foo', { startPoint: 'main' }),
      /Invalid branch name/
    );
    assert.strictEqual(executed.length, 0, 'no git command should have been issued');
  });

  it('rejects leading dot at the service boundary (R5 C-2)', async () => {
    const { gitService, executed } = installGitService();
    await assert.rejects(
      () => gitService.createBranch(makeRepo(), '.hidden'),
      /Invalid branch name/
    );
    assert.strictEqual(executed.length, 0);
  });

  it('rejects empty name at the service boundary (R5 C-2)', async () => {
    const { gitService, executed } = installGitService();
    await assert.rejects(() => gitService.createBranch(makeRepo(), ''), /Invalid branch name/);
    assert.strictEqual(executed.length, 0);
  });
});

// ─── Dialog lifecycle ────────────────────────────────────────────────────────

describe('NewBranchDialog — lifecycle', () => {
  it('cancel disposes without invoking git', async () => {
    installMessageTrackers();
    const h = makeDialog({ startPoint: 'main' });
    await h.dialog.simulateMessage({ type: 'cancel' });
    assert.strictEqual(h.gitService._createCalls.length, 0);
    assert.strictEqual(h.dialog.disposed(), true);
  });

  it('empty name: error toast, no git call', async () => {
    const log = installMessageTrackers();
    const h = makeDialog({ startPoint: 'main' });
    await h.dialog.simulateMessage({ type: 'create', name: '' });
    assert.strictEqual(h.gitService._createCalls.length, 0);
    assert.strictEqual(log.error.length, 1);
    assert.ok(log.error[0].includes('empty'));
  });

  it('invalid chars: error toast, no git call', async () => {
    const log = installMessageTrackers();
    const h = makeDialog({ startPoint: 'main' });
    await h.dialog.simulateMessage({ type: 'create', name: 'my branch' });
    assert.strictEqual(h.gitService._createCalls.length, 0);
    assert.strictEqual(log.error.length, 1);
    assert.ok(log.error[0].includes('invalid'));
  });

  it('valid create with checkout + track: passes options through', async () => {
    const log = installMessageTrackers();
    const h = makeDialog({ startPoint: 'origin/main' });
    await h.dialog.simulateMessage({
      type: 'create',
      name: 'feature/new',
      track: true,
      overwrite: false,
      checkout: true,
    });
    assert.strictEqual(h.gitService._createCalls.length, 1);
    const call = h.gitService._createCalls[0];
    assert.strictEqual(call.name, 'feature/new');
    const opts = call.options as ICreateBranchOptions;
    assert.strictEqual(opts.startPoint, 'origin/main');
    assert.strictEqual(opts.track, true);
    assert.strictEqual(opts.checkout, true);
    assert.strictEqual(opts.force, false);
    assert.strictEqual(log.info.length, 1);
    assert.ok(log.info[0].includes('feature/new'));
    assert.ok(log.info[0].includes('switched')); // "Created and switched to…"
    assert.strictEqual(h.onCreatedCalls, 1);
    assert.strictEqual(h.dialog.disposed(), true);
  });

  it('overwrite flag maps to force: true', async () => {
    installMessageTrackers();
    const h = makeDialog({ startPoint: 'main' });
    await h.dialog.simulateMessage({
      type: 'create',
      name: 'feature/new',
      overwrite: true,
      checkout: false,
    });
    const opts = h.gitService._createCalls[0].options as ICreateBranchOptions;
    assert.strictEqual(opts.force, true);
  });

  it('no-checkout: info toast says "Created" not "switched"', async () => {
    const log = installMessageTrackers();
    const h = makeDialog({ startPoint: 'main' });
    await h.dialog.simulateMessage({
      type: 'create',
      name: 'feature/new',
      checkout: false,
    });
    assert.strictEqual(log.info.length, 1);
    assert.ok(!log.info[0].includes('switched'));
    assert.ok(log.info[0].includes('Created'));
  });

  it('createBranch throws: error toast shown, dialog not disposed', async () => {
    const log = installMessageTrackers();
    const gitService = makeGitService(new Error("branch 'feature/new' already exists"));
    const h = makeDialog({ startPoint: 'main', gitService });
    await h.dialog.simulateMessage({
      type: 'create',
      name: 'feature/new',
      checkout: true,
    });
    assert.strictEqual(log.error.length, 1);
    assert.ok(log.error[0].includes('already exists'));
    assert.strictEqual(h.dialog.disposed(), false, 'dialog stays open so user can retry');
  });
});

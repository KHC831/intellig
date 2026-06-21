/**
 * Final review-round fixes.
 *
 * Covers:
 * 1. MEDIUM — Senior - — squash editor close uses the tab API
 *               (not closeActiveEditor) so it doesn't kill an unrelated
 *               editor when focus has shifted.
 * 2. MEDIUM — Senior - — Save-As silent abort: detect a save to
 *               a different URI, surface a clarifying toast, treat as
 *               cancel.
 * 3. MEDIUM — Senior - — squash success path uses the shared
 *               `_unstashWithErrorReport` helper (mirrors drop multi).
 * 4. LOW — Senior - — tempfile name includes `crypto.randomBytes`
 *               so two squashes in the same millisecond can't collide.
 * 5. LOW — Senior - — fallback to showInputBox surfaces a
 *               heads-up info toast.
 * 6. LOW — Senior - — squash editor opens in `viewColumn:
 *               Beside` so it doesn't cover the log.
 * 7. LOW — Senior - — getCommit preview lookups race against
 *               a 500ms timeout so a slow git can't stall the modal.
 * 8. LOW — Senior - — plan-coverage check uses
 *               `selectedSet.size`, not `commitHashes.length`.
 *
 * Most checks are structural pins on the source; the Save-As + squash
 * unstash flows have behavioural specs because they're the easiest to
 * regress.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { CommitContextMenuCommands } from '../../../src/commits/CommitContextMenuCommands';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import type {
  IRebaseService,
  IRebaseSession,
  IRebaseAction,
  IRebaseResult,
} from '../../../src/git-core/interfaces/IRebaseService';
import type { IMenuStateNode } from '../../../src/git-core/gitToolWindow/multiSelect';
import { Uri, EventEmitter, TabInputText } from '../../mocks/vscode';
import type { GitCli } from '../../../src/git-core/gitCli';
import { writableWindow, writableWorkspace, writableCommands } from '../../typed/windowStub';

// ─── Source-level structural pins ────────────────────────────────────────────

describe('Wave C R2 — structural pins', () => {
  let src: string;

  before(async () => {
    const fs = await import('fs');
    const path = await import('path');
    src = fs.readFileSync(
      path.join(process.cwd(), 'src/commits/CommitContextMenuCommands.ts'),
      'utf8'
    );
  });

  // Tab API close
  describe('(Senior R1-M-1) — squash close uses tab API, not closeActiveEditor', () => {
    it('_promptForSquashMessage no longer calls workbench.action.closeActiveEditor', () => {
      const helperIdx = src.indexOf('private async _promptForSquashMessage');
      const helperEnd = src.indexOf('\n  }', helperIdx + 200);
      const body = src.substring(helperIdx, helperEnd > 0 ? helperEnd : helperIdx + 8000);
      assert.ok(
        !/workbench\.action\.closeActiveEditor/.test(body),
        'pre-R2 closeActiveEditor call must be replaced'
      );
    });

    it('_promptForSquashMessage uses vscode.window.tabGroups + TabInputText to close', () => {
      const helperIdx = src.indexOf('private async _promptForSquashMessage');
      const helperEnd = src.indexOf('\n  }', helperIdx + 200);
      const body = src.substring(helperIdx, helperEnd > 0 ? helperEnd : helperIdx + 8000);
      assert.ok(/vscode\.window\.tabGroups/.test(body), 'expected vscode.window.tabGroups usage');
      assert.ok(/TabInputText/.test(body), 'expected TabInputText instanceof check');
      assert.ok(/tabGroups\.close\s*\(/.test(body), 'expected tabGroups.close(...) call');
    });
  });

  // Save-As detection
  describe('(Senior R1-M-2) — Save-As detection in onDidSaveTextDocument', () => {
    it('_promptForSquashMessage compares saved.uri.fsPath against the original', () => {
      const helperIdx = src.indexOf('private async _promptForSquashMessage');
      const helperEnd = src.indexOf('\n  }', helperIdx + 200);
      const body = src.substring(helperIdx, helperEnd > 0 ? helperEnd : helperIdx + 8000);
      // The listener must compare the saved URI's fsPath
      // against the original tempfile's fsPath to detect Save-As.
      assert.ok(
        /saved\.uri\.fsPath\s*!==\s*expectedFsPath/.test(body) ||
          /saved\.uri\.fsPath\s*!==\s*document\.uri\.fsPath/.test(body),
        'expected Save-As detection via saved.uri.fsPath !== <original>'
      );
    });

    it('Save-As branch surfaces a clarifying toast and treats as cancel', () => {
      const helperIdx = src.indexOf('private async _promptForSquashMessage');
      const helperEnd = src.indexOf('\n  }', helperIdx + 200);
      const body = src.substring(helperIdx, helperEnd > 0 ? helperEnd : helperIdx + 8000);
      assert.ok(
        /Squash cancelled — message was saved to/i.test(body),
        'Save-As branch must surface the clarifying toast'
      );
    });
  });

  // Shared unstash-error helper
  describe('(Senior R1-M-3) — squash success uses _unstashWithErrorReport helper', () => {
    it('a private _unstashWithErrorReport(cwd, opName) helper is declared once', () => {
      const matches = src.match(/private\s+async\s+_unstashWithErrorReport\s*\(/g) || [];
      assert.strictEqual(
        matches.length,
        1,
        `expected exactly 1 _unstashWithErrorReport declaration; got ${matches.length}`
      );
    });

    it('squash success path calls _unstashWithErrorReport(cwd, "Squash")', () => {
      const handlerIdx = src.indexOf('private async _handleSquashCommits');
      const editIdx = src.indexOf('private async _handleEditCommitMessage', handlerIdx);
      const body = src.substring(handlerIdx, editIdx > 0 ? editIdx : handlerIdx + 12000);
      // _handleSquashCommits now also handles the fixup mode (via
      // squashWithPrevious + fixupWithPrevious). The opName argument is now
      // `mode === 'fixup' ? 'Fixup' : 'Squash'` rather than the literal
      // 'Squash'. Either form satisfies the contract that the squash branch
      // surfaces an unstash failure tagged "Squash".
      assert.ok(
        /this\._unstashWithErrorReport\s*\(\s*cwd\s*,\s*['"]Squash['"]\s*\)/.test(body) ||
          /this\._unstashWithErrorReport\s*\(\s*cwd\s*,\s*mode\s*===\s*['"]fixup['"]\s*\?\s*['"]Fixup['"]\s*:\s*['"]Squash['"]\s*\)/.test(
            body
          ),
        '_handleSquashCommits success path must call _unstashWithErrorReport(cwd, "Squash") (or the Wave K mode-aware ternary form)'
      );
    });

    it('drop multi success path calls _unstashWithErrorReport(cwd, "Drop")', () => {
      const handlerIdx = src.indexOf('private async _handleDropCommitMulti');
      const squashIdx = src.indexOf('private async _handleSquashCommits', handlerIdx);
      const body = src.substring(handlerIdx, squashIdx > 0 ? squashIdx : handlerIdx + 12000);
      assert.ok(
        /this\._unstashWithErrorReport\s*\(\s*cwd\s*,\s*['"]Drop['"]\s*\)/.test(body),
        '_handleDropCommitMulti success path must call _unstashWithErrorReport(cwd, "Drop")'
      );
    });
  });

  // Random suffix in tempfile path
  describe('(Senior R1-L-1) — tempfile path includes a random suffix', () => {
    it('tempfile path uses crypto.randomBytes for a per-invocation suffix', () => {
      assert.ok(
        /crypto\.randomBytes\s*\(/.test(src),
        'expected crypto.randomBytes(...) for tempfile name uniqueness'
      );
    });

    it('tempfile name template includes the random suffix between Date.now() and COMMIT_EDITMSG', () => {
      const helperIdx = src.indexOf('private async _promptForSquashMessage');
      const helperEnd = src.indexOf('\n  }', helperIdx + 200);
      const body = src.substring(helperIdx, helperEnd > 0 ? helperEnd : helperIdx + 8000);
      // Template literal uses both Date.now() and a random hex suffix
      // before the COMMIT_EDITMSG marker.
      assert.ok(
        /\$\{[^}]*Date\.now[^}]*\}-\$\{[^}]*\}-COMMIT_EDITMSG/.test(body),
        'tempfile name must place the random suffix between Date.now() and COMMIT_EDITMSG'
      );
    });
  });

  // Fallback heads-up toast
  describe('(Senior R1-L-2) — fallback to showInputBox surfaces a toast', () => {
    it('the helper surfaces an info toast before falling back to showInputBox', () => {
      const helperIdx = src.indexOf('private async _promptForSquashMessage');
      const helperEnd = src.indexOf('\n  }', helperIdx + 200);
      const body = src.substring(helperIdx, helperEnd > 0 ? helperEnd : helperIdx + 8000);
      assert.ok(
        /Multi-line squash editor unavailable; using single-line fallback/.test(body),
        'fallback branch must surface a heads-up info toast'
      );
    });
  });

  // viewColumn: Beside
  describe('(Senior R1-L-3) — squash editor opens beside the active column', () => {
    it('showTextDocument is called with viewColumn: vscode.ViewColumn.Beside', () => {
      const helperIdx = src.indexOf('private async _promptForSquashMessage');
      const helperEnd = src.indexOf('\n  }', helperIdx + 200);
      const body = src.substring(helperIdx, helperEnd > 0 ? helperEnd : helperIdx + 8000);
      assert.ok(
        /viewColumn:\s*vscode\.ViewColumn\.Beside/.test(body),
        'expected showTextDocument({ ..., viewColumn: vscode.ViewColumn.Beside })'
      );
    });
  });

  // getCommit timeout
  describe('(Senior R1-L-4) — modal preview wraps getCommit in a 500ms timeout', () => {
    it('_handleDropCommitMulti races getCommit against a 500ms setTimeout', () => {
      const handlerIdx = src.indexOf('private async _handleDropCommitMulti');
      const squashIdx = src.indexOf('private async _handleSquashCommits', handlerIdx);
      const body = src.substring(handlerIdx, squashIdx > 0 ? squashIdx : handlerIdx + 12000);
      assert.ok(
        /Promise\.race\s*\(/.test(body),
        'expected Promise.race(...) to bound getCommit on the modal preview'
      );
      assert.ok(
        /setTimeout[^,]*,\s*previewTimeoutMs/.test(body) ||
          /setTimeout[^,]*,\s*500\s*\)/.test(body),
        'expected a 500ms setTimeout in the race'
      );
    });
  });

  // plan-coverage compares against selectedSet.size
  describe('(Senior R1-L-5) — plan-coverage check uses selectedSet.size', () => {
    it('the partial-coverage guard compares against selectedSet.size, not commitHashes.length', () => {
      const handlerIdx = src.indexOf('private async _handleDropCommitMulti');
      const squashIdx = src.indexOf('private async _handleSquashCommits', handlerIdx);
      const body = src.substring(handlerIdx, squashIdx > 0 ? squashIdx : handlerIdx + 12000);
      assert.ok(
        /planDropCount\s*<\s*selectedSet\.size/.test(body),
        'partial-coverage guard must compare against selectedSet.size'
      );
      assert.ok(
        !/planDropCount\s*<\s*commitHashes\.length/.test(body),
        'pre-R2 commitHashes.length comparison must be replaced'
      );
    });
  });
});

// ─── Behavioural specs ──────────────────────────────────────────────────────
//
// Two flows have non-trivial behaviour worth pinning:
// - Save-As: simulate a save to a DIFFERENT URI; assert the
//     handler surfaces the clarifying toast and aborts (no rebase
//     started).
// - squash unstash error: drive a successful squash whose
//     post-success stash pop fails; assert "Squash succeeded but failed
//     to restore stash" warning toast.

interface CallTracker {
  method: string;
  args: unknown[];
}

function createMockRepo(rootPath = '/test-repo'): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: { HEAD: { name: 'main', commit: 'abc1234567890', type: 0 as const } },
    inputBox: { value: '' },
    remotes: [],
  } as unknown as IRepository;
}

function createMockGitService(repo: IRepository): IGitService & { calls: CallTracker[] } {
  const calls: CallTracker[] = [];
  return {
    calls,
    getRepositories: () => [repo],
    getActiveRepository: () => repo,
    getCommits: async () => [],
    getCommit: async (_repo: IRepository, hash: string) => ({
      hash,
      shortHash: hash.substring(0, 7),
      message: `subject for ${hash.substring(0, 8)}`,
      author: { name: 'a', email: 'a@x' },
      committer: { name: 'a', email: 'a@x' },
      parents: [],
      authorDate: new Date(0),
      commitDate: new Date(0),
    }),
    getCommitDiff: async () => [],
    getMultiCommitDiff: async () => [],
    cherryPick: async () => ({ success: true }),
    cherryPickAbort: async () => {},
    cherryPickContinue: async () => ({ success: true }),
    revert: async () => ({ success: true }),
    revertAbort: async () => {},
    revertContinue: async () => ({ success: true }),
    getStatus: async () => [],
    dispose: () => {},
  } as unknown as IGitService & { calls: CallTracker[] };
}

interface MockRebaseTracker {
  startedOnto: string | undefined;
  lastPlan: IRebaseAction[] | undefined;
  executeCalls: number;
  abortCalls: number;
  provideSquashMessageCalls: { message: string }[];
  sessionCommits: { hash: string; message: string; action: 'pick' }[];
  executeResult: IRebaseResult;
  provideSquashResult: IRebaseResult;
}

function createMockRebaseService(
  tracker: MockRebaseTracker
): IRebaseService & { tracker: MockRebaseTracker } {
  const sessionChangeEmitter = new EventEmitter<undefined>();
  return {
    tracker,
    startInteractiveRebase: async (_repo: IRepository, onto: string) => {
      tracker.startedOnto = onto;
      const session: IRebaseSession = {
        onto,
        originalBranch: 'main',
        commits: tracker.sessionCommits.map((c) => ({ ...c })),
        currentStep: 0,
        status: 'planning',
      };
      return session;
    },
    getRebaseSession: () => undefined,
    updateRebasePlan: (_repo: IRepository, plan: IRebaseAction[]) => {
      tracker.lastPlan = plan.map((a) => ({ ...a }));
    },
    executeRebase: async () => {
      tracker.executeCalls++;
      return tracker.executeResult;
    },
    continueRebase: async () => ({ success: true, status: 'completed' as const }),
    abortRebase: async () => {
      tracker.abortCalls++;
    },
    skipCommit: async () => ({ success: true, status: 'completed' as const }),
    provideRewordMessage: async () => ({ success: true, status: 'completed' as const }),
    provideSquashMessage: async (_repo: IRepository, message: string) => {
      tracker.provideSquashMessageCalls.push({ message });
      return tracker.provideSquashResult;
    },
    amendEditCommit: async () => ({ success: true, status: 'completed' as const }),
    onDidChangeRebaseSession: sessionChangeEmitter.event,
    dispose: () => {},
  } as unknown as IRebaseService & { tracker: MockRebaseTracker };
}

function createMockProvider(): GitToolWindowProvider & { refreshCallCount: number } {
  return {
    onDidRequestLogContextAction: () => ({ dispose: () => {} }),
    refreshCallCount: 0,
    refresh: function (this: { refreshCallCount: number }) {
      this.refreshCallCount++;
    },
  } as unknown as GitToolWindowProvider & { refreshCallCount: number };
}

type MockGitCli = GitCli & { calls: CallTracker[] };

function createMockGitCli(opts?: {
  exec?: (...args: unknown[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    combined: string;
  }>;
}): MockGitCli {
  const calls: CallTracker[] = [];
  const exec = async (...args: unknown[]) => {
    calls.push({ method: 'exec', args });
    if (opts?.exec) {
      return opts.exec(...args);
    }
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  };
  return {
    calls,
    exec,
    execString: async () => '',
    isAvailable: async () => true,
    getVersion: async () => '2.40.0',
    isRepository: async () => true,
    getRepositoryRoot: async () => '/test-repo',
    dispose: () => {},
    get gitPath() {
      return 'git';
    },
    set gitPath(_v: string) {},
    onCommandExecuted: (() => ({
      dispose: () => {},
    })) as unknown as MockGitCli['onCommandExecuted'],
  } as unknown as MockGitCli;
}

interface MessageTracker {
  info: { message: string; items: string[] }[];
  error: { message: string; items: string[] }[];
  warning: { message: string; items: string[] }[];
}

function captureMessages(): MessageTracker {
  const tracker: MessageTracker = { info: [], error: [], warning: [] };
  const w = writableWindow();
  w.showInformationMessage = (message: string, ...items: string[]) => {
    tracker.info.push({ message, items });
    return Promise.resolve(undefined);
  };
  w.showErrorMessage = (message: string, ...items: string[]) => {
    tracker.error.push({ message, items });
    return Promise.resolve(undefined);
  };
  w.showWarningMessage = (message: string, ...items: unknown[]) => {
    const stringItems = items.filter((i): i is string => typeof i === 'string');
    tracker.warning.push({ message, items: stringItems });
    return Promise.resolve(undefined);
  };
  return tracker;
}

function restoreMocks(): void {
  const w = writableWindow();
  w.showInformationMessage = () => Promise.resolve(undefined);
  w.showErrorMessage = () => Promise.resolve(undefined);
  w.showWarningMessage = () => Promise.resolve(undefined);
  w.showInputBox = (opts?: import('vscode').InputBoxOptions) => Promise.resolve(opts?.value);
  w.showSaveDialog = () => Promise.resolve(undefined);
  w.showOpenDialog = () => Promise.resolve(undefined);
}

interface CommandsInternal {
  _gitCli: GitCli;
  _handleAction(
    action: string,
    hashes: string[],
    commitNodes?: readonly IMenuStateNode[]
  ): Promise<void>;
}

function makeCommands(opts: {
  repo: IRepository;
  gitService: IGitService;
  gitCli: GitCli;
  provider: GitToolWindowProvider;
  rebaseService: IRebaseService;
}): CommitContextMenuCommands {
  return new CommitContextMenuCommands(
    opts.gitService,
    opts.rebaseService,
    opts.provider,
    opts.gitCli
  );
}

function blankRebaseTracker(): MockRebaseTracker {
  return {
    startedOnto: undefined,
    lastPlan: undefined,
    executeCalls: 0,
    abortCalls: 0,
    provideSquashMessageCalls: [],
    sessionCommits: [],
    executeResult: { success: true, status: 'completed' },
    provideSquashResult: { success: true, status: 'completed' },
  };
}

/**
 * Install editor stubs that capture the save / close listeners so tests
 * can drive the squash dialog. `simulateSaveAs` fires onDidSave with a
 * DIFFERENT URI to drive the - Save-As branch.
 */
interface EditorTracker {
  openCalls: number;
  showCalls: number;
  simulateSave: (text: string) => void;
  simulateSaveAs: (text: string, otherFsPath: string) => void;
  simulateClose: () => void;
  closedTabs: unknown[];
}

function installEditorStubs(): EditorTracker {
  const tracker: EditorTracker = {
    openCalls: 0,
    showCalls: 0,
    simulateSave: () => {
      throw new Error('save listener not installed yet');
    },
    simulateSaveAs: () => {
      throw new Error('saveAs listener not installed yet');
    },
    simulateClose: () => {
      throw new Error('close listener not installed yet');
    },
    closedTabs: [],
  };

  let docUri: vscode.Uri | undefined;
  const ws = writableWorkspace();
  const w = writableWindow();
  const c = writableCommands();

  ws.openTextDocument = (options: unknown) => {
    tracker.openCalls++;
    if (
      options !== null &&
      typeof options === 'object' &&
      'fsPath' in (options as Record<string, unknown>)
    ) {
      docUri = options as vscode.Uri;
    } else if (typeof options === 'string') {
      docUri = Uri.file(options);
    } else {
      docUri = Uri.parse(`untitled:wave-c-r2-test-${Date.now()}`);
    }
    return Promise.resolve({
      uri: docUri,
      getText: () => '',
      languageId: 'plaintext',
      isUntitled: false,
    });
  };

  w.showTextDocument = (document: unknown) => {
    tracker.showCalls++;
    return Promise.resolve({ document });
  };

  let saveListener: ((doc: { uri: vscode.Uri; getText: () => string }) => void) | undefined;
  let closeListener: ((doc: { uri: vscode.Uri }) => void) | undefined;

  ws.onDidSaveTextDocument = (listener) => {
    saveListener = listener;
    return { dispose: () => (saveListener = undefined) };
  };
  ws.onDidCloseTextDocument = (listener) => {
    closeListener = listener;
    return { dispose: () => (closeListener = undefined) };
  };

  c.executeCommand = () => Promise.resolve(undefined);

  // Install a tab that matches the squash document so the close-via-tab
  // path finds it. Tests can verify `tracker.closedTabs` to assert
  // the right tab was closed.
  // The mock vscode.window.tabGroups.all is a typed array on the
  // namespace; we narrow + assign.
  // Each call to tabGroups.close pushes the closed tab into the tracker.
  const tabsContainer = vscode.window.tabGroups as unknown as {
    all: { tabs: { input: unknown; label: string }[] }[];
    close: (tab: unknown) => Promise<boolean>;
  };
  tabsContainer.all = [
    {
      tabs: [
        {
          // The squash tab's input is a TabInputText with the document's URI.
          // We populate this lazily once openTextDocument has set docUri.
          get input(): unknown {
            return docUri ? new TabInputText(docUri) : undefined;
          },
          label: 'squash-edit',
        },
      ],
    },
  ];
  tabsContainer.close = async (tab: unknown): Promise<boolean> => {
    tracker.closedTabs.push(tab);
    return true;
  };

  tracker.simulateSave = (text: string): void => {
    if (!saveListener || !docUri) {
      throw new Error('save listener / doc uri not initialised');
    }
    saveListener({ uri: docUri, getText: () => text });
  };
  tracker.simulateSaveAs = (text: string, otherFsPath: string): void => {
    if (!saveListener) {
      throw new Error('saveAs listener not initialised');
    }
    // Fire the save event with a DIFFERENT URI — the Save-As semantics.
    saveListener({ uri: Uri.file(otherFsPath), getText: () => text });
  };
  tracker.simulateClose = (): void => {
    if (!closeListener || !docUri) {
      throw new Error('close listener / doc uri not initialised');
    }
    closeListener({ uri: docUri });
  };

  return tracker;
}

describe('Wave C R2 — behavioural specs', () => {
  const repo = createMockRepo();
  const HASH_NEWEST = '1111111111111111111111111111111111111111';
  const HASH_MID = '2222222222222222222222222222222222222222';
  const NODES: readonly IMenuStateNode[] = [
    { hash: HASH_NEWEST, parentCount: 1 },
    { hash: HASH_MID, parentCount: 1 },
  ];

  afterEach(() => restoreMocks());

  async function runWithEditor(
    action: () => Promise<void>,
    simulate: (e: EditorTracker) => void
  ): Promise<EditorTracker> {
    const editor = installEditorStubs();
    const handlerPromise = action();
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    simulate(editor);
    await handlerPromise;
    return editor;
  }

  // Save-As silent abort fix
  describe('(Senior R1-M-2) — Save-As silent abort', () => {
    it('treats Save-As as cancel and surfaces a clarifying toast', async () => {
      const tracker = blankRebaseTracker();
      tracker.sessionCommits = [
        { hash: HASH_MID, message: 'mid', action: 'pick' },
        { hash: HASH_NEWEST, message: 'new', action: 'pick' },
      ];
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      const messages = captureMessages();

      await runWithEditor(
        () =>
          (cmds as unknown as CommandsInternal)._handleAction(
            'squashCommits',
            [HASH_NEWEST, HASH_MID],
            NODES
          ),
        (e) => e.simulateSaveAs('user-typed message', '/some/other/path/MY_NOTES.md')
      );

      assert.strictEqual(
        tracker.executeCalls,
        0,
        'no rebase must run on Save-As (treated as cancel)'
      );
      assert.strictEqual(
        tracker.startedOnto,
        undefined,
        'rebase must not start when user hits Save-As'
      );
      const allWarnings = messages.warning.map((m) => m.message).join(' || ');
      assert.ok(
        /Squash cancelled/i.test(allWarnings) && /saved to/i.test(allWarnings),
        `expected Save-As cancellation warning; got: ${allWarnings}`
      );
    });
  });

  // Squash success unstash error surfaces distinct toast
  describe('(Senior R1-M-3) — squash success path reports unstash failures', () => {
    it('surfaces "Squash succeeded but failed to restore stash" when stash pop fails', async () => {
      const tracker = blankRebaseTracker();
      tracker.sessionCommits = [
        { hash: HASH_MID, message: 'mid', action: 'pick' },
        { hash: HASH_NEWEST, message: 'new', action: 'pick' },
      ];
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();

      // Drive `_stashIfDirty` to actually stash (status --porcelain
      // returns a non-empty line) and then make `stash pop` fail with
      // a non-zero exit code.
      const gitCli = createMockGitCli({
        exec: (...args: unknown[]) => {
          const argv = args[0] as string[];
          if (argv[0] === 'status' && argv.includes('--porcelain')) {
            return Promise.resolve({
              exitCode: 0,
              stdout: ' M src/file.ts\n',
              stderr: '',
              combined: '',
            });
          }
          if (argv[0] === 'stash' && argv[1] === 'push') {
            return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
          }
          if (argv[0] === 'stash' && argv[1] === 'pop') {
            return Promise.resolve({
              exitCode: 1,
              stdout: '',
              stderr: 'CONFLICT (content): merge conflict in src/file.ts',
              combined: '',
            });
          }
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
        },
      });
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      const messages = captureMessages();

      await runWithEditor(
        () =>
          (cmds as unknown as CommandsInternal)._handleAction(
            'squashCommits',
            [HASH_NEWEST, HASH_MID],
            NODES
          ),
        (e) => e.simulateSave('combined message')
      );

      const allWarnings = messages.warning.map((m) => m.message).join(' || ');
      assert.ok(
        /Squash succeeded but failed to restore stash/i.test(allWarnings),
        `expected the distinct unstash-error warning; got: ${allWarnings}`
      );
    });
  });

  // tab-API close (behavioural spec to complement the
  // structural pin)
  describe('(Senior R1-M-1) — squash close targets the squash tab via tabGroups.close', () => {
    it('calls tabGroups.close with the squash tab after the user saves', async () => {
      const tracker = blankRebaseTracker();
      tracker.sessionCommits = [
        { hash: HASH_MID, message: 'mid', action: 'pick' },
        { hash: HASH_NEWEST, message: 'new', action: 'pick' },
      ];
      const rebaseService = createMockRebaseService(tracker);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider, rebaseService });
      captureMessages();

      const editor = await runWithEditor(
        () =>
          (cmds as unknown as CommandsInternal)._handleAction(
            'squashCommits',
            [HASH_NEWEST, HASH_MID],
            NODES
          ),
        (e) => e.simulateSave('combined')
      );

      assert.ok(
        editor.closedTabs.length >= 1,
        'expected at least one tab to be closed via tabGroups.close after save'
      );
      // The closed tab's input should be the TabInputText we registered
      // in the editor stub.
      const closed = editor.closedTabs[0] as { input?: unknown };
      assert.ok(
        closed.input instanceof TabInputText,
        'closed tab input must be the TabInputText pointing at the squash document'
      );
    });
  });
});

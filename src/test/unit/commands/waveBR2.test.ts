/**
 * Final review-round fixes for the multi-commit context-menu commands.
 *
 * Covers:
 *   1. HASH_RE cap raised to 64 (SHA-256 support).
 *   2. `_handleCompareVersions` gets the missing `inOrder.has()`
 *      symmetry check (mirrors createPatchMulti).
 *   3. dispatch-property fuzzer covers `compareVersions`. Lives in the
 *      property test, not here.
 *   4. Collapse `displayOrder` + `parentCounts` parallel records to a
 *      single `commitNodes: IMenuStateNode[]` on the dispatch event
 *      payload.
 *   5. `getSelectedCommits()` returns `readonly string[]`.
 *   6. Comment on the swap-fallback site updated.
 *   7. `_handleCreatePatchMulti` JSDoc cross-reference.
 *   8. Diagnostic comment on the initial-commit test.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { CommitContextMenuCommands } from '../../../commits/CommitContextMenuCommands';
import { GitToolWindowProvider } from '../../../ui-shell/GitToolWindowProvider';
import type { IGitService, IRepository } from '../../../git-core/interfaces/IGitService';
import type { IRebaseService } from '../../../git-core/interfaces/IRebaseService';
import type { IMenuStateNode } from '../../../git-core/gitToolWindow/multiSelect';
import { Uri, EventEmitter } from '../../mocks/vscode';
import type { GitCli } from '../../../git-core/gitCli';
import { writableEnv, writableWindow, writableCommands } from '../../typed/windowStub';

// ─── Test scaffolding ────────────────────────────────────────────────────────

interface CallTracker {
  method: string;
  args: unknown[];
}

function createMockRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: { HEAD: { name: 'main', commit: 'abc1234567890', type: 0 as const } },
    inputBox: { value: '' },
    remotes: [],
  } as unknown as IRepository;
}

function createMockGitService(
  repo: IRepository,
  overrides?: Partial<IGitService>
): IGitService & { calls: CallTracker[] } {
  const calls: CallTracker[] = [];
  return {
    calls,
    getRepositories: () => [repo],
    getActiveRepository: () => repo,
    getCommits: async () => [],
    getCommitDiff: async () => [],
    getMultiCommitDiff: async () => [],
    cherryPick: async (...args: unknown[]) => {
      calls.push({ method: 'cherryPick', args });
      return { success: true };
    },
    revert: async (...args: unknown[]) => {
      calls.push({ method: 'revert', args });
      return { success: true };
    },
    cherryPickAbort: async () => {},
    cherryPickContinue: async () => ({ success: true }),
    revertAbort: async () => {},
    revertContinue: async () => ({ success: true }),
    getStatus: async () => [],
    dispose: () => {},
    ...overrides,
  } as unknown as IGitService & { calls: CallTracker[] };
}

function createMockRebaseService(): IRebaseService {
  const sessionChangeEmitter = new EventEmitter<undefined>();
  return {
    startInteractiveRebase: async () => ({
      onto: '',
      originalBranch: '',
      commits: [],
      currentStep: 0,
      status: 'planning' as const,
    }),
    getRebaseSession: () => undefined,
    updateRebasePlan: () => {},
    executeRebase: async () => ({ success: true, status: 'completed' as const }),
    continueRebase: async () => ({ success: true, status: 'completed' as const }),
    abortRebase: async () => {},
    skipCommit: async () => ({ success: true, status: 'completed' as const }),
    provideRewordMessage: async () => ({ success: true, status: 'completed' as const }),
    provideSquashMessage: async () => ({ success: true, status: 'completed' as const }),
    amendEditCommit: async () => ({ success: true, status: 'completed' as const }),
    onDidChangeRebaseSession: sessionChangeEmitter.event,
    dispose: () => {},
  } as unknown as IRebaseService;
}

function createMockProvider(): GitToolWindowProvider {
  return {
    onDidRequestLogContextAction: () => ({ dispose: () => {} }),
    refresh: () => {},
  } as unknown as GitToolWindowProvider;
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
}

function captureMessages(): MessageTracker {
  const tracker: MessageTracker = { info: [], error: [] };
  const w = writableWindow();
  w.showInformationMessage = (message: string, ...items: string[]) => {
    tracker.info.push({ message, items });
    return Promise.resolve(undefined);
  };
  w.showErrorMessage = (message: string, ...items: string[]) => {
    tracker.error.push({ message, items });
    return Promise.resolve(undefined);
  };
  return tracker;
}

function restoreMocks(): void {
  const w = writableWindow();
  w.showInformationMessage = () => Promise.resolve(undefined);
  w.showErrorMessage = () => Promise.resolve(undefined);
  w.showSaveDialog = () => Promise.resolve(undefined);
  w.showOpenDialog = () => Promise.resolve(undefined);
}

interface CommandsInternal {
  _gitCli: GitCli;
  /**
   * displayOrder + parentCounts collapse to a single
   * `commitNodes: readonly IMenuStateNode[]` positional. Default `[]`
   * lets external callers (palette commands) call without supplying it
   * — the multi-commit branches all hit the stale-selection guard
   * when `commitNodes` is empty.
   */
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
}): CommitContextMenuCommands {
  return new CommitContextMenuCommands(
    opts.gitService,
    createMockRebaseService(),
    opts.provider,
    opts.gitCli
  );
}

describe('Wave B R2 — final review fixes', () => {
  const repo = createMockRepo();
  const HASH_OLDEST = 'aaaa111111111111111111111111111111111111';
  const HASH_MIDDLE = 'bbbb222222222222222222222222222222222222';
  const HASH_NEWEST = 'cccc333333333333333333333333333333333333';
  // 64-char hex — valid SHA-256.
  const HASH_SHA256 = 'a'.repeat(40) + 'b'.repeat(24);

  afterEach(() => restoreMocks());

  // ─── SHA-256 regex cap ────────────────────────────────────────────────────
  describe('HASH_RE accepts 64-char SHA-256 hashes', () => {
    it('createPatch with a 64-char hex hash invokes git (no silent rejection)', async () => {
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli();
      const cmds = makeCommands({ repo, gitService, gitCli, provider });
      captureMessages();
      const w = writableWindow();
      w.showSaveDialog = () => Promise.resolve(Uri.file('/tmp/single.patch'));

      await (cmds as unknown as CommandsInternal)._handleAction('createPatch', [HASH_SHA256]);

      const formatPatchCall = gitCli.calls.find(
        (c) =>
          c.method === 'exec' &&
          Array.isArray(c.args[0]) &&
          (c.args[0] as string[])[0] === 'format-patch'
      );
      assert.ok(
        formatPatchCall,
        'expected git format-patch invocation for a 64-char (SHA-256) hash'
      );
    });

    it('compareVersions with two 64-char hex hashes runs the diff', async () => {
      const HASH_SHA256_B = 'c'.repeat(40) + 'd'.repeat(24);
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const argv = args[0] as string[];
          if (argv[0] === 'diff') {
            return { exitCode: 0, stdout: 'src/foo.ts\n', stderr: '', combined: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const cmds = makeCommands({ repo, gitService, gitCli, provider });
      captureMessages();
      const realExec = writableCommands().executeCommand;
      writableCommands().executeCommand = () => Promise.resolve(undefined);
      try {
        await (cmds as unknown as CommandsInternal)._handleAction(
          'compareVersions',
          [HASH_SHA256, HASH_SHA256_B],
          [
            { hash: HASH_SHA256, parentCount: 1 },
            { hash: HASH_SHA256_B, parentCount: 1 },
          ]
        );
      } finally {
        writableCommands().executeCommand = realExec;
      }

      const diffCall = gitCli.calls.find(
        (c) =>
          c.method === 'exec' && Array.isArray(c.args[0]) && (c.args[0] as string[])[0] === 'diff'
      );
      assert.ok(diffCall, 'expected git diff invocation for a SHA-256 commit pair');
    });
  });

  // ─── compareVersions inOrder symmetry check ──────────────────────────────
  describe('compareVersions aborts on stale hash with the TL-M-4 toast', () => {
    it('toasts the stale-selection phrasing and skips git diff when a hash is not in commitNodes', async () => {
      const gitService = createMockGitService(repo);
      const provider = createMockProvider();
      const gitCli = createMockGitCli({
        exec: async (...args: unknown[]) => {
          const argv = args[0] as string[];
          if (argv[0] === 'diff') {
            // If the test reaches here, the in-order guard FAILED to
            // catch the stale hash. Force a noisy fail.
            throw new Error('git diff invoked despite stale hash — in-order guard missing');
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      });
      const cmds = makeCommands({ repo, gitService, gitCli, provider });
      const messages = captureMessages();
      const realExec = writableCommands().executeCommand;
      writableCommands().executeCommand = () => Promise.resolve(undefined);
      try {
        // displayOrder includes only [NEWEST, OLDEST]; commitHashes
        // includes a hex-but-not-listed hash. Without the symmetry
        // check the regex passes and the handler reaches the diff call
        // (or, since the swap-fallback was deleted, it'd just produce a
        // bad ref error from git).
        const HASH_GHOST = 'eeee555555555555555555555555555555555555';
        await (cmds as unknown as CommandsInternal)._handleAction(
          'compareVersions',
          [HASH_NEWEST, HASH_GHOST],
          [
            { hash: HASH_NEWEST, parentCount: 1 },
            { hash: HASH_OLDEST, parentCount: 1 },
          ]
        );
      } finally {
        writableCommands().executeCommand = realExec;
      }

      // No git invocation.
      const diffCall = gitCli.calls.find(
        (c) =>
          c.method === 'exec' && Array.isArray(c.args[0]) && (c.args[0] as string[])[0] === 'diff'
      );
      assert.strictEqual(diffCall, undefined, 'no git diff when stale hash detected');

      const allToasts = [...messages.info, ...messages.error].map((m) => m.message).join(' || ');
      assert.ok(
        /selection changed/i.test(allToasts),
        `expected stale-selection toast; got: ${allToasts}`
      );
    });
  });

  // ─── IMenuStateNode payload collapse ─────────────────────────────────────
  describe('dispatch payload uses commitNodes (no parallel records)', () => {
    it('GitToolWindowProvider event emitter declares commitNodes (not displayOrder + parentCounts)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/GitToolWindowProvider.ts'),
        'utf8'
      );
      // The new shape lists `commitNodes:` in the EventEmitter generic.
      assert.ok(
        /_onDidRequestLogContextAction\s*=\s*new\s+vscode\.EventEmitter<\{[\s\S]{0,3000}commitNodes/.test(
          src
        ),
        'event payload type must include commitNodes (post-collapse)'
      );
      // The earlier parallel records are gone from the event type.
      // (Either name appearing as a property name on the union type
      // would indicate the refactor didn't land.)
      const evMatch = src.match(
        /_onDidRequestLogContextAction\s*=\s*new\s+vscode\.EventEmitter<(\{[\s\S]*?\})>\(/
      );
      assert.ok(evMatch, 'expected event emitter declaration');
      const body = evMatch[1];
      // Strip block + line comments inside the type body so JSDoc that
      // mentions the legacy `displayOrder` / `parentCounts` field names
      // for context doesn't trigger the negative match.
      const codeOnly = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(
        !/\bdisplayOrder\s*:/.test(codeOnly),
        'parallel `displayOrder` field on the event must be removed'
      );
      assert.ok(
        !/\bparentCounts\s*:/.test(codeOnly),
        'parallel `parentCounts` field on the event must be removed'
      );
    });

    it('CommitContextMenuCommands._handleAction takes commitNodes (single optional positional)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/commits/CommitContextMenuCommands.ts'),
        'utf8'
      );
      assert.ok(
        /_handleAction\s*\(\s*action:\s*LogContextAction,\s*commitHashes:\s*string\[\],\s*commitNodes/.test(
          src
        ),
        '_handleAction signature must list commitNodes (single arg, not displayOrder + parentCounts)'
      );
    });

    it('event-emitter import lives off multiSelect.IMenuStateNode (no parallel type)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/GitToolWindowProvider.ts'),
        'utf8'
      );
      assert.ok(
        /\bIMenuStateNode\b/.test(src),
        'GitToolWindowProvider must reference IMenuStateNode type from multiSelect.ts'
      );
    });
  });

  // ─── getSelectedCommits readonly return type ─────────────────────────────
  describe('getSelectedCommits returns readonly string[]', () => {
    it('declared return type matches the sibling helper', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/GitToolWindowProvider.ts'),
        'utf8'
      );
      // public getSelectedCommits(): readonly string[]
      assert.ok(
        /public\s+getSelectedCommits\s*\(\s*\)\s*:\s*readonly\s+string\[\]/.test(src),
        'getSelectedCommits must return readonly string[] to match getSelectedCommitsOldestFirst'
      );
    });
  });

  // ─── swap-fallback comment updated ───────────────────────────────────────
  describe('swap-fallback comment notes external-caller behaviour', () => {
    it('comment in CommitContextMenuCommands.ts mentions external callers + commitNodes', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/commits/CommitContextMenuCommands.ts'),
        'utf8'
      );
      // We assert the comment includes both "external caller" and the
      // word "commitNodes" so the contract for non-webview callers is
      // documented inline.
      assert.ok(
        /external\s+caller[\s\S]{0,400}commitNodes|commitNodes[\s\S]{0,400}external\s+caller/i.test(
          src
        ),
        'swap-fallback comment must address external-caller behaviour with empty commitNodes'
      );
    });
  });

  // ─── JSDoc cross-reference ────────────────────────────────────────────────
  describe('_handleCreatePatchMulti JSDoc cross-references ADR-009 section 6', () => {
    it('JSDoc near the multi handler mentions ADR-009 section 6 and getSelectedCommitsOldestFirst', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/commits/CommitContextMenuCommands.ts'),
        'utf8'
      );
      const idx = src.indexOf('private async _handleCreatePatchMulti');
      assert.ok(idx > 0, 'expected _handleCreatePatchMulti declaration');
      // Look 1500 chars before declaration for the JSDoc.
      const window = src.substring(Math.max(0, idx - 1500), idx);
      assert.ok(/ADR-009.*?section\s*6/.test(window), 'JSDoc must reference ADR-009 section 6');
      assert.ok(
        /getSelectedCommitsOldestFirst/.test(window),
        'JSDoc must mention the programmatic-caller equivalent'
      );
    });
  });

  // ─── diagnostic comment on the initial-commit test ──────────────────────
  describe('initial-commit test points at inversion guard', () => {
    it('waveBR1.test.ts block references as the dedicated inversion regression guard', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/test/unit/commands/waveBR1.test.ts'),
        'utf8'
      );
      const idx = src.indexOf('R1-2 (Senior H-2)');
      assert.ok(idx > 0);
      // The diagnostic note that points at the dedicated guard sits just
      // before the initial-commit describe block; widen the window
      // backward to include it, then assert it names the end-to-end
      // smoke guard.
      const window = src.substring(Math.max(0, idx - 800), idx + 2000);
      assert.ok(
        /end-to-end smoke/.test(window),
        'the initial-commit inversion test block must point at the dedicated end-to-end smoke inversion regression guard'
      );
    });
  });

  // Avoid unused-import warning.
  void writableEnv;
  void vscode;
  void HASH_MIDDLE;
});

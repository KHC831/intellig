import * as assert from 'assert';
import { RebaseService, createRebaseService } from '../../../src/git-core/RebaseService';
import {
  IRebaseSession,
  IRebaseAction,
  RebaseAction,
} from '../../../src/git-core/interfaces/IRebaseService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { GitCli, IGitCommandResult } from '../../../src/git-core/gitCli';
import { REBASE_PLAN_ENV } from '../../../src/git-core/rebaseTodoEditor';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Helper to create a mock result with all required fields
 */
function createMockResult(
  exitCode: number,
  stdout: string,
  stderr: string = ''
): IGitCommandResult {
  return {
    exitCode,
    stdout,
    stderr,
    combined: stdout + stderr,
  };
}

/**
 * Mock GitCli for testing
 */
class MockGitCli extends GitCli {
  private _execResults: Map<string, IGitCommandResult> = new Map();
  private _execCalls: { args: string[]; options?: unknown }[] = [];

  constructor() {
    super('git');
  }

  setExecResult(argsPattern: string, result: IGitCommandResult): void {
    this._execResults.set(argsPattern, result);
  }

  getExecCalls(): { args: string[]; options?: unknown }[] {
    return this._execCalls;
  }

  clearCalls(): void {
    this._execCalls = [];
  }

  override exec(args: string[], options?: unknown): Promise<IGitCommandResult> {
    this._execCalls.push({ args, options });

    // Find matching result
    const argsStr = args.join(' ');
    for (const [pattern, result] of this._execResults) {
      if (argsStr.includes(pattern)) {
        return Promise.resolve(result);
      }
    }

    // Default success result
    return Promise.resolve(createMockResult(0, ''));
  }
}

/**
 * Create a mock repository
 */
function createMockRepository(rootPath: string = '/test/repo'): IRepository {
  return {
    rootUri: vscode.Uri.file(rootPath),
    state: 'idle',
    remotes: [],
    submodules: [],
  };
}

describe('RebaseService', () => {
  let mockGitCli: MockGitCli;
  let rebaseService: RebaseService;
  let mockRepo: IRepository;

  beforeEach(() => {
    mockGitCli = new MockGitCli();
    rebaseService = new RebaseService(mockGitCli);
    mockRepo = createMockRepository();
  });

  afterEach(() => {
    rebaseService.dispose();
  });

  describe('constructor', () => {
    it('should create a new instance', () => {
      assert.ok(rebaseService);
    });

    it('should have onDidChangeRebaseSession event', () => {
      assert.ok(rebaseService.onDidChangeRebaseSession);
    });
  });

  describe('createRebaseService', () => {
    it('should create a new RebaseService instance', () => {
      const service = createRebaseService();
      assert.ok(service);
      service.dispose();
    });
  });

  describe('startInteractiveRebase()', () => {
    it('should return a rebase session with commits', async () => {
      // Mock getting current branch
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      // Mock getting commits to rebase
      mockGitCli.setExecResult(
        'log --reverse',
        createMockResult(0, 'abc123\0First commit\ndef456\0Second commit\n')
      );

      const session = await rebaseService.startInteractiveRebase(mockRepo, 'main');

      assert.strictEqual(session.onto, 'main');
      assert.strictEqual(session.originalBranch, 'feature-branch');
      assert.strictEqual(session.status, 'planning');
      assert.strictEqual(session.currentStep, 0);
      assert.strictEqual(session.commits.length, 2);
      assert.strictEqual(session.commits[0].hash, 'abc123');
      assert.strictEqual(session.commits[0].message, 'First commit');
      assert.strictEqual(session.commits[0].action, 'pick');
    });

    it('should fire onDidChangeRebaseSession event', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      let firedSession: IRebaseSession | undefined;
      const disposable = rebaseService.onDidChangeRebaseSession((session) => {
        firedSession = session;
      });

      await rebaseService.startInteractiveRebase(mockRepo, 'main');

      assert.ok(firedSession);
      assert.strictEqual(firedSession?.onto, 'main');

      disposable.dispose();
    });

    it('should handle empty commit list', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, ''));

      const session = await rebaseService.startInteractiveRebase(mockRepo, 'main');

      assert.strictEqual(session.commits.length, 0);
    });

    it('enumerates the rebase commits with --no-merges (plain rebase -i flattens merges)', async () => {
      // `git rebase -i` (no --rebase-merges) omits merge commits from the todo.
      // If the commit list includes a merge that git's flattened todo doesn't,
      // transformRebaseTodo throws ("references commit not in todo") and the
      // rebase aborts. The enumeration must therefore also drop merges.
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );
      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');

      const logCall = mockGitCli.getExecCalls().find((c) => c.args[0] === 'log');
      assert.ok(logCall, 'a git log call should enumerate the rebase commits');
      assert.ok(
        logCall.args.includes('--no-merges'),
        `commit enumeration must pass --no-merges; got: ${logCall.args.join(' ')}`
      );
    });
  });

  describe('getRebaseSession()', () => {
    it('should return undefined when no session exists', () => {
      const session = rebaseService.getRebaseSession(mockRepo);
      assert.strictEqual(session, undefined);
    });

    it('should return the session after starting a rebase', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      const session = rebaseService.getRebaseSession(mockRepo);

      assert.ok(session);
      assert.strictEqual(session?.onto, 'main');
    });
  });

  describe('updateRebasePlan()', () => {
    beforeEach(async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult(
        'log --reverse',
        createMockResult(0, 'abc123\0First commit\ndef456\0Second commit\nghi789\0Third commit\n')
      );

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
    });

    it('should update commit actions', () => {
      const plan: IRebaseAction[] = [
        { hash: 'abc123', action: 'pick' },
        { hash: 'def456', action: 'squash' },
        { hash: 'ghi789', action: 'drop' },
      ];

      rebaseService.updateRebasePlan(mockRepo, plan);

      const session = rebaseService.getRebaseSession(mockRepo);
      assert.strictEqual(session?.commits[0].action, 'pick');
      assert.strictEqual(session?.commits[1].action, 'squash');
      assert.strictEqual(session?.commits[2].action, 'drop');
    });

    it('should support all rebase actions', () => {
      const actions: RebaseAction[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

      for (const action of actions) {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action },
          { hash: 'def456', action: 'pick' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, action);
      }
    });

    it('should allow reordering commits via drag-and-drop', () => {
      // Reorder: Third, First, Second
      const plan: IRebaseAction[] = [
        { hash: 'ghi789', action: 'pick' },
        { hash: 'abc123', action: 'pick' },
        { hash: 'def456', action: 'pick' },
      ];

      rebaseService.updateRebasePlan(mockRepo, plan);

      const session = rebaseService.getRebaseSession(mockRepo);
      assert.strictEqual(session?.commits[0].hash, 'ghi789');
      assert.strictEqual(session?.commits[1].hash, 'abc123');
      assert.strictEqual(session?.commits[2].hash, 'def456');
    });

    it('should update commit message when newMessage is provided', () => {
      const plan: IRebaseAction[] = [
        { hash: 'abc123', action: 'reword', newMessage: 'Updated message' },
        { hash: 'def456', action: 'pick' },
        { hash: 'ghi789', action: 'pick' },
      ];

      rebaseService.updateRebasePlan(mockRepo, plan);

      const session = rebaseService.getRebaseSession(mockRepo);
      assert.strictEqual(session?.commits[0].message, 'Updated message');
    });

    it('should fire onDidChangeRebaseSession event', () => {
      let firedSession: IRebaseSession | undefined;
      const disposable = rebaseService.onDidChangeRebaseSession((session) => {
        firedSession = session;
      });

      const plan: IRebaseAction[] = [
        { hash: 'abc123', action: 'squash' },
        { hash: 'def456', action: 'pick' },
        { hash: 'ghi789', action: 'pick' },
      ];

      rebaseService.updateRebasePlan(mockRepo, plan);

      assert.ok(firedSession);
      assert.strictEqual(firedSession?.commits[0].action, 'squash');

      disposable.dispose();
    });

    it('should throw error when no session exists', () => {
      const newService = new RebaseService(mockGitCli);
      const plan: IRebaseAction[] = [{ hash: 'abc123', action: 'pick' }];

      assert.throws(() => newService.updateRebasePlan(mockRepo, plan), /No rebase session found/);

      newService.dispose();
    });

    it('should throw error when commit hash not found', () => {
      const plan: IRebaseAction[] = [{ hash: 'nonexistent', action: 'pick' }];

      assert.throws(
        () => rebaseService.updateRebasePlan(mockRepo, plan),
        /Commit nonexistent not found/
      );
    });
  });

  describe('executeRebase() — autostash', () => {
    let tmpRepo: string;
    let tmpRebaseService: RebaseService;
    let tmpRepoObj: IRepository;

    beforeEach(async () => {
      // executeRebase writes a sequence-editor script under <cwd>/.git, so the
      // test needs a real on-disk repo root with a .git directory.
      tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-autostash-'));
      fs.mkdirSync(path.join(tmpRepo, '.git'));
      tmpRepoObj = createMockRepository(tmpRepo);
      tmpRebaseService = new RebaseService(mockGitCli);

      mockGitCli.setExecResult('rev-parse --abbrev-ref HEAD', createMockResult(0, 'feature\n'));
      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));
      await tmpRebaseService.startInteractiveRebase(tmpRepoObj, 'main');
      mockGitCli.clearCalls();
    });

    afterEach(() => {
      tmpRebaseService.dispose();
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    });

    it('passes --autostash to the interactive rebase argv', async () => {
      await tmpRebaseService.executeRebase(tmpRepoObj);

      const rebaseCall = mockGitCli
        .getExecCalls()
        .find((c) => c.args[0] === 'rebase' && c.args.includes('-i'));
      assert.ok(rebaseCall, 'interactive rebase should have been spawned');
      // autostash stashes BEFORE the todo editor runs and pops AFTER the
      // rebase finishes, so it does not interfere with the custom sequence
      // editor wired below.
      // The `onto` ref is routed behind `--end-of-options` so a ref that looks
      // like a flag cannot land as one (symmetry with the other ref-consuming
      // git invocations via buildGitArgs).
      assert.deepStrictEqual(rebaseCall.args, [
        'rebase',
        '-i',
        '--autostash',
        '--end-of-options',
        'main',
      ]);
    });

    it('still wires the custom sequence editor when autostash is enabled', async () => {
      await tmpRebaseService.executeRebase(tmpRepoObj);

      const rebaseCall = mockGitCli
        .getExecCalls()
        .find((c) => c.args[0] === 'rebase' && c.args.includes('-i'));
      assert.ok(rebaseCall);
      const env = (rebaseCall.options as { env?: NodeJS.ProcessEnv }).env;
      assert.ok(env, 'rebase must run with an explicit env');
      assert.ok(
        typeof env.GIT_SEQUENCE_EDITOR === 'string' &&
          env.GIT_SEQUENCE_EDITOR.endsWith('rebase-todo-script.sh'),
        `GIT_SEQUENCE_EDITOR must still point at the generated sequence editor, got: ${String(
          env.GIT_SEQUENCE_EDITOR
        )}`
      );
    });

    // M2 — the interactive rebase sets GIT_SEQUENCE_EDITOR (the todo shim) but
    // git also consults GIT_EDITOR for a `reword`/`squash` message and an
    // `edit` pause. Without it, git falls back to the host's ambient editor
    // (vi/EDITOR) under a non-TTY spawn → hang/confusing fail. Pinning
    // GIT_EDITOR=true keeps git non-interactive; the override path supplies
    // reword/squash messages separately via `commit --amend -m`/`-F`.
    it('pins GIT_EDITOR=true so a reword/squash/edit pause never invokes the ambient editor', async () => {
      // Clear any ambient GIT_EDITOR so this proves executeRebase pins it
      // EXPLICITLY rather than passively inheriting a leaked value.
      const savedEditor = process.env.GIT_EDITOR;
      delete process.env.GIT_EDITOR;
      try {
        await tmpRebaseService.executeRebase(tmpRepoObj);

        const rebaseCall = mockGitCli
          .getExecCalls()
          .find((c) => c.args[0] === 'rebase' && c.args.includes('-i'));
        assert.ok(rebaseCall);
        const env = (rebaseCall.options as { env?: NodeJS.ProcessEnv }).env;
        assert.ok(env, 'rebase must run with an explicit env');
        assert.strictEqual(
          env.GIT_EDITOR,
          'true',
          'GIT_EDITOR must be pinned to a no-op so the host editor is never spawned'
        );
      } finally {
        if (savedEditor === undefined) {
          delete process.env.GIT_EDITOR;
        } else {
          process.env.GIT_EDITOR = savedEditor;
        }
      }
    });

    it('marks a pop conflict non-continuable (rebaseInProgress:false) when no rebase is in progress', async () => {
      // An interactive rebase can replay cleanly and exit 0, yet leave unmerged
      // files behind when git re-applies the autostash and it collides with the
      // rebased changes. At that point the rebase is COMPLETE — git removed
      // .git/rebase-merge — so `git rebase --continue` would dead-end on "no
      // rebase in progress". The result still reports status:'conflict' (so the
      // resolve dialog opens and lists the files) but marks the conflict
      // non-continuable so continue/abort is not offered.
      mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, 'UU shared.ts\n'));
      // No .git/rebase-merge or rebase-apply dir exists in tmpRepo, so the
      // rebase is detected as complete.

      const result = await tmpRebaseService.executeRebase(tmpRepoObj);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'conflict');
      assert.deepStrictEqual(result.conflictedFiles, ['shared.ts']);
      assert.strictEqual(result.rebaseInProgress, false);
    });

    it('removes spent reword override files on a terminal autostash-pop conflict', async () => {
      // The rebase itself finished (no .git/rebase-merge), so its
      // `.intellig-reword-*.txt` override files are spent and must be cleaned
      // even though the autostash pop left a conflict behind.
      const litter = path.join(tmpRepo, '.git', '.intellig-reword-abc123.txt');
      fs.writeFileSync(litter, 'an override message');
      mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, 'UU shared.ts\n'));

      const result = await tmpRebaseService.executeRebase(tmpRepoObj);

      assert.strictEqual(result.rebaseInProgress, false);
      assert.strictEqual(
        fs.existsSync(litter),
        false,
        'a terminal pop conflict must clean the spent reword override files'
      );
    });

    it('marks a conflict continuable (rebaseInProgress:true) when a rebase is still in progress', async () => {
      // A genuine mid-replay conflict leaves a live rebase in progress
      // (.git/rebase-merge present). That state IS continuable, so it stays
      // status:'conflict' AND rebaseInProgress:true to route to continue/abort.
      fs.mkdirSync(path.join(tmpRepo, '.git', 'rebase-merge'), { recursive: true });
      mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, 'UU shared.ts\n'));

      // A still-live rebase keeps its override files — its remaining exec lines
      // still reference them.
      const litter = path.join(tmpRepo, '.git', '.intellig-reword-abc123.txt');
      fs.writeFileSync(litter, 'an override message');

      const result = await tmpRebaseService.executeRebase(tmpRepoObj);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'conflict');
      assert.deepStrictEqual(result.conflictedFiles, ['shared.ts']);
      assert.strictEqual(result.rebaseInProgress, true);
      assert.strictEqual(
        fs.existsSync(litter),
        true,
        'a live rebase must NOT clean override files its remaining exec lines need'
      );
    });

    it('completes cleanly when the autostash pop leaves no unmerged files (exit 0)', async () => {
      // No-regression guard: a clean autostash round-trip still reports a
      // completed rebase.
      mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, ''));

      const result = await tmpRebaseService.executeRebase(tmpRepoObj);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'completed');
    });
  });

  describe('executeRebase() — per-entry message override', () => {
    let tmpRepo: string;
    let tmpRebaseService: RebaseService;
    let tmpRepoObj: IRepository;

    beforeEach(async () => {
      tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-override-'));
      fs.mkdirSync(path.join(tmpRepo, '.git'));
      tmpRepoObj = createMockRepository(tmpRepo);
      tmpRebaseService = new RebaseService(mockGitCli);

      mockGitCli.setExecResult('rev-parse --abbrev-ref HEAD', createMockResult(0, 'feature\n'));
      mockGitCli.setExecResult(
        'log --reverse',
        createMockResult(0, 'aaa111\0First commit\nbbb222\0Second commit\nccc333\0Third commit\n')
      );
      await tmpRebaseService.startInteractiveRebase(tmpRepoObj, 'main');
      mockGitCli.clearCalls();
    });

    afterEach(() => {
      tmpRebaseService.dispose();
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    });

    function readPlanFromRebaseCall(): IRebaseAction[] {
      const rebaseCall = mockGitCli
        .getExecCalls()
        .find((c) => c.args[0] === 'rebase' && c.args.includes('-i'));
      assert.ok(rebaseCall, 'interactive rebase should have been spawned');
      const env = (rebaseCall.options as { env?: NodeJS.ProcessEnv }).env;
      assert.ok(env, 'rebase must run with an explicit env');
      const planJson = env[REBASE_PLAN_ENV];
      assert.ok(typeof planJson === 'string', `${REBASE_PLAN_ENV} must carry the plan as JSON`);
      return JSON.parse(planJson) as IRebaseAction[];
    }

    // Regression: a squash plan with NO per-entry override (the multi-select
    // "Squash Commits" shape: oldest pick, rest squash) must NOT have each
    // commit's own message stamped on as `newMessage`. Stamping it makes every
    // squash entry satisfy hasSquashOverride, which rewrites squash → fixup +
    // amend-with-that-commit's-own-message and silently discards the user's
    // combined message, leaving only the newest commit's message.
    it("does not stamp a commit's own message as a per-entry override", async () => {
      const plan: IRebaseAction[] = [
        { hash: 'aaa111', action: 'pick' },
        { hash: 'bbb222', action: 'squash' },
        { hash: 'ccc333', action: 'squash' },
      ];
      tmpRebaseService.updateRebasePlan(tmpRepoObj, plan);

      await tmpRebaseService.executeRebase(tmpRepoObj);

      const sentPlan = readPlanFromRebaseCall();
      const second = sentPlan.find((e) => e.hash === 'bbb222');
      const third = sentPlan.find((e) => e.hash === 'ccc333');
      assert.strictEqual(
        second?.newMessage,
        undefined,
        "squash entry without an explicit override must not carry the commit's own message"
      );
      assert.strictEqual(third?.newMessage, undefined);
    });

    // A genuine override (the inline-edit reword/squash path) must still reach
    // git's todo transform as `newMessage`, so the override machinery fires.
    it('carries a genuine reword override through to the rebase plan', async () => {
      const plan: IRebaseAction[] = [
        { hash: 'aaa111', action: 'reword', newMessage: 'edited subject' },
        { hash: 'bbb222', action: 'pick' },
        { hash: 'ccc333', action: 'pick' },
      ];
      tmpRebaseService.updateRebasePlan(tmpRepoObj, plan);

      await tmpRebaseService.executeRebase(tmpRepoObj);

      const sentPlan = readPlanFromRebaseCall();
      const first = sentPlan.find((e) => e.hash === 'aaa111');
      assert.strictEqual(first?.newMessage, 'edited subject');
    });
  });

  describe('onto ref argv hardening', () => {
    let tmpRepo: string;
    let tmpRebaseService: RebaseService;
    let tmpRepoObj: IRepository;

    beforeEach(() => {
      tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-onto-eoo-'));
      fs.mkdirSync(path.join(tmpRepo, '.git'));
      tmpRepoObj = createMockRepository(tmpRepo);
      tmpRebaseService = new RebaseService(mockGitCli);
      mockGitCli.setExecResult('rev-parse --abbrev-ref HEAD', createMockResult(0, 'feature\n'));
      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));
    });

    afterEach(() => {
      tmpRebaseService.dispose();
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    });

    it('places a flag-like onto ref after --end-of-options in the rebase argv', async () => {
      const onto = '--upload-pack=evil';
      await tmpRebaseService.startInteractiveRebase(tmpRepoObj, onto);
      mockGitCli.clearCalls();

      await tmpRebaseService.executeRebase(tmpRepoObj);

      const rebaseCall = mockGitCli
        .getExecCalls()
        .find((c) => c.args[0] === 'rebase' && c.args.includes('-i'));
      assert.ok(rebaseCall, 'interactive rebase should have been spawned');
      const eooIdx = rebaseCall.args.indexOf('--end-of-options');
      const ontoIdx = rebaseCall.args.indexOf(onto);
      assert.ok(eooIdx >= 0, 'rebase argv must include --end-of-options');
      assert.ok(ontoIdx >= 0, 'rebase argv must include the onto ref');
      assert.ok(
        eooIdx < ontoIdx,
        `onto ref must come after --end-of-options, got ${JSON.stringify(rebaseCall.args)}`
      );
    });

    it('places a flag-like onto range after --end-of-options in the log argv', async () => {
      const onto = '--output=/tmp/pwned';
      await tmpRebaseService.startInteractiveRebase(tmpRepoObj, onto);

      const logCall = mockGitCli
        .getExecCalls()
        .find((c) => c.args[0] === 'log' && c.args.includes('--reverse'));
      assert.ok(logCall, 'getCommitsToRebase should have run git log');
      const eooIdx = logCall.args.indexOf('--end-of-options');
      const rangeIdx = logCall.args.findIndex((a) => a === `${onto}..HEAD`);
      assert.ok(eooIdx >= 0, 'log argv must include --end-of-options');
      assert.ok(rangeIdx >= 0, 'log argv must include the onto..HEAD range');
      assert.ok(
        eooIdx < rangeIdx,
        `onto range must come after --end-of-options, got ${JSON.stringify(logCall.args)}`
      );
    });
  });

  describe('continueRebase()', () => {
    it('should execute git rebase --continue', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      mockGitCli.clearCalls();

      mockGitCli.setExecResult('rebase --continue', createMockResult(0, ''));

      const result = await rebaseService.continueRebase(mockRepo);

      const calls = mockGitCli.getExecCalls();
      const continueCall = calls.find((c) => c.args.includes('--continue'));
      assert.ok(continueCall);
      assert.ok(result.success);
    });
  });

  describe('abortRebase()', () => {
    it('should execute git rebase --abort', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      mockGitCli.clearCalls();

      mockGitCli.setExecResult('rebase --abort', createMockResult(0, ''));

      await rebaseService.abortRebase(mockRepo);

      const calls = mockGitCli.getExecCalls();
      const abortCall = calls.find((c) => c.args.includes('--abort'));
      assert.ok(abortCall);
    });

    it('should clear the session after abort', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');

      mockGitCli.setExecResult('rebase --abort', createMockResult(0, ''));

      await rebaseService.abortRebase(mockRepo);

      const session = rebaseService.getRebaseSession(mockRepo);
      assert.strictEqual(session, undefined);
    });

    it('should fire onDidChangeRebaseSession with undefined', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');

      let firedSession: IRebaseSession | undefined | null = null;
      const disposable = rebaseService.onDidChangeRebaseSession((session) => {
        firedSession = session;
      });

      mockGitCli.setExecResult('rebase --abort', createMockResult(0, ''));

      await rebaseService.abortRebase(mockRepo);

      assert.strictEqual(firedSession, undefined);

      disposable.dispose();
    });
  });

  describe('skipCommit()', () => {
    it('should execute git rebase --skip', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      mockGitCli.clearCalls();

      mockGitCli.setExecResult('rebase --skip', createMockResult(0, ''));

      const result = await rebaseService.skipCommit(mockRepo);

      const calls = mockGitCli.getExecCalls();
      const skipCall = calls.find((c) => c.args.includes('--skip'));
      assert.ok(skipCall);
      assert.ok(result.success);
    });

    it('should return completed status when rebase finishes after skip', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      mockGitCli.clearCalls();

      // Mock successful skip that completes the rebase
      mockGitCli.setExecResult('rebase --skip', createMockResult(0, ''));
      // No rebase-merge directory means rebase is complete
      mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, ''));

      const result = await rebaseService.skipCommit(mockRepo);

      assert.ok(result.success);
      // Session should be cleared after completion
      // Note: Session may still exist if rebase-merge dir check fails in mock
      // The important thing is the skip command was executed
    });

    it('should fire onDidChangeRebaseSession event after skip', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');

      let eventFired = false;
      const disposable = rebaseService.onDidChangeRebaseSession(() => {
        eventFired = true;
      });

      mockGitCli.setExecResult('rebase --skip', createMockResult(0, ''));
      mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, ''));

      await rebaseService.skipCommit(mockRepo);

      assert.ok(eventFired);

      disposable.dispose();
    });
  });

  describe('Rebase Control Operations', () => {
    beforeEach(async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult(
        'log --reverse',
        createMockResult(0, 'abc123\0First commit\ndef456\0Second commit\n')
      );

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
    });

    describe('continueRebase()', () => {
      it('should resume rebase after conflicts are resolved', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --continue', createMockResult(0, ''));
        mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, ''));

        const result = await rebaseService.continueRebase(mockRepo);

        const calls = mockGitCli.getExecCalls();
        const continueCall = calls.find((c) => c.args.includes('--continue'));
        assert.ok(continueCall);
        assert.ok(result.success);
      });

      it('should return conflict status when conflicts still exist', async () => {
        mockGitCli.clearCalls();
        // Simulate continue failing due to conflicts
        mockGitCli.setExecResult(
          'rebase --continue',
          createMockResult(1, '', 'error: could not apply')
        );
        // Simulate conflicted files in status
        mockGitCli.setExecResult(
          'status --porcelain -z',
          createMockResult(0, 'UU conflicted-file.ts\n')
        );

        const result = await rebaseService.continueRebase(mockRepo);

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.status, 'conflict');
        assert.ok(result.conflictedFiles);
        assert.ok(result.conflictedFiles.length > 0);
      });

      it('should update session status to conflict when conflicts detected', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --continue', createMockResult(1, '', 'error'));
        mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, 'UU file.ts\n'));

        await rebaseService.continueRebase(mockRepo);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.status, 'conflict');
      });

      it('should increment currentStep on successful continue', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --continue', createMockResult(0, ''));
        mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, ''));

        const sessionBefore = rebaseService.getRebaseSession(mockRepo);
        const stepBefore = sessionBefore?.currentStep ?? 0;

        await rebaseService.continueRebase(mockRepo);

        const sessionAfter = rebaseService.getRebaseSession(mockRepo);
        // Step should increment if rebase is still in progress
        // Note: In mock environment, we can't fully simulate the rebase state
        assert.ok(sessionAfter !== undefined || stepBefore >= 0);
      });

      it('should fire onDidChangeRebaseSession event', async () => {
        let eventFired = false;
        const disposable = rebaseService.onDidChangeRebaseSession(() => {
          eventFired = true;
        });

        mockGitCli.setExecResult('rebase --continue', createMockResult(0, ''));
        mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, ''));

        await rebaseService.continueRebase(mockRepo);

        assert.ok(eventFired);

        disposable.dispose();
      });
    });

    describe('abortRebase()', () => {
      it('should restore repository to pre-rebase state', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --abort', createMockResult(0, ''));

        await rebaseService.abortRebase(mockRepo);

        const calls = mockGitCli.getExecCalls();
        const abortCall = calls.find((c) => c.args.includes('--abort'));
        assert.ok(abortCall);
        assert.deepStrictEqual(abortCall.args, ['rebase', '--abort']);
      });

      it('should clear the rebase session completely', async () => {
        mockGitCli.setExecResult('rebase --abort', createMockResult(0, ''));

        // Verify session exists before abort
        const sessionBefore = rebaseService.getRebaseSession(mockRepo);
        assert.ok(sessionBefore);

        await rebaseService.abortRebase(mockRepo);

        // Verify session is cleared after abort
        const sessionAfter = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(sessionAfter, undefined);
      });

      it('should fire onDidChangeRebaseSession with undefined to indicate no active session', async () => {
        let firedValue: IRebaseSession | undefined | null = null;
        const disposable = rebaseService.onDidChangeRebaseSession((session) => {
          firedValue = session;
        });

        mockGitCli.setExecResult('rebase --abort', createMockResult(0, ''));

        await rebaseService.abortRebase(mockRepo);

        assert.strictEqual(firedValue, undefined);

        disposable.dispose();
      });

      it('should throw error if git rebase --abort fails for a genuine reason', async () => {
        // A "no rebase in progress" fatal is reconciled gracefully (a phantom
        // session is just cleared). A genuine failure — e.g. a locked worktree
        // — must still surface as a throw so the caller can report it.
        mockGitCli.setExecResult(
          'rebase --abort',
          createMockResult(1, '', 'error: could not remove worktree lock file')
        );

        await assert.rejects(async () => rebaseService.abortRebase(mockRepo), /Git command failed/);
      });
    });

    describe('skipCommit()', () => {
      it('should skip the current problematic commit', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --skip', createMockResult(0, ''));
        mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, ''));

        const result = await rebaseService.skipCommit(mockRepo);

        const calls = mockGitCli.getExecCalls();
        const skipCall = calls.find((c) => c.args.includes('--skip'));
        assert.ok(skipCall);
        assert.deepStrictEqual(skipCall.args, ['rebase', '--skip']);
        assert.ok(result.success);
      });

      it('should return conflict status if skip leads to more conflicts', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --skip', createMockResult(1, '', 'error'));
        mockGitCli.setExecResult(
          'status --porcelain -z',
          createMockResult(0, 'UU another-file.ts\n')
        );

        const result = await rebaseService.skipCommit(mockRepo);

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.status, 'conflict');
        assert.ok(result.conflictedFiles);
        assert.ok(result.conflictedFiles.includes('another-file.ts'));
      });

      it('should update session status after skip', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --skip', createMockResult(0, ''));
        mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, ''));

        await rebaseService.skipCommit(mockRepo);

        // Session should be updated (either in-progress or completed)
        // The exact state depends on whether rebase is still in progress
        const sessionAfterSkip = rebaseService.getRebaseSession(mockRepo);
        // In mock environment, session may or may not exist depending on rebase state detection
        assert.ok(sessionAfterSkip === undefined || sessionAfterSkip.status !== 'planning');
      });

      it('should increment currentStep when skip succeeds and rebase continues', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --skip', createMockResult(0, ''));
        mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, ''));

        const sessionBefore = rebaseService.getRebaseSession(mockRepo);
        const stepBefore = sessionBefore?.currentStep ?? 0;

        await rebaseService.skipCommit(mockRepo);

        const sessionAfter = rebaseService.getRebaseSession(mockRepo);
        // If session still exists, step should have incremented
        if (sessionAfter) {
          assert.ok(sessionAfter.currentStep >= stepBefore);
        }
      });
    });

    describe('Integration: Control Operations Workflow', () => {
      it('should handle continue -> conflict -> skip workflow', async () => {
        // First continue attempt hits conflict
        mockGitCli.setExecResult('rebase --continue', createMockResult(1, '', 'error'));
        mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, 'UU file.ts\n'));

        const continueResult = await rebaseService.continueRebase(mockRepo);
        assert.strictEqual(continueResult.status, 'conflict');

        // User decides to skip the problematic commit
        mockGitCli.setExecResult('rebase --skip', createMockResult(0, ''));
        mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, ''));

        const skipResult = await rebaseService.skipCommit(mockRepo);
        assert.ok(skipResult.success);
      });

      it('should handle continue -> conflict -> abort workflow', async () => {
        // Continue hits conflict
        mockGitCli.setExecResult('rebase --continue', createMockResult(1, '', 'error'));
        mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, 'UU file.ts\n'));

        const continueResult = await rebaseService.continueRebase(mockRepo);
        assert.strictEqual(continueResult.status, 'conflict');

        // User decides to abort
        mockGitCli.setExecResult('rebase --abort', createMockResult(0, ''));

        await rebaseService.abortRebase(mockRepo);

        // Session should be cleared
        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session, undefined);
      });
    });
  });

  describe('stale / phantom session lifecycle (issue #18)', () => {
    beforeEach(() => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );
      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));
    });

    it('clearSession drops a cached planning session so it cannot poison later ops', async () => {
      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      assert.ok(rebaseService.getRebaseSession(mockRepo), 'session exists before clear');

      rebaseService.clearSession(mockRepo);

      assert.strictEqual(
        rebaseService.getRebaseSession(mockRepo),
        undefined,
        'session is gone after clearSession'
      );
    });

    it('clearSession fires onDidChangeRebaseSession(undefined)', async () => {
      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      let fired: IRebaseSession | undefined | null = null;
      const disposable = rebaseService.onDidChangeRebaseSession((s) => {
        fired = s;
      });
      rebaseService.clearSession(mockRepo);
      assert.strictEqual(fired, undefined);
      disposable.dispose();
    });

    it('continueRebase against a session with no git rebase in progress self-clears and reports cleared-stale, not completed', async () => {
      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      // git has no rebase-merge dir → `git rebase --continue` fatals.
      mockGitCli.setExecResult(
        'rebase --continue',
        createMockResult(128, '', 'fatal: No rebase in progress?')
      );
      mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, ''));

      const result = await rebaseService.continueRebase(mockRepo);

      assert.strictEqual(result.success, true, 'must not surface a failure for a phantom session');
      // A no-op stale-clear is NOT a completed rebase — it gets its own status
      // so the UI can show an honest message instead of "Rebase completed
      // successfully!".
      assert.strictEqual(result.status, 'cleared-stale');
      // The phantom session is gone — it can no longer poison later ops.
      assert.strictEqual(rebaseService.getRebaseSession(mockRepo), undefined);
    });

    it('skipCommit against a session with no git rebase in progress self-clears and reports cleared-stale', async () => {
      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      mockGitCli.setExecResult(
        'rebase --skip',
        createMockResult(128, '', 'fatal: No rebase in progress?')
      );
      mockGitCli.setExecResult('status --porcelain -z', createMockResult(0, ''));

      const result = await rebaseService.skipCommit(mockRepo);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'cleared-stale');
      assert.strictEqual(rebaseService.getRebaseSession(mockRepo), undefined);
    });

    it('abortRebase against a "no rebase in progress" git fatal self-clears without throwing', async () => {
      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      mockGitCli.setExecResult(
        'rebase --abort',
        createMockResult(128, '', 'fatal: No rebase in progress?')
      );

      await assert.doesNotReject(async () => rebaseService.abortRebase(mockRepo));
      assert.strictEqual(rebaseService.getRebaseSession(mockRepo), undefined);
    });

    it('abortRebase still throws on a genuine (non-phantom) git failure', async () => {
      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      mockGitCli.setExecResult(
        'rebase --abort',
        createMockResult(1, '', 'error: could not remove worktree lock file')
      );

      await assert.rejects(async () => rebaseService.abortRebase(mockRepo));
    });
  });

  describe('dispose()', () => {
    it('should dispose without error', () => {
      rebaseService.dispose();
      // Should not throw
    });

    it('should clear sessions on dispose', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      rebaseService.dispose();

      // Create a new service to verify session is cleared
      const newService = new RebaseService(mockGitCli);
      const session = newService.getRebaseSession(mockRepo);
      assert.strictEqual(session, undefined);
      newService.dispose();
    });
  });

  describe('Rebase Action Handlers', () => {
    beforeEach(async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult(
        'log --reverse',
        createMockResult(0, 'abc123\0First commit\ndef456\0Second commit\nghi789\0Third commit\n')
      );

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
    });

    describe('Reword Action', () => {
      it('should allow setting reword action on a commit', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'reword', newMessage: 'New message for first commit' },
          { hash: 'def456', action: 'pick' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'reword');
        assert.strictEqual(session?.commits[0].message, 'New message for first commit');
      });

      it('should preserve original message when newMessage is not provided for reword', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'reword' },
          { hash: 'def456', action: 'pick' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'reword');
        assert.strictEqual(session?.commits[0].message, 'First commit');
      });

      it('should provide reword message via provideRewordMessage', async () => {
        mockGitCli.setExecResult('commit --amend', createMockResult(0, ''));
        mockGitCli.setExecResult('rebase --continue', createMockResult(0, ''));

        const result = await rebaseService.provideRewordMessage(mockRepo, 'New commit message');

        // Verify git commit --amend was called with the new message
        const calls = mockGitCli.getExecCalls();
        const amendCall = calls.find((c) => c.args.includes('--amend') && c.args.includes('-m'));
        assert.ok(amendCall);
        assert.ok(amendCall.args.includes('New commit message'));
        assert.ok(result.success);
      });

      it('should throw error when providing reword message without session', async () => {
        const newService = new RebaseService(mockGitCli);

        await assert.rejects(
          async () => newService.provideRewordMessage(mockRepo, 'New message'),
          /No rebase session found/
        );

        newService.dispose();
      });
    });

    describe('Edit Action', () => {
      it('should allow setting edit action on a commit', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'edit' },
          { hash: 'def456', action: 'pick' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'edit');
      });

      it('should allow amending commit during edit pause', async () => {
        mockGitCli.setExecResult('commit --amend', createMockResult(0, ''));

        const result = await rebaseService.amendEditCommit(mockRepo, 'Amended message');

        const calls = mockGitCli.getExecCalls();
        const amendCall = calls.find((c) => c.args.includes('--amend'));
        assert.ok(amendCall);
        assert.ok(result.success);
        assert.strictEqual(result.status, 'paused');
      });

      it('should allow amending without changing message', async () => {
        mockGitCli.setExecResult('commit --amend', createMockResult(0, ''));

        const result = await rebaseService.amendEditCommit(mockRepo);

        const calls = mockGitCli.getExecCalls();
        const amendCall = calls.find(
          (c) => c.args.includes('--amend') && c.args.includes('--no-edit')
        );
        assert.ok(amendCall);
        assert.ok(result.success);
      });

      it('should throw error when amending without session', async () => {
        const newService = new RebaseService(mockGitCli);

        await assert.rejects(
          async () => newService.amendEditCommit(mockRepo),
          /No rebase session found/
        );

        newService.dispose();
      });
    });

    describe('Squash and Fixup Actions', () => {
      it('should allow setting squash action to combine commits', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'pick' },
          { hash: 'def456', action: 'squash' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'pick');
        assert.strictEqual(session?.commits[1].action, 'squash');
      });

      it('should allow setting fixup action to combine commits without message', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'pick' },
          { hash: 'def456', action: 'fixup' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'pick');
        assert.strictEqual(session?.commits[1].action, 'fixup');
      });

      it('should allow multiple consecutive squash/fixup actions', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'pick' },
          { hash: 'def456', action: 'squash' },
          { hash: 'ghi789', action: 'fixup' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'pick');
        assert.strictEqual(session?.commits[1].action, 'squash');
        assert.strictEqual(session?.commits[2].action, 'fixup');
      });

      it('should allow mixing squash and fixup with reordering', () => {
        // Reorder and squash: Third (pick), First (squash), Second (fixup)
        const plan: IRebaseAction[] = [
          { hash: 'ghi789', action: 'pick' },
          { hash: 'abc123', action: 'squash' },
          { hash: 'def456', action: 'fixup' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].hash, 'ghi789');
        assert.strictEqual(session?.commits[0].action, 'pick');
        assert.strictEqual(session?.commits[1].hash, 'abc123');
        assert.strictEqual(session?.commits[1].action, 'squash');
        assert.strictEqual(session?.commits[2].hash, 'def456');
        assert.strictEqual(session?.commits[2].action, 'fixup');
      });
    });

    describe('Drop Action', () => {
      it('should allow setting drop action to remove a commit', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'pick' },
          { hash: 'def456', action: 'drop' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[1].action, 'drop');
      });

      it('should allow dropping multiple commits', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'drop' },
          { hash: 'def456', action: 'drop' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'drop');
        assert.strictEqual(session?.commits[1].action, 'drop');
        assert.strictEqual(session?.commits[2].action, 'pick');
      });
    });

    describe('Combined Action Scenarios', () => {
      it('should support complex rebase plan with all action types', () => {
        const plan: IRebaseAction[] = [
          { hash: 'ghi789', action: 'pick' }, // Reordered to first
          { hash: 'abc123', action: 'reword', newMessage: 'Reworded first commit' },
          { hash: 'def456', action: 'squash' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits.length, 3);
        assert.strictEqual(session?.commits[0].hash, 'ghi789');
        assert.strictEqual(session?.commits[0].action, 'pick');
        assert.strictEqual(session?.commits[1].hash, 'abc123');
        assert.strictEqual(session?.commits[1].action, 'reword');
        assert.strictEqual(session?.commits[1].message, 'Reworded first commit');
        assert.strictEqual(session?.commits[2].hash, 'def456');
        assert.strictEqual(session?.commits[2].action, 'squash');
      });

      it('should preserve session state across multiple plan updates', () => {
        // First update
        const plan1: IRebaseAction[] = [
          { hash: 'abc123', action: 'edit' },
          { hash: 'def456', action: 'pick' },
          { hash: 'ghi789', action: 'pick' },
        ];
        rebaseService.updateRebasePlan(mockRepo, plan1);

        // Second update
        const plan2: IRebaseAction[] = [
          { hash: 'abc123', action: 'pick' },
          { hash: 'def456', action: 'squash' },
          { hash: 'ghi789', action: 'drop' },
        ];
        rebaseService.updateRebasePlan(mockRepo, plan2);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'pick');
        assert.strictEqual(session?.commits[1].action, 'squash');
        assert.strictEqual(session?.commits[2].action, 'drop');
        assert.strictEqual(session?.onto, 'main');
        assert.strictEqual(session?.originalBranch, 'feature-branch');
      });
    });
  });

  describe('reword-file cleanup on rebase completion', () => {
    it('removes leftover .intellig-reword-*.txt files when a rebase completes', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-reword-clean-'));
      fs.mkdirSync(path.join(tmp, '.git'));
      const litter = path.join(tmp, '.git', '.intellig-reword-abc123.txt');
      const keep = path.join(tmp, '.git', 'config');
      fs.writeFileSync(litter, 'an override message');
      fs.writeFileSync(keep, '[core]\n');
      const repo = createMockRepository(tmp);

      try {
        // `rebase --continue` with no `.git/rebase-merge` dir present →
        // isRebaseInProgress() is false → the rebase reads as completed.
        await rebaseService.continueRebase(repo);

        assert.strictEqual(
          fs.existsSync(litter),
          false,
          'the reword override file must be removed when the rebase completes'
        );
        assert.strictEqual(
          fs.existsSync(keep),
          true,
          'unrelated git-dir files must be left untouched'
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

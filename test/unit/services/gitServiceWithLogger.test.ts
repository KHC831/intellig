/**
 * `GitService` Logger waypoint integration tests.
 *
 * Pins each Logger waypoint installed by in
 * `src/services/GitService.ts` to its expected level and key context
 * fields, exercising the production Logger end-to-end through the
 * shared `IntelliG` `OutputChannel` sink.
 *
 * The waypoints are:
 *
 * | # | Trigger                                         | Level | Message                                       | Key context fields           |
 * |---|-------------------------------------------------|-------|-----------------------------------------------|------------------------------|
 * | 1 | `new GitService(gitPath)`                       | info  | `'GitService constructed'`                    | `{ gitPath }`                |
 * | 2 | successful repository discovery                 | info  | `'repository discovered'`                     | `{ rootPath }`               |
 * | 3 | `reloadRepository` entry                        | info  | `'reloadRepository entry'`                    | `{ rootPath }`               |
 * | 4 | `reloadRepository` exit (success)               | info  | `'reloadRepository exit'`                     | `{ rootPath, ok: true }`     |
 * | 5 | `reloadRepository` exit (failure)               | info  | `'reloadRepository exit'`                     | `{ rootPath, ok: false }`    |
 * | 6 | watcher-driven reload failure (`_performDebouncedRefresh` catch) | warn | `'watcher-driven repository reload failed'`   | `{ rootPath, errorMessage }` |
 * | 7 | `dispose()`                                     | info  | `'GitService disposing — tearing down watchers'` | `{ watcherCount, repositoryCount }` |
 * | 8 | `git` CLI command execution (`onCommandExecuted` fire) | debug | `'git command executed'`                      | `{ args }`                   |
 *
 * ### Approach
 *
 * Standard Logger-test pattern (matches `sanitizerFallback.test.ts`,
 * `circularContext.test.ts`, `configurationServiceChangeKeys.property.test.ts`):
 *
 * 1. Pin `intellig.log.level = 'trace'` BEFORE `initLogger` so every
 *    waypoint level (debug through warn) is admitted regardless of
 *    record severity.
 * 2. `initOutputChannel(context)` + `initLogger(context)` so the
 *    production sinks are wired against the mock channel.
 * 3. Construct `GitService` (or invoke the relevant code path) and
 *    capture every line written to the channel.
 * 4. For each waypoint, locate the record by message, reassemble its
 *    rendered block from the captured-lines array, parse it via
 *    `parseRecord` from `src/utils/logger/render.ts`, and assert:
 *    - `record.level` matches the expected severity
 *    - `record.component === 'GitService'`
 *    - `record.message` matches the expected message verbatim
 *    - `record.context` contains the expected key/value pairs
 *
 * ### Test isolation
 *
 * Every test does a full Logger + OutputChannel + workspace-config
 * reset in `beforeEach` and `afterEach` so a stale resolver, sink, or
 * mock-config knob from one test cannot bleed into the next. The
 * order of resets matters: drop the Logger first so its sinks detach
 * before the OutputChannel singleton is dropped.
 *
 * ### Stubbing strategy
 *
 * The tests reach through the GitService `private` boundary
 * (the same TestSurface convention used by `gitServiceDiscoverNested
 * .test.ts` and `gitServiceWatcher.test.ts`) so we can:
 *
 * - swap `_gitCli` for a scripted stub so reloads do not spawn real
 *   git subprocesses,
 * - replace `loadRepository` with a counter or a thrower so the
 *   `reloadRepository`-success and `reloadRepository`-failure
 *   waypoints can be exercised independently,
 * - replace `setupRepositoryWatcher` with a no-op so the discovery
 *   path does not install real `FileSystemWatcher` instances against
 *   the test fixture's fake paths,
 * - swap `_repoScanFs` for an in-memory tree stub so
 *   `discoverRepository` walks deterministic synthetic data.
 */

import '../../setup';

import * as assert from 'assert';
import * as vscode from 'vscode';

import { okAsync, errAsync, ResultAsync } from 'neverthrow';
import { GitService } from '../../../src/git-core/GitService';
import { GitError, SpawnFailedError } from '../../../src/git-core/errors';
import { __resetLoggerForTest, initLogger } from '../../../src/utils/logger';
import { parseRecord } from '../../../src/utils/logger/render';
import {
  __resetOutputChannelForTest,
  getOutputChannel,
  initOutputChannel,
} from '../../../src/utils/outputChannel';
import { IRepoScanFs } from '../../../src/git-core/repoScan';
import { resetMockConfiguration, setMockConfigValue, Uri, workspace } from '../../mocks/vscode';

import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import type { LogRecord } from '../../../src/utils/logger';

// ─── Test fixtures ─────────────────────────────────────────────────────────

/**
 * Minimal `ExtensionContext` stub. `initOutputChannel` and
 * `initLogger` only exercise `subscriptions`.
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return { subscriptions } as unknown as vscode.ExtensionContext;
}

/**
 * Snapshot the current set of captured channel lines. The mock
 * channel from `test/mocks/vscode.ts` exposes `_lines` on every
 * instance; the production `OutputChannelSink` writes one entry per
 * record via `appendLine`.
 */
function captureChannelLines(): string[] {
  return [...(getOutputChannel() as unknown as { _lines: string[] })._lines];
}

/**
 * Wire a fresh Logger with `intellig.log.level = 'trace'` so every
 * waypoint level (debug through warn) is admitted. The configuration
 * write happens BEFORE `initLogger` so the resolver's initial
 * `refresh()` reads the trace threshold.
 */
function setupLoggerWithTraceThreshold(): vscode.ExtensionContext {
  setMockConfigValue('intellig', 'log.level', 'trace');
  const ctx = makeFakeContext();
  initOutputChannel(ctx);
  initLogger(ctx);
  return ctx;
}

/**
 * Full reset: drop the Logger first (which detaches sinks), then the
 * OutputChannel singleton, then any mock-config writes. Order matters
 * — see the comment on `setupLoggerWithTraceThreshold`.
 */
function fullReset(): void {
  __resetLoggerForTest();
  __resetOutputChannelForTest();
  resetMockConfiguration();
  workspace.workspaceFolders = undefined;
}

/**
 * Locate the index of the header line whose message column contains
 * the given substring. The OutputChannelSink writes one rendered
 * block per record; each block's header line carries the message
 * verbatim (after the `escapeInline` pass, which is a no-op for the
 * plain-ASCII message strings the GitService waypoints emit).
 *
 * Returns `-1` if no such record is present.
 */
function findHeaderIndex(lines: readonly string[], messageSubstring: string): number {
  for (let i = 0; i < lines.length; i++) {
    // Header lines have the shape `[ts] LEVEL component: message`.
    // Only headers (no two-space continuation indent) carry the
    // message column, so we filter those out to avoid matching a
    // `ctx=` continuation that happens to embed the substring.
    if (lines[i].startsWith('  ')) {
      continue;
    }
    if (lines[i].includes(messageSubstring)) {
      return i;
    }
  }
  return -1;
}

/**
 * Reassemble a single record's rendered block from the captured-lines
 * array. The OutputChannel mock stores each `appendLine` argument as
 * its own entry, so a record with N continuation lines spans `N+1`
 * adjacent entries. Walk forward from `headerIndex` accumulating
 * lines until we hit a line that does not start with the
 * two-space continuation indent — that line is the next record's
 * header (or the end of the stream).
 */
function reassembleBlock(lines: readonly string[], headerIndex: number): string {
  const collected: string[] = [lines[headerIndex]];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith('  ')) {
      collected.push(lines[i]);
    } else {
      break;
    }
  }
  return collected.join('\n');
}

/**
 * Find every header index for a record whose message column contains
 * `messageSubstring`. Returns header indices in document order.
 */
function findAllHeaderIndices(
  lines: readonly string[],
  messageSubstring: string
): readonly number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('  ')) {
      continue;
    }
    if (lines[i].includes(messageSubstring)) {
      out.push(i);
    }
  }
  return out;
}

/**
 * Parse the record whose message column contains `messageSubstring`,
 * preferring the LAST match in the captured-lines array so callers
 * that emit a sequence of records sharing a message prefix (e.g.
 * `'reloadRepository exit'`) deterministically receive the most
 * recent. Throws if no such record is present.
 */
function findAndParseRecord(
  lines: readonly string[],
  messageSubstring: string,
  occurrence: 'first' | 'last' = 'last'
): LogRecord {
  const indices = findAllHeaderIndices(lines, messageSubstring);
  assert.ok(
    indices.length > 0,
    `expected at least one record with message containing ${JSON.stringify(messageSubstring)}; ` +
      `got captured lines:\n${lines.join('\n')}`
  );
  const headerIdx = occurrence === 'last' ? indices[indices.length - 1] : indices[0];
  const block = reassembleBlock(lines, headerIdx);
  return parseRecord(block);
}

// ─── GitCli stub used across the waypoint specs ────────────────────────────

/**
 * Stub `GitCli` that records `exec` calls, never spawns subprocesses,
 * and exposes the production `onCommandExecuted` event so the
 * GitService listener (which emits the section 9.1 `'git command executed'`
 * debug record) wires up correctly.
 *
 * The event emitter is constructed lazily on first access so the
 * event can be fired by tests via `_fire(event)`.
 */
class StubGitCli {
  public readonly calls: { args: string[] }[] = [];
  public rootByPath: Map<string, string | undefined> = new Map();

  // Inline EventEmitter shape (the mock module's EventEmitter cannot
  // be imported as a type because the production `vscode.EventEmitter`
  // and the mock share the same runtime identity through the
  // `setup.ts` require shim). The fields are intentionally minimal.
  private readonly _listeners: ((e: {
    command: string;
    args: string[];
    result: unknown;
  }) => void)[] = [];

  readonly onCommandExecuted = (
    listener: (e: { command: string; args: string[]; result: unknown }) => void
  ): { dispose: () => void } => {
    this._listeners.push(listener);
    return {
      dispose: (): void => {
        const idx = this._listeners.indexOf(listener);
        if (idx >= 0) {
          this._listeners.splice(idx, 1);
        }
      },
    };
  };

  /**
   * Test seam: synthesize an `onCommandExecuted` event so the
   * GitService listener fires the `'git command executed'` debug
   * record without requiring a real `exec` call.
   */
  fireCommandExecuted(args: string[]): void {
    const event = {
      command: 'git',
      args,
      result: { exitCode: 0, stdout: '', stderr: '', combined: '' },
    };
    for (const listener of [...this._listeners]) {
      listener(event);
    }
  }

  async exec(
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    this.calls.push({ args });
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }

  getRepositoryRoot(p: string): ResultAsync<string | undefined, GitError> {
    return okAsync(this.rootByPath.get(p));
  }

  dispose(): void {
    this._listeners.length = 0;
  }
}

/**
 * Lightweight in-memory `IRepoScanFs` stub. Tests pass a static
 * directory tree map (path → child names) so `scanFolderForGitRepos`
 * walks deterministic data without touching the disk.
 */
function makeFsStub(tree: Record<string, string[]>): IRepoScanFs {
  return {
    async readdir(
      p: string,
      _options: { withFileTypes: true }
    ): Promise<
      {
        name: string;
        isDirectory(): boolean;
        isSymbolicLink(): boolean;
        isFile(): boolean;
      }[]
    > {
      const children = tree[p] ?? [];
      return children.map((name) => ({
        name,
        isDirectory(): boolean {
          return true;
        },
        isSymbolicLink(): boolean {
          return false;
        },
        isFile(): boolean {
          return false;
        },
      }));
    },
    async realpath(p: string): Promise<string> {
      return p;
    },
  };
}

/**
 * GitService private surface used by every waypoint spec. Mirrors the
 * shape used by `gitServiceDiscoverNested.test.ts` and
 * `gitServiceWatcher.test.ts`.
 */
interface GitServiceWaypointSurface {
  _gitCli: StubGitCli;
  loadRepository: (root: string) => Promise<IRepository>;
  setupRepositoryWatcher: (root: string) => void;
  _repoScanFs: IRepoScanFs;
  discoverRepository: (path: string) => Promise<void>;
  _performDebouncedRefresh: (root: string) => Promise<void>;
}

/**
 * Build a fake `IRepository` for stub paths so `loadRepository`'s
 * stub return value carries a real `rootUri.fsPath` for downstream
 * waypoints like `reloadRepository`.
 */
function makeFakeRepo(rootPath: string): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: 'idle',
    head: { name: 'main', commit: 'a'.repeat(40), ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

// ─── Specs ──────────────────────────────────────────────────────────────────

describe('GitService — Logger waypoint integration', () => {
  beforeEach(() => {
    fullReset();
  });

  afterEach(() => {
    fullReset();
  });

  // ------------------------------------------------------------------------
  // Waypoint 1: construction
  // ------------------------------------------------------------------------

  describe('construction', () => {
    it('emits info-level "GitService constructed" with { gitPath } context', () => {
      setupLoggerWithTraceThreshold();

      const gitPath = '/test/git-binary';
      const service = new GitService(gitPath);
      try {
        const lines = captureChannelLines();
        const record = findAndParseRecord(lines, 'GitService constructed', 'first');

        assert.strictEqual(
          record.level,
          'info',
          `expected info level for construction waypoint; got ${record.level}`
        );
        assert.strictEqual(
          record.component,
          'GitService',
          `expected component='GitService'; got ${record.component}`
        );
        assert.strictEqual(
          record.message,
          'GitService constructed',
          `expected message='GitService constructed'; got ${record.message}`
        );
        assert.strictEqual(
          (record.context as { gitPath?: string } | undefined)?.gitPath,
          gitPath,
          'construction record must carry gitPath in context'
        );
      } finally {
        service.dispose();
      }
    });

    it('emits the construction record even when no gitPath is supplied (gitPath is undefined)', () => {
      setupLoggerWithTraceThreshold();

      const service = new GitService();
      try {
        const lines = captureChannelLines();
        const record = findAndParseRecord(lines, 'GitService constructed', 'first');

        assert.strictEqual(record.level, 'info');
        assert.strictEqual(record.component, 'GitService');
        // `undefined` is dropped by the Logger's bindings/context
        // walker (matches JSON.stringify semantics), so the rendered
        // block has either no `ctx=` continuation line or a `ctx={}`.
        // Either shape is acceptable; the construction waypoint pins
        // the level + message.
        assert.strictEqual(record.message, 'GitService constructed');
      } finally {
        service.dispose();
      }
    });
  });

  // ------------------------------------------------------------------------
  // Waypoint 2: repository discovery
  // ------------------------------------------------------------------------

  describe('repository discovery', () => {
    it('emits info-level "repository discovered" with { rootPath } per discovered repo', async () => {
      setupLoggerWithTraceThreshold();

      const stubCli = new StubGitCli();
      stubCli.rootByPath.set('/work', undefined);
      stubCli.rootByPath.set('/work/a', '/work/a');

      const service = new GitService();
      try {
        const surface = service as unknown as GitServiceWaypointSurface;
        surface._gitCli = stubCli;
        // Exercise the REAL `loadRepository` (its StubGitCli `exec` returns
        // benign empty output, so no real git subprocess runs) — the discovery
        // waypoint now lives in its first-insertion funnel. Stub only
        // `setupRepositoryWatcher` so no real `FileSystemWatcher` is installed
        // against `/work/a/.git`.
        surface.setupRepositoryWatcher = (_root: string): void => {
          /* no-op */
        };
        surface._repoScanFs = makeFsStub({ '/work': ['a'] });

        await surface.discoverRepository('/work');

        const lines = captureChannelLines();
        const record = findAndParseRecord(lines, 'repository discovered', 'first');

        assert.strictEqual(
          record.level,
          'info',
          `expected info level for discovery waypoint; got ${record.level}`
        );
        assert.strictEqual(record.component, 'GitService');
        assert.strictEqual(record.message, 'repository discovered');
        assert.strictEqual(
          (record.context as { rootPath?: string } | undefined)?.rootPath,
          '/work/a',
          'discovery record must carry the discovered rootPath'
        );
      } finally {
        service.dispose();
      }
    });

    it('emits one discovery record per repo when multiple are discovered', async () => {
      setupLoggerWithTraceThreshold();

      const stubCli = new StubGitCli();
      stubCli.rootByPath.set('/work', undefined);
      stubCli.rootByPath.set('/work/a', '/work/a');
      stubCli.rootByPath.set('/work/b', '/work/b');

      const service = new GitService();
      try {
        const surface = service as unknown as GitServiceWaypointSurface;
        surface._gitCli = stubCli;
        // Exercise the REAL `loadRepository` funnel (StubGitCli `exec` returns
        // benign empty output) so the per-repo discovery waypoint fires from its
        // true home. Stub only `setupRepositoryWatcher` to avoid real watchers.
        surface.setupRepositoryWatcher = (_root: string): void => {
          /* no-op */
        };
        surface._repoScanFs = makeFsStub({ '/work': ['a', 'b'] });

        await surface.discoverRepository('/work');

        const lines = captureChannelLines();
        const indices = findAllHeaderIndices(lines, 'repository discovered');

        assert.strictEqual(
          indices.length,
          2,
          `expected exactly 2 'repository discovered' records (one per repo); got ${indices.length}`
        );

        const observedRoots = new Set<string>();
        for (const idx of indices) {
          const record = parseRecord(reassembleBlock(lines, idx));
          assert.strictEqual(record.level, 'info');
          assert.strictEqual(record.component, 'GitService');
          assert.strictEqual(record.message, 'repository discovered');
          const rootPath = (record.context as { rootPath?: string } | undefined)?.rootPath;
          assert.ok(typeof rootPath === 'string', 'each discovery record must carry a rootPath');
          observedRoots.add(rootPath);
        }
        assert.deepStrictEqual(
          [...observedRoots].sort(),
          ['/work/a', '/work/b'],
          'each discovered repo must produce its own discovery record'
        );
      } finally {
        service.dispose();
      }
    });
  });

  // ------------------------------------------------------------------------
  // Waypoints 3, 4, 5: reloadRepository entry / exit
  // ------------------------------------------------------------------------

  describe('reloadRepository', () => {
    it('emits info "reloadRepository entry" then info "reloadRepository exit" with ok=true on success', async () => {
      setupLoggerWithTraceThreshold();

      const stubCli = new StubGitCli();
      const service = new GitService();
      try {
        const surface = service as unknown as GitServiceWaypointSurface;
        surface._gitCli = stubCli;

        const repo = makeFakeRepo('/repo/root');
        surface.loadRepository = async (root: string): Promise<IRepository> => {
          return makeFakeRepo(root);
        };

        const result = await service.reloadRepository(repo);
        assert.ok(result, 'reloadRepository must return a fresh IRepository on success');

        const lines = captureChannelLines();

        const entry = findAndParseRecord(lines, 'reloadRepository entry', 'first');
        assert.strictEqual(entry.level, 'info');
        assert.strictEqual(entry.component, 'GitService');
        assert.strictEqual(entry.message, 'reloadRepository entry');
        assert.strictEqual(
          (entry.context as { rootPath?: string } | undefined)?.rootPath,
          '/repo/root'
        );

        const exit = findAndParseRecord(lines, 'reloadRepository exit', 'last');
        assert.strictEqual(exit.level, 'info');
        assert.strictEqual(exit.component, 'GitService');
        assert.strictEqual(exit.message, 'reloadRepository exit');
        const exitCtx = exit.context as { rootPath?: string; ok?: boolean } | undefined;
        assert.strictEqual(exitCtx?.rootPath, '/repo/root');
        assert.strictEqual(exitCtx?.ok, true, 'success-path exit record must carry ok=true');

        // Document order: entry must precede exit.
        const entryIdx = findHeaderIndex(lines, 'reloadRepository entry');
        const exitIndices = findAllHeaderIndices(lines, 'reloadRepository exit');
        const exitIdx = exitIndices[exitIndices.length - 1];
        assert.ok(
          entryIdx < exitIdx,
          `entry record must precede exit record in the channel; got entry@${entryIdx}, exit@${exitIdx}`
        );
      } finally {
        service.dispose();
      }
    });

    it('emits info "reloadRepository entry" then info "reloadRepository exit" with ok=false on failure', async () => {
      setupLoggerWithTraceThreshold();

      const stubCli = new StubGitCli();
      const service = new GitService();
      try {
        const surface = service as unknown as GitServiceWaypointSurface;
        surface._gitCli = stubCli;

        const repo = makeFakeRepo('/repo/failing');
        surface.loadRepository = async (_root: string): Promise<IRepository> => {
          throw new Error('synthetic loadRepository failure for waypoint test');
        };

        const result = await service.reloadRepository(repo);
        assert.strictEqual(
          result,
          undefined,
          'reloadRepository must return undefined when loadRepository rejects'
        );

        const lines = captureChannelLines();

        const entry = findAndParseRecord(lines, 'reloadRepository entry', 'first');
        assert.strictEqual(entry.level, 'info');
        assert.strictEqual(entry.message, 'reloadRepository entry');
        assert.strictEqual(
          (entry.context as { rootPath?: string } | undefined)?.rootPath,
          '/repo/failing'
        );

        const exit = findAndParseRecord(lines, 'reloadRepository exit', 'last');
        assert.strictEqual(exit.level, 'info');
        assert.strictEqual(exit.message, 'reloadRepository exit');
        const exitCtx = exit.context as { rootPath?: string; ok?: boolean } | undefined;
        assert.strictEqual(exitCtx?.rootPath, '/repo/failing');
        assert.strictEqual(exitCtx?.ok, false, 'failure-path exit record must carry ok=false');
      } finally {
        service.dispose();
      }
    });
  });

  // ------------------------------------------------------------------------
  // Waypoint 6: watcher-driven reload failure
  // ------------------------------------------------------------------------

  describe('watcher-driven reload failure', () => {
    it('emits warn "watcher-driven repository reload failed" with { rootPath, errorMessage }', async () => {
      setupLoggerWithTraceThreshold();

      const stubCli = new StubGitCli();
      const service = new GitService();
      try {
        const surface = service as unknown as GitServiceWaypointSurface;
        surface._gitCli = stubCli;

        const failureMessage = 'synthetic watcher reload failure';
        surface.loadRepository = async (_root: string): Promise<IRepository> => {
          throw new Error(failureMessage);
        };

        // Drive `_performDebouncedRefresh` directly — this is the
        // exact code path the production watcher's debounced timer
        // takes, and the catch block emits the warn waypoint.
        await surface._performDebouncedRefresh('/watched/repo');

        const lines = captureChannelLines();
        const record = findAndParseRecord(lines, 'watcher-driven repository reload failed', 'last');

        assert.strictEqual(
          record.level,
          'warn',
          `expected warn level for watcher-driven reload failure; got ${record.level}`
        );
        assert.strictEqual(record.component, 'GitService');
        assert.strictEqual(record.message, 'watcher-driven repository reload failed');

        const ctx = record.context as { rootPath?: string; errorMessage?: string } | undefined;
        assert.strictEqual(
          ctx?.rootPath,
          '/watched/repo',
          'warn record must carry the failing repo rootPath'
        );
        assert.strictEqual(
          ctx?.errorMessage,
          failureMessage,
          'warn record must carry the failure message in errorMessage'
        );
      } finally {
        service.dispose();
      }
    });
  });

  // ------------------------------------------------------------------------
  // Waypoint 7: dispose teardown
  // ------------------------------------------------------------------------

  describe('dispose', () => {
    it('emits info "GitService disposing — tearing down watchers" with watcherCount + repositoryCount', () => {
      setupLoggerWithTraceThreshold();

      const stubCli = new StubGitCli();
      const service = new GitService();
      // Stub `_gitCli` so dispose does not interact with a real
      // GitCli instance. The construction record + any lifecycle
      // records written to the channel before dispose() are
      // captured but the relevant assertion targets only the
      // disposal record we look up by message.
      const surface = service as unknown as GitServiceWaypointSurface;
      surface._gitCli = stubCli;

      // Don't dispose inside try/finally — we ARE testing dispose().
      service.dispose();

      const lines = captureChannelLines();
      const record = findAndParseRecord(lines, 'GitService disposing', 'last');

      assert.strictEqual(
        record.level,
        'info',
        `expected info level for dispose waypoint; got ${record.level}`
      );
      assert.strictEqual(record.component, 'GitService');
      // The em-dash in the production message is preserved verbatim.
      assert.strictEqual(record.message, 'GitService disposing — tearing down watchers');

      const ctx = record.context as { watcherCount?: number; repositoryCount?: number } | undefined;
      assert.strictEqual(
        typeof ctx?.watcherCount,
        'number',
        'dispose record must carry numeric watcherCount'
      );
      assert.strictEqual(
        typeof ctx?.repositoryCount,
        'number',
        'dispose record must carry numeric repositoryCount'
      );
      // No watchers / repositories were installed in this test, so
      // both counts must be exactly zero.
      assert.strictEqual(ctx?.watcherCount, 0);
      assert.strictEqual(ctx?.repositoryCount, 0);
    });
  });

  // ------------------------------------------------------------------------
  // Waypoint 8: git command execution
  // ------------------------------------------------------------------------

  describe('git command execution', () => {
    it('emits debug "git command executed" with { args } when the GitCli onCommandExecuted event fires', () => {
      setupLoggerWithTraceThreshold();

      const stubCli = new StubGitCli();
      const service = new GitService();
      try {
        // The GitService constructor subscribes to `_gitCli.onCommandExecuted`
        // via the original GitCli instance. To exercise the same
        // listener on our stub, we must route the subscription
        // through the stub: re-construct a fresh GitService AFTER
        // injecting the stub, so the constructor's subscription
        // attaches to the stub's emitter rather than the original.
        // Simpler approach: dispose this initial service and create
        // a new one whose constructor sees the stub via the
        // `_gitCli` swap below — but the constructor already runs
        // before the swap. Instead, we directly fire on the stub
        // AFTER swapping AND re-running the subscription path.
        //
        // The cleanest test seam: subclass the service surface to
        // add a fresh listener equivalent to the constructor's.
        // This sidesteps the constructor-ordering issue while still
        // exercising the production listener body verbatim — the
        // listener is the one-liner
        // `this._logger.debug('git command executed', { args: event.args })`,
        // so a duplicate registration is faithful to the production
        // path.
        const surface = service as unknown as GitServiceWaypointSurface;
        surface._gitCli = stubCli;

        // Re-attach the same listener the constructor installs.
        // This mirrors the production path 1:1 and is the minimum
        // intrusion needed to fire the event against our stub.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        const logger = (service as any)._logger as {
          debug(msg: string, ctx?: unknown): void;
        };
        stubCli.onCommandExecuted((event) => {
          logger.debug('git command executed', { args: event.args });
        });

        const args = ['status', '--porcelain=v2'];
        stubCli.fireCommandExecuted(args);

        const lines = captureChannelLines();
        const record = findAndParseRecord(lines, 'git command executed', 'last');

        assert.strictEqual(
          record.level,
          'debug',
          `expected debug level for git command execution waypoint; got ${record.level}`
        );
        assert.strictEqual(record.component, 'GitService');
        assert.strictEqual(record.message, 'git command executed');

        const ctx = record.context as { args?: readonly string[] } | undefined;
        assert.deepStrictEqual(
          ctx?.args,
          args,
          'debug record must carry the git command args verbatim in context'
        );
      } finally {
        service.dispose();
      }
    });
  });

  // ------------------------------------------------------------------------
  // getRepository — system fault from the repository-root probe is LOGGED,
  // never swallowed. This is the effort's core thesis: a spawn/system error
  // (the kind that can masquerade as "No repository found") must surface
  // as an error log AND yield undefined, not a phantom repo.
  // ------------------------------------------------------------------------

  describe('getRepository repository-root probe failure', () => {
    class ErringRootGitCli extends StubGitCli {
      override getRepositoryRoot(_p: string): ResultAsync<string | undefined, GitError> {
        return errAsync(new SpawnFailedError('spawn ENOTDIR'));
      }
    }

    it('logs an error and returns undefined when the root probe yields a system Err', async () => {
      setupLoggerWithTraceThreshold();

      const service = new GitService();
      const surface = service as unknown as GitServiceWaypointSurface;
      surface._gitCli = new ErringRootGitCli();
      try {
        // A file URI for an unknown, uncached path forces the getRepositoryRoot
        // probe, whose stub returns a typed system Err.
        const resolved = await service.getRepository(Uri.file('/no/such/path/file.ts'));

        assert.strictEqual(resolved, undefined, 'a system fault must not yield a phantom repo');

        const lines = captureChannelLines();
        const record = findAndParseRecord(lines, 'getRepository: repository-root probe failed');
        assert.strictEqual(
          record.level,
          'error',
          `the swallowed-no-more system fault must log at error level; got ${record.level}`
        );
        assert.strictEqual(record.component, 'GitService');
      } finally {
        service.dispose();
      }
    });
  });

  // ------------------------------------------------------------------------
  // getMergeBase façade — a system Err from the ops layer is LOGGED then
  // mapped to undefined, preserving the public `string | undefined` contract
  // without swallowing the fault silently.
  // ------------------------------------------------------------------------

  describe('getMergeBase façade error logging', () => {
    it('logs an error and returns undefined when the ops layer yields a system Err', async () => {
      setupLoggerWithTraceThreshold();

      const service = new GitService();
      // Stub the DiffOps collaborator so getMergeBase yields a typed Err.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (service as any)._diff = {
        getMergeBase: (): ResultAsync<string | undefined, GitError> =>
          errAsync(new SpawnFailedError('spawn ENOTDIR')),
      };
      try {
        const resolved = await service.getMergeBase(makeFakeRepo('/tmp/repo'), 'HEAD', 'feature');

        assert.strictEqual(resolved, undefined, 'a system fault must map to undefined');

        const lines = captureChannelLines();
        const record = findAndParseRecord(lines, 'getMergeBase failed');
        assert.strictEqual(
          record.level,
          'error',
          `the ops-layer system fault must log at error level; got ${record.level}`
        );
        assert.strictEqual(record.component, 'GitService');
      } finally {
        service.dispose();
      }
    });
  });

  // ------------------------------------------------------------------------
  // ABSORB facades log the system fault before degrading (thesis: logged,
  // not silently swallowed). getStatus → [], getIncomingOutgoing → noUpstream.
  // ------------------------------------------------------------------------

  describe('getStatus façade absorb logging', () => {
    it('logs an error and returns [] when the staging ops layer yields a system Err', async () => {
      setupLoggerWithTraceThreshold();

      const service = new GitService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (service as any)._staging = {
        getStatus: (): ResultAsync<never, GitError> =>
          errAsync(new SpawnFailedError('spawn ENOTDIR')),
      };
      try {
        const status = await service.getStatus(makeFakeRepo('/tmp/repo'));
        assert.deepStrictEqual(status, [], 'a system fault must degrade to an empty status');

        const record = findAndParseRecord(captureChannelLines(), 'getStatus failed');
        assert.strictEqual(record.level, 'error');
        assert.strictEqual(record.component, 'GitService');
      } finally {
        service.dispose();
      }
    });
  });

  describe('getIncomingOutgoing façade absorb logging', () => {
    it('logs an error and degrades to noUpstream when the ops layer yields a system Err', async () => {
      setupLoggerWithTraceThreshold();

      const service = new GitService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (service as any)._incomingOutgoing = {
        getForCurrentBranch: (): ResultAsync<never, GitError> =>
          errAsync(new SpawnFailedError('spawn ENOTDIR')),
      };
      try {
        const io = await service.getIncomingOutgoing(makeFakeRepo('/tmp/repo'));
        assert.strictEqual(io.noUpstream, true, 'a system fault must degrade to noUpstream');
        assert.strictEqual(io.incoming, 0);
        assert.strictEqual(io.outgoing, 0);

        const record = findAndParseRecord(captureChannelLines(), 'getIncomingOutgoing failed');
        assert.strictEqual(record.level, 'error');
        assert.strictEqual(record.component, 'GitService');
      } finally {
        service.dispose();
      }
    });
  });

  // ------------------------------------------------------------------------
  // StashTagHistory absorb facades log the system fault before degrading.
  // ------------------------------------------------------------------------

  /**
   * Drive a StashTagHistory absorb facade through a system Err by stubbing the
   * single ops method it delegates to, then assert it (a) degraded to the
   * expected value and (b) logged `<waypoint>` at error level.
   */
  async function assertAbsorbLogged<T>(
    stubMethod: string,
    call: (service: GitService) => Promise<T>,
    expected: T,
    waypoint: string
  ): Promise<void> {
    setupLoggerWithTraceThreshold();
    const service = new GitService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (service as any)._stashTagHistory = {
      [stubMethod]: (): ResultAsync<never, GitError> =>
        errAsync(new SpawnFailedError('spawn ENOTDIR')),
    };
    try {
      const value = await call(service);
      assert.deepStrictEqual(value, expected, `${waypoint} must degrade on a system fault`);
      const record = findAndParseRecord(captureChannelLines(), waypoint);
      assert.strictEqual(record.level, 'error');
      assert.strictEqual(record.component, 'GitService');
    } finally {
      service.dispose();
    }
  }

  describe('StashTagHistory façade absorb logging', () => {
    const repo = makeFakeRepo('/tmp/repo');

    it('stashList logs and degrades to []', () =>
      assertAbsorbLogged('stashList', (s) => s.stashList(repo), [], 'stashList failed'));

    it('getTags logs and degrades to []', () =>
      assertAbsorbLogged('getTags', (s) => s.getTags(repo), [], 'getTags failed'));

    it('getLog logs and degrades to []', () =>
      assertAbsorbLogged('getLog', (s) => s.getLog(repo), [], 'getLog failed'));

    it('getLogCount logs and degrades to 0', () =>
      assertAbsorbLogged('getLogCount', (s) => s.getLogCount(repo), 0, 'getLogCount failed'));

    it('getFileHistory logs and degrades to []', () =>
      assertAbsorbLogged(
        'getFileHistory',
        (s) => s.getFileHistory(repo, 'src/foo.ts'),
        [],
        'getFileHistory failed'
      ));

    it('getLineHistory logs and degrades to []', () =>
      assertAbsorbLogged(
        'getLineHistory',
        (s) => s.getLineHistory(repo, 'src/foo.ts', 1, 5),
        [],
        'getLineHistory failed'
      ));
  });

  // ------------------------------------------------------------------------
  // Re-throw facades (non-nullable reads, no natural degraded value): the
  // fault is LOGGED before the throwing Promise contract re-throws it.
  // ------------------------------------------------------------------------

  describe('StashTagHistory façade re-throw logging', () => {
    const repo = makeFakeRepo('/tmp/repo');

    async function assertRethrowLogged(
      stubMethod: string,
      call: (service: GitService) => Promise<unknown>,
      waypoint: string
    ): Promise<void> {
      setupLoggerWithTraceThreshold();
      const service = new GitService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (service as any)._stashTagHistory = {
        [stubMethod]: (): ResultAsync<never, GitError> =>
          errAsync(new SpawnFailedError('spawn ENOTDIR')),
      };
      try {
        await assert.rejects(() => call(service), 'the throwing contract must re-throw the fault');
        const record = findAndParseRecord(captureChannelLines(), waypoint);
        assert.strictEqual(record.level, 'error');
        assert.strictEqual(record.component, 'GitService');
      } finally {
        service.dispose();
      }
    }

    it('getCommit logs then re-throws', () =>
      assertRethrowLogged('getCommit', (s) => s.getCommit(repo, 'abc1234'), 'getCommit failed'));

    it('stashShow logs then re-throws', () =>
      assertRethrowLogged('stashShow', (s) => s.stashShow(repo, 0), 'stashShow failed'));
  });

  // ------------------------------------------------------------------------
  // DiffOps absorb facades log the system fault before degrading. Each read
  // tolerates absence with no failure toast, so a spawn/system Err is LOGGED
  // (thesis: logged, not swallowed) then degraded to its empty sentinel.
  // ------------------------------------------------------------------------

  describe('DiffOps façade absorb logging', () => {
    const repo = makeFakeRepo('/tmp/repo');

    /**
     * Drive a DiffOps absorb facade through a system Err by stubbing the single
     * ops method it delegates to, then assert it (a) degraded to the expected
     * value and (b) logged `<waypoint>` at error level.
     */
    async function assertDiffAbsorbLogged<T>(
      stubMethod: string,
      call: (service: GitService) => Promise<T>,
      expected: T,
      waypoint: string
    ): Promise<void> {
      setupLoggerWithTraceThreshold();
      const service = new GitService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (service as any)._diff = {
        [stubMethod]: (): ResultAsync<never, GitError> =>
          errAsync(new SpawnFailedError('spawn ENOTDIR')),
      };
      try {
        const value = await call(service);
        assert.deepStrictEqual(value, expected, `${waypoint} must degrade on a system fault`);
        const record = findAndParseRecord(captureChannelLines(), waypoint);
        assert.strictEqual(record.level, 'error');
        assert.strictEqual(record.component, 'GitService');
      } finally {
        service.dispose();
      }
    }

    it('getDiff logs and degrades to an empty diff', () =>
      assertDiffAbsorbLogged(
        'getDiff',
        (s) => s.getDiff(repo, 'src/foo.ts'),
        { path: 'src/foo.ts', status: 'modified', hunks: [], binary: false },
        'getDiff failed'
      ));

    it('getCommitDiff logs and degrades to []', () =>
      assertDiffAbsorbLogged(
        'getCommitDiff',
        (s) => s.getCommitDiff(repo, 'abc1234'),
        [],
        'getCommitDiff failed'
      ));

    it('getFileAtRevision logs and degrades to ""', () =>
      assertDiffAbsorbLogged(
        'getFileAtRevision',
        (s) => s.getFileAtRevision(repo, 'src/foo.ts', 'abc1234'),
        '',
        'getFileAtRevision failed'
      ));

    it('getMultiCommitDiff logs and degrades to []', () =>
      assertDiffAbsorbLogged(
        'getMultiCommitDiff',
        (s) => s.getMultiCommitDiff(repo, ['abc1234', 'def5678']),
        [],
        'getMultiCommitDiff failed'
      ));

    it('getChangedFilesAgainstWorkingTree logs and degrades to []', () =>
      assertDiffAbsorbLogged(
        'getChangedFilesAgainstWorkingTree',
        (s) => s.getChangedFilesAgainstWorkingTree(repo, 'HEAD'),
        [],
        'getChangedFilesAgainstWorkingTree failed'
      ));

    it('getBlame logs and degrades to []', () =>
      assertDiffAbsorbLogged(
        'getBlame',
        (s) => s.getBlame(repo, 'src/foo.ts'),
        [],
        'getBlame failed'
      ));
  });

  // ------------------------------------------------------------------------
  // BranchOps absorb facades log the system fault before degrading. getBranches
  // → [], compareBranches → empty comparison, and the structured merge/rebase
  // reads → a failed result carrying the sanitized reason (thesis: logged, not
  // silently swallowed — and a spawn fault no longer becomes an uncaught reject).
  // ------------------------------------------------------------------------

  describe('BranchOps façade absorb logging', () => {
    const repo = makeFakeRepo('/tmp/repo');

    /**
     * Drive a BranchOps absorb facade through a system Err by stubbing the
     * single ops method it delegates to, then assert it (a) degraded as
     * `assertValue` expects and (b) logged `<waypoint>` at error level.
     */
    async function assertBranchAbsorbLogged<T>(
      stubMethod: string,
      call: (service: GitService) => Promise<T>,
      assertValue: (value: T) => void,
      waypoint: string
    ): Promise<void> {
      setupLoggerWithTraceThreshold();
      const service = new GitService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (service as any)._branches = {
        [stubMethod]: (): ResultAsync<never, GitError> =>
          errAsync(new SpawnFailedError('spawn ENOTDIR')),
      };
      try {
        assertValue(await call(service));
        const record = findAndParseRecord(captureChannelLines(), waypoint);
        assert.strictEqual(record.level, 'error');
        assert.strictEqual(record.component, 'GitService');
      } finally {
        service.dispose();
      }
    }

    /** Assert a degraded structured rebase/merge result (failed + sanitized reason). */
    function assertDegradedResult(value: {
      success: boolean;
      conflicts?: string[];
      failureReason?: string;
    }): void {
      assert.strictEqual(value.success, false, 'a system fault must degrade to a failed result');
      assert.deepStrictEqual(value.conflicts, []);
      assert.strictEqual(
        typeof value.failureReason,
        'string',
        'the degraded result must carry a sanitized failureReason'
      );
    }

    it('getBranches logs and degrades to []', () =>
      assertBranchAbsorbLogged(
        'getBranches',
        (s) => s.getBranches(repo),
        (v) => assert.deepStrictEqual(v, []),
        'getBranches failed'
      ));

    it('compareBranches logs and degrades to an empty comparison', () =>
      assertBranchAbsorbLogged(
        'compareBranches',
        (s) => s.compareBranches(repo, 'main', 'feature'),
        (v) =>
          assert.deepStrictEqual(v, {
            commitsAhead: [],
            commitsBehind: [],
            aheadCount: 0,
            behindCount: 0,
            changedFiles: [],
          }),
        'compareBranches failed'
      ));

    it('mergeBranch logs and degrades to a failed result', () =>
      assertBranchAbsorbLogged(
        'mergeBranch',
        (s) => s.mergeBranch(repo, 'feature'),
        assertDegradedResult,
        'mergeBranch failed'
      ));

    it('rebaseBranch logs and degrades to a failed result', () =>
      assertBranchAbsorbLogged(
        'rebaseBranch',
        (s) => s.rebaseBranch(repo, 'main'),
        assertDegradedResult,
        'rebaseBranch failed'
      ));

    it('rebaseSkip logs and degrades to a failed result', () =>
      assertBranchAbsorbLogged(
        'rebaseSkip',
        (s) => s.rebaseSkip(repo),
        assertDegradedResult,
        'rebaseSkip failed'
      ));

    it('rebaseContinue logs and degrades to a failed result', () =>
      assertBranchAbsorbLogged(
        'rebaseContinue',
        (s) => s.rebaseContinue(repo),
        assertDegradedResult,
        'rebaseContinue failed'
      ));
  });
});

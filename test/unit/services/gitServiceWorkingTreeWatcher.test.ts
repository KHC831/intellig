/**
 * Tests for the working-tree STATUS lane: the broad `**` watcher that keeps
 * the Local Changes view live when a tracked file is edited.
 *
 * The `.git/`-internals watchers (WATCHED_GIT_PATTERNS) only fire when
 * something under `.git/` changes — staging, commits, branch switches. A plain
 * editor save touches the WORKING TREE, not `.git/`. Working-tree events can
 * only change file STATUSES — never refs, commits, or the log — so they take
 * a separate lane (ported from VS Code's git extension response policy):
 *
 *   - refresh runs behind the status-lane debounce + a hard floor between
 *     runs, and defers entirely while the window is unfocused;
 *   - the refresh fires `onDidChangeWorkingTree` (status-family consumers),
 *     NOT `onDidChangeRepository` — the graph/branch pipeline must not rerun
 *     because a build wrote a file;
 *   - gated by the `intellig.autorefresh` toggle.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitService } from '../../../src/git-core/GitService';
import {
  Uri,
  getCreatedFileSystemWatchers,
  RelativePattern,
  setWindowFocused,
} from '../../mocks/vscode';

function installFakeTimers(): { tick: (ms: number) => void; uninstall: () => void } {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let now = 0;
  let nextId = 1;
  const queue: { id: number; fireAt: number; cb: () => void }[] = [];
  (globalThis as unknown as { setTimeout: (cb: () => void, ms: number) => unknown }).setTimeout = (
    cb: () => void,
    ms: number
  ): unknown => {
    const h = { id: nextId++, fireAt: now + (ms ?? 0), cb };
    queue.push(h);
    return h.id as unknown;
  };
  (globalThis as unknown as { clearTimeout: (h: unknown) => void }).clearTimeout = (
    h: unknown
  ): void => {
    const id = typeof h === 'number' ? h : (h as { id: number } | undefined)?.id;
    const idx = queue.findIndex((q) => q.id === id);
    if (idx >= 0) {
      queue.splice(idx, 1);
    }
  };
  return {
    tick: (ms: number): void => {
      now += ms;
      for (;;) {
        const due = queue.findIndex((q) => q.fireAt <= now);
        if (due < 0) {
          break;
        }
        const [h] = queue.splice(due, 1);
        h.cb();
      }
    },
    uninstall: (): void => {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = realSet;
      (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = realClear;
      queue.length = 0;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class StubGitCli {
  async exec(): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }
  get onCommandExecuted(): () => { dispose: () => void } {
    return () => ({ dispose: () => {} });
  }
  dispose(): void {}
}

interface WatcherTestSurface {
  _gitCli: StubGitCli;
  loadRepository: (root: string) => Promise<unknown>;
  setupRepositoryWatcher: (root: string) => void;
}

function wireWatcher(service: GitService, rootPath: string): { loadCount: () => number } {
  const surface = service as unknown as WatcherTestSurface;
  surface._gitCli = new StubGitCli();
  let count = 0;
  surface.loadRepository = async (): Promise<unknown> => {
    count += 1;
    return {
      rootUri: Uri.file(rootPath),
      state: 'idle',
      head: { name: 'main', commit: 'a'.repeat(40), ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
  };
  surface.setupRepositoryWatcher(rootPath);
  return { loadCount: (): number => count };
}

function statusLaneDebounceMs(): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  return (GitService as any).STATUS_LANE_DEBOUNCE_MS as number;
}

function statusLaneFloorMs(): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  return (GitService as any).STATUS_LANE_FLOOR_MS as number;
}

describe('GitService — working-tree watcher (live Local Changes)', () => {
  const rootPath = '/tmp/repo-worktree-watch';
  let gitService: GitService;
  let timers: { tick: (ms: number) => void; uninstall: () => void };
  let baseline: number;

  beforeEach(() => {
    gitService = new GitService();
    timers = installFakeTimers();
    baseline = getCreatedFileSystemWatchers().length;
  });

  afterEach(async () => {
    timers.uninstall();
    gitService.dispose();
    setWindowFocused(true);
    await vscode.workspace.getConfiguration('intellig').update('autorefresh', undefined);
  });

  function freshWatchers(): ReturnType<typeof getCreatedFileSystemWatchers> {
    return getCreatedFileSystemWatchers().slice(baseline);
  }

  function workingTreeWatcher(): ReturnType<typeof getCreatedFileSystemWatchers>[number] {
    const w = freshWatchers().find(
      (x) => x._pattern instanceof RelativePattern && x._pattern.pattern === '**'
    );
    assert.ok(w, 'a working-tree watcher on the repo root ("**") must be installed');
    return w;
  }

  it('installs a "**" watcher rooted at the repository root', () => {
    wireWatcher(gitService, rootPath);
    const w = workingTreeWatcher();
    const base = w._pattern instanceof RelativePattern ? w._pattern.baseUri?.fsPath : undefined;
    assert.strictEqual(base, rootPath, 'working-tree watcher is rooted at the repo root');
  });

  it('a working-tree file change triggers exactly one status-lane reload', async () => {
    const probe = wireWatcher(gitService, rootPath);
    const w = workingTreeWatcher();
    w._fireChange(Uri.file(`${rootPath}/src/foo.ts`));
    assert.strictEqual(probe.loadCount(), 0, 'no synchronous reload — the refresh is debounced');
    timers.tick(statusLaneDebounceMs());
    await flushMicrotasks();
    assert.strictEqual(probe.loadCount(), 1, 'a saved working-tree file reloads the repository');
  });

  it('a working-tree change fires onDidChangeWorkingTree, never onDidChangeRepository', async () => {
    const probe = wireWatcher(gitService, rootPath);
    let repoEvents = 0;
    let workingTreeEvents = 0;
    gitService.onDidChangeRepository(() => {
      repoEvents += 1;
    });
    gitService.onDidChangeWorkingTree(() => {
      workingTreeEvents += 1;
    });

    const w = workingTreeWatcher();
    w._fireChange(Uri.file(`${rootPath}/src/foo.ts`));
    timers.tick(statusLaneDebounceMs());
    await flushMicrotasks();

    assert.strictEqual(probe.loadCount(), 1, 'the status lane reloads repo state');
    assert.strictEqual(workingTreeEvents, 1, 'status-family consumers hear about the save');
    assert.strictEqual(
      repoEvents,
      0,
      'the graph/branch pipeline must NOT rerun for a working-tree write'
    );
  });

  it('sustained working-tree events are spaced by the floor', async () => {
    const probe = wireWatcher(gitService, rootPath);
    const w = workingTreeWatcher();

    w._fireChange(Uri.file(`${rootPath}/build/a.log`));
    timers.tick(statusLaneDebounceMs());
    await flushMicrotasks();
    assert.strictEqual(probe.loadCount(), 1, 'first run after the debounce');

    // A storm during the run's floor window coalesces into ONE trailing run.
    w._fireChange(Uri.file(`${rootPath}/build/b.log`));
    w._fireChange(Uri.file(`${rootPath}/build/c.log`));
    w._fireChange(Uri.file(`${rootPath}/build/d.log`));
    await flushMicrotasks();
    assert.strictEqual(probe.loadCount(), 1, 'no run during the floor');

    timers.tick(statusLaneFloorMs());
    await flushMicrotasks();
    assert.strictEqual(probe.loadCount(), 2, 'one trailing run after the floor for the storm');
  });

  it('defers the refresh while the window is unfocused', async () => {
    const probe = wireWatcher(gitService, rootPath);
    const w = workingTreeWatcher();
    setWindowFocused(false);

    w._fireChange(Uri.file(`${rootPath}/src/foo.ts`));
    timers.tick(statusLaneDebounceMs());
    await flushMicrotasks();
    assert.strictEqual(probe.loadCount(), 0, 'an unfocused window refreshes nothing');

    setWindowFocused(true);
    await flushMicrotasks();
    assert.strictEqual(probe.loadCount(), 1, 'the pending refresh lands when focus returns');
  });

  it('ignores events under .git/ (the dedicated .git watchers own those, avoids a refresh loop)', async () => {
    const probe = wireWatcher(gitService, rootPath);
    const w = workingTreeWatcher();
    w._fireChange(Uri.file(`${rootPath}/.git/index`));
    w._fireChange(Uri.file(`${rootPath}/.git/refs/heads/main`));
    timers.tick(statusLaneDebounceMs());
    await flushMicrotasks();
    assert.strictEqual(
      probe.loadCount(),
      0,
      '.git/ churn must not retrigger through the working-tree watcher'
    );
  });

  it('does not treat a working-tree file named like ".gitignore" as a .git internal', async () => {
    const probe = wireWatcher(gitService, rootPath);
    const w = workingTreeWatcher();
    w._fireChange(Uri.file(`${rootPath}/.gitignore`));
    timers.tick(statusLaneDebounceMs());
    await flushMicrotasks();
    assert.strictEqual(probe.loadCount(), 1, 'editing .gitignore is a working-tree change');
  });

  it('does nothing when intellig.autorefresh is disabled', async () => {
    await vscode.workspace.getConfiguration('intellig').update('autorefresh', false);
    const probe = wireWatcher(gitService, rootPath);
    const w = workingTreeWatcher();
    w._fireChange(Uri.file(`${rootPath}/src/foo.ts`));
    timers.tick(statusLaneDebounceMs());
    await flushMicrotasks();
    assert.strictEqual(probe.loadCount(), 0, 'autorefresh=false suppresses working-tree refresh');
  });
});

describe('GitService — status lane defers to the ref lane (no cross-lane double reload)', () => {
  const rootPath = '/tmp/repo-lane-serialization';
  let gitService: GitService;
  let timers: { tick: (ms: number) => void; uninstall: () => void };
  let baseline: number;

  beforeEach(() => {
    gitService = new GitService();
    timers = installFakeTimers();
    baseline = getCreatedFileSystemWatchers().length;
  });

  afterEach(() => {
    timers.uninstall();
    gitService.dispose();
    setWindowFocused(true);
  });

  function watchers(): ReturnType<typeof getCreatedFileSystemWatchers> {
    return getCreatedFileSystemWatchers().slice(baseline);
  }

  function treeWatcher(): ReturnType<typeof getCreatedFileSystemWatchers>[number] {
    const w = watchers().find(
      (x) => x._pattern instanceof RelativePattern && x._pattern.pattern === '**'
    );
    assert.ok(w);
    return w;
  }

  function headWatcher(): ReturnType<typeof getCreatedFileSystemWatchers>[number] {
    const w = watchers().find(
      (x) => x._pattern instanceof RelativePattern && x._pattern.pattern === 'HEAD'
    );
    assert.ok(w, 'a HEAD watcher must be installed');
    return w;
  }

  it('a ref-lane reload in flight absorbs the status lane run entirely', async () => {
    // Hang loadRepository on a controllable promise so the .git-lane reload
    // is still in flight when the status lane's debounce fires.
    const surface = gitService as unknown as WatcherTestSurface;
    surface._gitCli = new StubGitCli();
    let loads = 0;
    let release: (() => void) | undefined;
    surface.loadRepository = (): Promise<unknown> => {
      loads += 1;
      return new Promise((resolve) => {
        release = (): void =>
          resolve({
            rootUri: Uri.file(rootPath),
            state: 'idle',
            head: { name: 'main', commit: 'a'.repeat(40), ahead: 0, behind: 0 },
            remotes: [],
            submodules: [],
          });
      });
    };
    surface.setupRepositoryWatcher(rootPath);

    let workingTreeEvents = 0;
    gitService.onDidChangeWorkingTree(() => {
      workingTreeEvents += 1;
    });

    // A checkout touches .git AND the working tree.
    headWatcher()._fireChange(Uri.file(`${rootPath}/.git/HEAD`));
    treeWatcher()._fireChange(Uri.file(`${rootPath}/src/checked-out.ts`));

    timers.tick(250); // ref lane debounce — reload 1 starts and HANGS
    await flushMicrotasks();
    assert.strictEqual(loads, 1, 'ref-lane reload in flight');

    timers.tick(1000); // status lane debounce fires while reload 1 is in flight
    await flushMicrotasks();
    assert.strictEqual(loads, 1, 'the status lane must not start a concurrent reload');

    release?.();
    await flushMicrotasks();
    timers.tick(6000); // status-lane floor drains
    await flushMicrotasks();
    assert.strictEqual(
      loads,
      1,
      'the completed ref-lane reload covers the save — no second reload'
    );
    assert.strictEqual(
      workingTreeEvents,
      0,
      'covered saves fire no working-tree event (the repository event already reached both-lane consumers)'
    );
  });

  it('a ref-lane reload that completed after the save absorbs the status lane run', async () => {
    const surface = gitService as unknown as WatcherTestSurface;
    surface._gitCli = new StubGitCli();
    let loads = 0;
    surface.loadRepository = async (): Promise<unknown> => {
      loads += 1;
      return {
        rootUri: Uri.file(rootPath),
        state: 'idle',
        head: { name: 'main', commit: 'a'.repeat(40), ahead: 0, behind: 0 },
        remotes: [],
        submodules: [],
      };
    };
    surface.setupRepositoryWatcher(rootPath);

    // Save (poke) first, then the .git event whose reload completes BEFORE
    // the status lane's slower debounce elapses.
    treeWatcher()._fireChange(Uri.file(`${rootPath}/src/pulled.ts`));
    headWatcher()._fireChange(Uri.file(`${rootPath}/.git/HEAD`));

    timers.tick(250); // ref-lane reload runs to completion
    await flushMicrotasks();
    assert.strictEqual(loads, 1);

    timers.tick(1000); // status lane fires — must notice it is already covered
    await flushMicrotasks();
    timers.tick(6000);
    await flushMicrotasks();
    assert.strictEqual(loads, 1, 'a pull/checkout must cost ONE reload, not one per lane');
  });

  it('an uncovered save still refreshes through the status lane', async () => {
    const probe = wireWatcher(gitService, rootPath);
    treeWatcher()._fireChange(Uri.file(`${rootPath}/src/plain-save.ts`));
    timers.tick(1000);
    await flushMicrotasks();
    assert.strictEqual(probe.loadCount(), 1, 'no ref activity — the lane refreshes normally');
  });
});

describe('GitService — .git/config is watched (remote set-url has no save heartbeat anymore)', () => {
  it('WATCHED_GIT_PATTERNS includes config', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const patterns = (GitService as any).WATCHED_GIT_PATTERNS as readonly string[];
    assert.ok(
      patterns.includes('config'),
      'git remote set-url writes .git/config and fires no other event; without this ' +
        'pattern the remote caches (blame links, tool-window remotes) go stale forever'
    );
  });
});

describe('GitService — the stash reflog is watched (non-top drops rewrite only logs/refs/stash)', () => {
  it('WATCHED_GIT_PATTERNS includes logs/refs/stash', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const patterns = (GitService as any).WATCHED_GIT_PATTERNS as readonly string[];
    assert.ok(
      patterns.includes('logs/refs/stash'),
      "`git stash drop 'stash@{1}'` (and stash renames) rewrite only the stash " +
        'reflog — refs/stash and index are untouched — so without this pattern no ' +
        'event fires and stash lists stay stale until an unrelated repo event'
    );
  });
});

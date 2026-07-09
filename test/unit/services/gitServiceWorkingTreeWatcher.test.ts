/**
 * Tests for the working-tree file watcher that keeps the Local Changes view
 * (and every other `onDidChangeRepository` subscriber) live when a tracked
 * file is edited.
 *
 * The `.git/`-internals watchers (WATCHED_GIT_PATTERNS) only fire when
 * something under `.git/` changes — staging, commits, branch switches. A plain
 * editor save touches the WORKING TREE, not `.git/`, so before this watcher the
 * Commit tool window stayed stale until the view was re-resolved.
 *
 * Ported from VS Code's built-in git extension: one broad watcher over the repo
 * root, events split by whether the path is inside `.git/` (those are left to
 * the dedicated `.git` watchers), the rest routed through the existing debounced
 * refresh — gated by an `intellig.autorefresh` toggle.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitService } from '../../../src/git-core/GitService';
import { Uri, getCreatedFileSystemWatchers, RelativePattern } from '../../mocks/vscode';

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

function debounceMs(): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  return (GitService as any).WATCHER_DEBOUNCE_MS as number;
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

  it('a working-tree file change triggers exactly one debounced reload', async () => {
    const probe = wireWatcher(gitService, rootPath);
    const w = workingTreeWatcher();
    w._fireChange(Uri.file(`${rootPath}/src/foo.ts`));
    assert.strictEqual(probe.loadCount(), 0, 'no synchronous reload — the refresh is debounced');
    timers.tick(debounceMs());
    await flushMicrotasks();
    assert.strictEqual(probe.loadCount(), 1, 'a saved working-tree file reloads the repository');
  });

  it('ignores events under .git/ (the dedicated .git watchers own those, avoids a refresh loop)', async () => {
    const probe = wireWatcher(gitService, rootPath);
    const w = workingTreeWatcher();
    w._fireChange(Uri.file(`${rootPath}/.git/index`));
    w._fireChange(Uri.file(`${rootPath}/.git/refs/heads/main`));
    timers.tick(debounceMs());
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
    timers.tick(debounceMs());
    await flushMicrotasks();
    assert.strictEqual(probe.loadCount(), 1, 'editing .gitignore is a working-tree change');
  });

  it('does nothing when intellig.autorefresh is disabled', async () => {
    await vscode.workspace.getConfiguration('intellig').update('autorefresh', false);
    const probe = wireWatcher(gitService, rootPath);
    const w = workingTreeWatcher();
    w._fireChange(Uri.file(`${rootPath}/src/foo.ts`));
    timers.tick(debounceMs());
    await flushMicrotasks();
    assert.strictEqual(probe.loadCount(), 0, 'autorefresh=false suppresses working-tree refresh');
  });
});

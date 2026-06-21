/**
 * Wiring test for `wireRebasePausedWarning` — pins the activation-time and
 * `onDidChangeRepository`-driven warning behavior for paused rebases.
 *
 * The bug this fixes (Bug C follow-up): a user reloading VS Code while a
 * rebase was paused (or inheriting a paused rebase from a CLI session) saw
 * no warning until they next clicked "Rebase Current onto This" from the
 * BRANCHES menu. The fix wires a per-repo warned-set, fires a toast on
 * activation for any repo already in `inProgress.kind === 'rebasing'`, and
 * re-evaluates on every `onDidChangeRepository` transition. The toast
 * routes the user to one of the three rebase recovery commands
 * (`intellig.rebase.continue` / `intellig.rebase.abort` /
 * `intellig.rebase.skip`).
 *
 * The harness mirrors `repoSelectionWiring.test.ts` — small purpose-built
 * stubs (no sinon) that record only the calls under test.
 */

import '../../setup';
import * as assert from 'assert';
import { wireRebasePausedWarning } from '../../../src/extension';
import type {
  IRebaseWarningGitService,
  IRebaseWarningToastSurface,
  IRebaseWarningCommandRunner,
} from '../../../src/extension';
import { Uri } from '../../mocks/vscode';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

/**
 * Minimal `IRepository` builder. The wiring only reads `rootUri.fsPath`
 * and `inProgress?.kind`, so the rest of the structural shape can stay
 * minimal.
 */
function createMockRepository(rootPath: string, rebasing: boolean): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: rebasing ? 'rebasing' : 'idle',
    head: undefined,
    remotes: [],
    submodules: [],
    inProgress: rebasing ? { kind: 'rebasing' } : undefined,
  } as unknown as IRepository;
}

/**
 * Stub git-service. `getRepositories()` returns a snapshot the test
 * controls. `onDidChangeRepository` registers each listener; the test
 * `fireChange(repo)` helper invokes them all.
 */
class StubGitService implements IRebaseWarningGitService {
  public repos: IRepository[] = [];
  public disposeCount = 0;
  private _listeners: Array<(repo: IRepository) => void> = [];

  getRepositories(): IRepository[] {
    return this.repos;
  }

  onDidChangeRepository = (listener: (repo: IRepository) => unknown): { dispose(): void } => {
    this._listeners.push(listener as (repo: IRepository) => void);
    return {
      dispose: (): void => {
        this.disposeCount++;
      },
    };
  };

  /** Test-only — fire onDidChangeRepository with the given repo. */
  fireChange(repo: IRepository): void {
    for (const listener of this._listeners) {
      listener(repo);
    }
  }
}

/**
 * Stub toast surface. Records every `showWarningMessage` invocation and
 * returns a configurable choice (or undefined for dismissed/Esc).
 */
class StubWindow implements IRebaseWarningToastSurface {
  public calls: Array<{ message: string; items: string[] }> = [];
  public nextChoice: string | undefined = undefined;

  showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined> {
    this.calls.push({ message, items });
    return Promise.resolve(this.nextChoice);
  }
}

/**
 * Stub command runner. Records every `executeCommand` invocation so the
 * test can assert which recovery command the toast choice routed to.
 */
class StubCommands implements IRebaseWarningCommandRunner {
  public calls: string[] = [];

  executeCommand(command: string): Thenable<unknown> {
    this.calls.push(command);
    return Promise.resolve(undefined);
  }
}

/**
 * Yield the microtask queue so fire-and-forget `void fireForRepo(repo)`
 * calls inside the wiring resolve before the test asserts.
 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('wireRebasePausedWarning — activation + onDidChangeRepository surfacing', () => {
  it('fires a warning at activation for a repo that is already in rebasing state', async () => {
    const gitService = new StubGitService();
    const win = new StubWindow();
    const commands = new StubCommands();

    gitService.repos = [createMockRepository('/workspace/foo', true)];

    wireRebasePausedWarning({ gitService, window: win, commands });
    await flushMicrotasks();

    assert.strictEqual(win.calls.length, 1, 'one warning toast expected');
    assert.ok(
      win.calls[0].message.toLowerCase().includes('rebase is paused'),
      `toast should mention paused rebase, got: "${win.calls[0].message}"`
    );
    assert.deepStrictEqual(
      win.calls[0].items,
      ['Continue', 'Abort', 'Skip Commit'],
      'toast must offer the three rebase recovery actions'
    );
  });

  it('does NOT fire a warning at activation for repos in idle state', async () => {
    const gitService = new StubGitService();
    const win = new StubWindow();
    const commands = new StubCommands();

    gitService.repos = [
      createMockRepository('/workspace/foo', false),
      createMockRepository('/workspace/bar', false),
    ];

    wireRebasePausedWarning({ gitService, window: win, commands });
    await flushMicrotasks();

    assert.strictEqual(win.calls.length, 0, 'no warning expected for idle repos');
  });

  it('fires exactly once per paused rebase even with multiple onDidChangeRepository events', async () => {
    const gitService = new StubGitService();
    const win = new StubWindow();
    const commands = new StubCommands();

    const repo = createMockRepository('/workspace/foo', true);
    gitService.repos = [repo];

    wireRebasePausedWarning({ gitService, window: win, commands });
    await flushMicrotasks();

    // Now simulate the gitService firing onDidChangeRepository several
    // times for the same paused-rebase repo (e.g. unrelated state
    // refreshes). The warned-set must suppress duplicate toasts.
    gitService.fireChange(repo);
    gitService.fireChange(repo);
    gitService.fireChange(repo);
    await flushMicrotasks();

    assert.strictEqual(
      win.calls.length,
      1,
      `expected exactly one toast across activation + 3 change events, got ${win.calls.length}`
    );
  });

  it('clears the warned-set entry when the repo transitions out of rebasing (so a future rebase re-warns)', async () => {
    const gitService = new StubGitService();
    const win = new StubWindow();
    const commands = new StubCommands();

    const pausedRepo = createMockRepository('/workspace/foo', true);
    gitService.repos = [pausedRepo];

    wireRebasePausedWarning({ gitService, window: win, commands });
    await flushMicrotasks();
    assert.strictEqual(win.calls.length, 1, 'first toast at activation');

    // Simulate the user resolving the rebase: the same repo (by path)
    // now reports inProgress = undefined.
    const idleRepo = createMockRepository('/workspace/foo', false);
    gitService.fireChange(idleRepo);
    await flushMicrotasks();
    assert.strictEqual(win.calls.length, 1, 'no toast when transitioning out of rebasing');

    // Simulate a brand-new rebase starting on the same repo.
    const pausedAgain = createMockRepository('/workspace/foo', true);
    gitService.fireChange(pausedAgain);
    await flushMicrotasks();
    assert.strictEqual(
      win.calls.length,
      2,
      'second toast expected: warned-set was cleared by the idle transition'
    );
  });

  it('routes the "Continue" toast choice to intellig.rebase.continue', async () => {
    const gitService = new StubGitService();
    const win = new StubWindow();
    const commands = new StubCommands();

    win.nextChoice = 'Continue';
    gitService.repos = [createMockRepository('/workspace/foo', true)];

    wireRebasePausedWarning({ gitService, window: win, commands });
    await flushMicrotasks();

    assert.deepStrictEqual(commands.calls, ['intellig.rebase.continue']);
  });

  it('routes the "Abort" toast choice to intellig.rebase.abort', async () => {
    const gitService = new StubGitService();
    const win = new StubWindow();
    const commands = new StubCommands();

    win.nextChoice = 'Abort';
    gitService.repos = [createMockRepository('/workspace/foo', true)];

    wireRebasePausedWarning({ gitService, window: win, commands });
    await flushMicrotasks();

    assert.deepStrictEqual(commands.calls, ['intellig.rebase.abort']);
  });

  it('routes the "Skip Commit" toast choice to intellig.rebase.skip', async () => {
    const gitService = new StubGitService();
    const win = new StubWindow();
    const commands = new StubCommands();

    win.nextChoice = 'Skip Commit';
    gitService.repos = [createMockRepository('/workspace/foo', true)];

    wireRebasePausedWarning({ gitService, window: win, commands });
    await flushMicrotasks();

    assert.deepStrictEqual(commands.calls, ['intellig.rebase.skip']);
  });

  it('does not execute any command when the toast is dismissed (Esc)', async () => {
    const gitService = new StubGitService();
    const win = new StubWindow();
    const commands = new StubCommands();

    win.nextChoice = undefined;
    gitService.repos = [createMockRepository('/workspace/foo', true)];

    wireRebasePausedWarning({ gitService, window: win, commands });
    await flushMicrotasks();

    assert.strictEqual(win.calls.length, 1, 'toast still fires');
    assert.deepStrictEqual(commands.calls, [], 'no command executed on dismissal');
  });

  it('returns a disposable that tears down the onDidChangeRepository subscription', () => {
    const gitService = new StubGitService();
    const win = new StubWindow();
    const commands = new StubCommands();

    const disposables = wireRebasePausedWarning({ gitService, window: win, commands });

    assert.strictEqual(disposables.length, 1, 'one disposable returned');
    for (const d of disposables) {
      d.dispose();
    }
    assert.strictEqual(
      gitService.disposeCount,
      1,
      'onDidChangeRepository subscription must be disposed (no leak on extension deactivation)'
    );
  });
});

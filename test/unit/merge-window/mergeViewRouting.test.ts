import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { MergeView } from '../../../src/conflicts/MergeView';
import type { MergeWindowPanel } from '../../../src/conflicts/merge-window/MergeWindowPanel';
import { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { resetMockConfiguration, setMockConfigValue } from '../../mocks/vscode';

function fakeRepo(root: string): IRepository {
  return { rootUri: vscode.Uri.file(root) } as IRepository;
}

function fakeGitService(repo: IRepository): IGitService {
  return {
    getRepository: () => Promise.resolve(repo),
    getRepositories: () => [repo],
    // The merge-window path requires a GitCli to load index stages; the
    // routing gate checks for its presence.
    gitCli: {},
  } as unknown as IGitService;
}

/** MergeView with both open paths stubbed so only the routing is observed. */
class RoutingProbe extends MergeView {
  openedWindow = 0;
  openedNative = 0;
  injected = 0;

  protected override async _openMergeWindow(): Promise<void> {
    this.openedWindow++;
  }

  protected override async _openNativeMergeEditor(): Promise<void> {
    this.openedNative++;
  }

  protected override async _injectSyntheticBase(): Promise<void> {
    this.injected++;
  }
}

describe('MergeView merge-window routing', () => {
  afterEach(() => {
    resetMockConfiguration();
  });

  function build(): RoutingProbe {
    const repo = fakeRepo('/repo');
    return new RoutingProbe(vscode.Uri.file('/ext'), fakeGitService(repo), {
      context: { extensionUri: vscode.Uri.file('/ext') } as vscode.ExtensionContext,
      getConflictContext: () => Promise.resolve({ stageNames: {}, operation: undefined }),
    });
  }

  it('routes to the merge window by default, without touching the index', async () => {
    const view = build();
    await view.show('/repo/a.txt');
    assert.strictEqual(view.openedWindow, 1);
    assert.strictEqual(view.openedNative, 0);
    // The merge window handles a missing base in memory (IntelliJ's
    // loadMergeData fallback) — opening it must not write the index.
    assert.strictEqual(view.injected, 0);
  });

  it('routes to the native merge editor when the window is disabled, injecting a synthetic base', async () => {
    setMockConfigValue('intellig', 'mergeWindow.enabled', false);
    const view = build();
    await view.show('/repo/a.txt');
    assert.strictEqual(view.openedNative, 1);
    assert.strictEqual(view.openedWindow, 0);
    // The native editor reads stages from the index, so add/add needs the
    // synthetic stage-1 written there.
    assert.strictEqual(view.injected, 1);
  });

  describe('conflict-context probe failures', () => {
    /**
     * The probe decides which side is "Yours". Guessing forward after a failed
     * probe paints the other side's content under the user's own label during
     * a rebase, so the window must not open on an unresolved probe.
     */
    function buildWithProbe(
      probe: () => Promise<{
        stageNames: Record<string, string>;
        operation: string | undefined;
      }>
    ): {
      view: MergeView & { panels: number };
      toasts: string[];
      restore: () => void;
    } {
      const repo = fakeRepo('/repo');
      const toasts: string[] = [];
      const originalError = vscode.window.showErrorMessage;
      (vscode.window as { showErrorMessage: unknown }).showErrorMessage = (
        message: string
      ): Thenable<string | undefined> => {
        toasts.push(message);
        return Promise.resolve(undefined);
      };
      const view = new (class extends MergeView {
        panels = 0;
        protected override _createMergeWindowPanel(): MergeWindowPanel {
          this.panels++;
          return {
            reveal: (): void => {},
            dispose: (): void => {},
            onDidDispose: (): vscode.Disposable => ({ dispose: (): void => {} }),
          } as unknown as MergeWindowPanel;
        }
      })(vscode.Uri.file('/ext'), fakeGitService(repo), {
        context: { extensionUri: vscode.Uri.file('/ext') } as vscode.ExtensionContext,
        getConflictContext: probe as never,
      });
      return {
        view: view as MergeView & { panels: number },
        toasts,
        restore: (): void => {
          (vscode.window as { showErrorMessage: unknown }).showErrorMessage = originalError;
        },
      };
    }

    it('does not open the window and toasts once when the probe keeps failing', async () => {
      let calls = 0;
      const { view, toasts, restore } = buildWithProbe(() => {
        calls++;
        return Promise.reject(new Error('git rev-parse failed'));
      });
      try {
        await view.show('/repo/a.txt');

        assert.strictEqual(view.panels, 0, 'no merge window may open');
        assert.strictEqual(calls, 2, 'the probe is retried once before giving up');
        assert.strictEqual(toasts.length, 1, 'exactly one error toast');
      } finally {
        restore();
      }
    });

    it('opens when the retry succeeds', async () => {
      let calls = 0;
      const { view, toasts, restore } = buildWithProbe(() => {
        calls++;
        return calls === 1
          ? Promise.reject(new Error('transient'))
          : Promise.resolve({ stageNames: {}, operation: undefined });
      });
      try {
        await view.show('/repo/a.txt');

        assert.strictEqual(view.panels, 1, 'a recovered probe proceeds to open the window');
        assert.strictEqual(toasts.length, 0, 'a recovered probe raises no toast');
      } finally {
        restore();
      }
    });
  });

  describe('window reuse across a re-conflicting path', () => {
    /**
     * A multi-commit rebase can conflict on the same path twice. The second
     * conflict carries different index stages, so the first window's content
     * is stale — revealing it would let Apply write commit N-1's merged text
     * over commit N's conflict.
     */
    function buildWithStages(shaFor: () => string): {
      view: MergeView;
      created: Array<{ disposed: boolean; reveals: number }>;
    } {
      const repo = fakeRepo('/repo');
      const created: Array<{ disposed: boolean; reveals: number }> = [];
      const gitCli = {
        exec: (args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
          if (args[0] === 'ls-files') {
            const sha = shaFor();
            // '' means the path carries NO unmerged entries any more, which is
            // a different fact from the index being unreadable (a throw).
            const stdout =
              sha === ''
                ? ''
                : [1, 2, 3]
                    .map((stage) => `100644 ${sha.repeat(40).slice(0, 40)} ${stage}\ta.txt\0`)
                    .join('');
            return Promise.resolve({ exitCode: 0, stdout, stderr: '' });
          }
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        },
      };
      const gitService = {
        getRepository: () => Promise.resolve(repo),
        getRepositories: () => [repo],
        gitCli,
      } as unknown as IGitService;
      const view = new (class extends MergeView {
        protected override _createMergeWindowPanel(): MergeWindowPanel {
          const entry = { disposed: false, reveals: 0 };
          created.push(entry);
          return {
            reveal: (): void => {
              entry.reveals++;
            },
            dispose: (): void => {
              entry.disposed = true;
            },
            onDidDispose: (): vscode.Disposable => ({ dispose: (): void => {} }),
          } as unknown as MergeWindowPanel;
        }
      })(vscode.Uri.file('/ext'), gitService, {
        context: { extensionUri: vscode.Uri.file('/ext') } as vscode.ExtensionContext,
        getConflictContext: () => Promise.resolve({ stageNames: {}, operation: undefined }),
      });
      return { view, created };
    }

    it('reveals the existing window while the stages are unchanged', async () => {
      const { view, created } = buildWithStages(() => 'a');
      await view.show('/repo/a.txt');
      await view.show('/repo/a.txt');

      assert.strictEqual(created.length, 1, 'the same conflict reuses its window');
      assert.strictEqual(created[0].reveals, 1, 'the second show reveals it');
    });

    it('never reveals a stale window once the path is no longer conflicted', async () => {
      // Resolved elsewhere (bulk accept, palette, terminal): the open window
      // holds the OLD content, so revealing it would let its Apply overwrite
      // the resolution — the very corruption the identity key prevents.
      let sha = 'a';
      const { view, created } = buildWithStages(() => sha);
      await view.show('/repo/a.txt');
      assert.strictEqual(created.length, 1);

      sha = '';
      await view.show('/repo/a.txt');

      assert.strictEqual(created[0].reveals, 0, 'the stale window must not be revealed');
      assert.strictEqual(created[0].disposed, true, 'it must not outlive the conflict either');
    });

    it('never disposes a live window when the stage probe fails', async () => {
      // A transient index lock makes the identity unreadable. Declining reuse
      // is right; destroying the window the user is working in is not — its
      // unsaved resolution would be gone, and the reopened window is a
      // text-only restored session.
      let fail = false;
      const { view, created } = buildWithStages(() => {
        if (fail) {
          throw new Error('index.lock');
        }
        return 'a';
      });
      await view.show('/repo/a.txt');
      assert.strictEqual(created.length, 1);

      fail = true;
      await view.show('/repo/a.txt');

      assert.strictEqual(created[0].disposed, false, 'the live window must survive');
      // Re-checked AFTER the failing show: a regression that opened a second
      // window instead of revealing the first would otherwise pass.
      assert.strictEqual(created.length, 1, 'no duplicate window is opened');
      assert.strictEqual(created[0].reveals, 1, 'the existing window is revealed instead');
    });

    it('builds a fresh window when the path re-conflicts with new stages', async () => {
      let sha = 'a';
      const { view, created } = buildWithStages(() => sha);
      await view.show('/repo/a.txt');
      sha = 'b';
      await view.show('/repo/a.txt');

      assert.strictEqual(created.length, 2, 'a changed conflict must not hit the cache');
      assert.strictEqual(created[0].reveals, 0, 'the stale window is never revealed');
      // Disposing the superseded window is the half that prevents its Apply
      // from writing the earlier conflict's content over the new one.
      assert.strictEqual(created[0].disposed, true, 'the stale window is disposed');
      assert.strictEqual(created[1].disposed, false, 'the new window stays open');
    });
  });

  describe('markResolved after a window closes unapplied', () => {
    /**
     * Closing the window via Abort leaves the file conflicted. The tracking
     * entry must go with it: otherwise the sole-entry fallback in
     * markResolved() stages a file that still holds conflict markers.
     */
    function build(): {
      view: MergeView;
      staged: string[][];
      disposeHandlers: Array<() => void>;
      applied: Array<(relPath: string) => void>;
    } {
      const repo = fakeRepo('/repo');
      const staged: string[][] = [];
      const disposeHandlers: Array<() => void> = [];
      const applied: Array<(relPath: string) => void> = [];
      const gitCli = {
        exec: (args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
          Promise.resolve(
            args[0] === 'ls-files'
              ? {
                  exitCode: 0,
                  stdout: [1, 2, 3].map((s) => `100644 ${'a'.repeat(40)} ${s}\ta.txt\0`).join(''),
                  stderr: '',
                }
              : { exitCode: 0, stdout: '', stderr: '' }
          ),
      };
      const gitService = {
        getRepository: () => Promise.resolve(repo),
        getRepositories: () => [repo],
        gitCli,
        // The file is STILL conflicted after the abort, so the prune keeps it.
        getStatus: () =>
          Promise.resolve([{ path: 'a.txt', indexStatus: 'U', workTreeStatus: 'U' }]),
        stage: (_repo: IRepository, paths: string[]) => ({
          match: <T>(okFn: () => T): Promise<T> => {
            staged.push(paths);
            return Promise.resolve(okFn());
          },
        }),
      } as unknown as IGitService;
      const view = new (class extends MergeView {
        protected override _createMergeWindowPanel(
          _context: vscode.ExtensionContext,
          opts: { onApplied: (relPath: string) => void }
        ): MergeWindowPanel {
          applied.push(opts.onApplied);
          return {
            reveal: (): void => {},
            dispose: (): void => {},
            onDidDispose: (handler: () => void): vscode.Disposable => {
              disposeHandlers.push(handler);
              return { dispose: (): void => {} };
            },
          } as unknown as MergeWindowPanel;
        }
      })(vscode.Uri.file('/ext'), gitService, {
        context: { extensionUri: vscode.Uri.file('/ext') } as vscode.ExtensionContext,
        getConflictContext: () => Promise.resolve({ stageNames: {}, operation: undefined }),
      });
      return { view, staged, disposeHandlers, applied };
    }

    it('stages nothing after the window is closed without applying', async () => {
      const { view, staged, disposeHandlers } = build();
      await view.show('/repo/a.txt');
      disposeHandlers.forEach((h) => h());

      await view.markResolved();
      assert.deepStrictEqual(staged, [], 'an aborted merge must never be staged');
    });

    it('still stages the file while its window is open', async () => {
      const { view, staged } = build();
      await view.show('/repo/a.txt');

      await view.markResolved();
      assert.deepStrictEqual(staged, [['a.txt']]);
    });
  });

  it('falls back to the native editor when deps are missing', async () => {
    const repo = fakeRepo('/repo');
    const view = new (class extends MergeView {
      openedNative = 0;
      protected override async _openNativeMergeEditor(): Promise<void> {
        this.openedNative++;
      }
    })(vscode.Uri.file('/ext'), fakeGitService(repo));
    await view.show('/repo/a.txt');
    assert.strictEqual(view.openedNative, 1);
  });
});

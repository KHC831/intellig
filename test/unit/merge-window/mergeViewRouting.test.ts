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

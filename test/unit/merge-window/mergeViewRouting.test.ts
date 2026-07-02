import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { MergeView } from '../../../src/conflicts/MergeView';
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
      getSideNames: () => Promise.resolve({}),
    });
  }

  it('routes to the native merge editor by default, injecting a synthetic base', async () => {
    const view = build();
    await view.show('/repo/a.txt');
    assert.strictEqual(view.openedNative, 1);
    assert.strictEqual(view.openedWindow, 0);
    // The native editor reads stages from the index, so add/add needs the
    // synthetic stage-1 written there.
    assert.strictEqual(view.injected, 1);
  });

  it('routes to the merge window when intellig.mergeWindow.enabled is on', async () => {
    setMockConfigValue('intellig', 'mergeWindow.enabled', true);
    const view = build();
    await view.show('/repo/a.txt');
    assert.strictEqual(view.openedWindow, 1);
    assert.strictEqual(view.openedNative, 0);
    // The merge window handles a missing base in memory (IntelliJ's
    // loadMergeData fallback) — opening it must not write the index.
    assert.strictEqual(view.injected, 0);
  });

  it('falls back to the native editor when the flag is on but deps are missing', async () => {
    setMockConfigValue('intellig', 'mergeWindow.enabled', true);
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

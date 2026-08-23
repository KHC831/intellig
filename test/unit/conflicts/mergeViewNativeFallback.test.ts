/**
 * The native merge editor is contributed by the BUILT-IN Git extension, which
 * some IntelliG users disable (MergeView's own scheme note says so). With
 * `intellig.mergeWindow.enabled` off, a conflicted file therefore reached
 * `git.openMergeEditor`, got a command-not-found rejection, and the user who
 * asked for a merge surface got a toast and nothing opened.
 *
 * The bundled window needs no other extension, so it is the fallback.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Uri, resetMockConfiguration, setMockConfigValue } from '../../mocks/vscode';
import { MergeView } from '../../../src/conflicts/MergeView';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';

/** A MergeView whose two terminal surfaces are observable. */
class ProbeMergeView extends MergeView {
  public windowOpened = 0;
  public nativeAttempts = 0;
  public nativeThrows = true;

  protected override async _openNativeMergeEditor(): Promise<void> {
    this.nativeAttempts++;
    if (this.nativeThrows) {
      throw new Error("command 'git.openMergeEditor' not found");
    }
  }

  protected override async _openMergeWindow(): Promise<void> {
    this.windowOpened++;
  }

  protected override async _injectSyntheticBase(): Promise<void> {
    /* index writes are out of scope here */
  }
}

describe('merge view: native editor unavailable', () => {
  let root: string;

  beforeEach(() => {
    // The scenario IS the setting being off: the user chose the native editor,
    // and the extension contributing it is not installed.
    resetMockConfiguration();
    setMockConfigValue('intellig', 'mergeWindow.enabled', false);
    root = fs.mkdtempSync(path.join(process.cwd(), 'workspace-notes/tmp/mergeview-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'conflicted\n');
  });

  // The mock configuration store is process-wide: leaving mergeWindow.enabled
  // false here routes every later suite down the native path.
  afterEach(() => {
    resetMockConfiguration();
  });

  function makeView(withWindowDeps: boolean): ProbeMergeView {
    const repo = { rootUri: Uri.file(root) } as unknown as IRepository;
    const gitService = {
      getRepository: async () => repo,
      getRepositories: () => [repo],
      gitCli: {},
    } as unknown as IGitService;
    return new ProbeMergeView(
      Uri.file('/ext'),
      gitService,
      withWindowDeps ? ({} as never) : undefined
    );
  }

  it('falls back to the bundled merge window when the native editor is missing', async () => {
    const view = makeView(true);
    await view.show(path.join(root, 'a.txt'));
    assert.strictEqual(view.nativeAttempts, 1, 'the native editor is still tried first');
    assert.strictEqual(view.windowOpened, 1, 'the bundled window opens instead of nothing');
  });

  it('still surfaces the failure when there is no window to fall back to', async () => {
    const view = makeView(false);
    await assert.rejects(
      () => view.show(path.join(root, 'a.txt')),
      /openMergeEditor/,
      'without the bundled window the original failure must still reach the caller'
    );
  });

  it('does not open the window when the native editor works', async () => {
    const view = makeView(true);
    view.nativeThrows = false;
    await view.show(path.join(root, 'a.txt'));
    assert.strictEqual(view.windowOpened, 0, 'no fallback on the happy path');
  });
});

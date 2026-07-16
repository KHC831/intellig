/**
 * intellig.showGitConsole routing — reference parity (F-A3).
 *
 * IntelliJ's console IS a tab of the VCS tool window
 * (VcsConsoleTabService.kt; ShowVcsConsoleTabAction selects it). The command
 * must reveal the tool window and select OUR Console tab — the reference
 * analog we already ship — with the raw OutputChannel kept only as the
 * no-provider fallback.
 */

import '../../setup';
import * as assert from 'assert';
import { runShowGitConsole } from '../../../src/registration/registerViews';

describe('runShowGitConsole — Console tab routing (F-A3)', () => {
  it('reveals the log host and focuses the Console tab when the provider is up', async () => {
    const calls: string[] = [];
    const provider = {
      revealLogHost: async () => {
        calls.push('reveal');
      },
      focusTab: async (tab: string) => {
        calls.push(`focus:${tab}`);
      },
    };

    await runShowGitConsole(provider, () => calls.push('outputChannel'));

    assert.deepStrictEqual(
      calls,
      ['reveal', 'focus:console'],
      'the tool-window Console tab is the reference-analog surface'
    );
  });

  it('falls back to the OutputChannel when no provider is available', async () => {
    const calls: string[] = [];

    await runShowGitConsole(undefined, () => calls.push('outputChannel'));

    assert.deepStrictEqual(calls, ['outputChannel']);
  });
});

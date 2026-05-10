/**
 * R6 Gap-A — Extension Host smoke suite launcher.
 *
 * Runs a tiny, dedicated Mocha suite inside a real VS Code Extension Host via
 * `@vscode/test-electron`. Distinct from `src/test/runTest.ts` (which points at
 * `src/test/suite/index` and picks up every `.test.js` under `src/test/`) — this
 * launcher wires only the five smoke specs in `src/test/ext-host/suite/`:
 *
 *   1. activate          — extension activates; every declared command is
 *                          registered exactly once (catches C-1 duplicate
 *                          registerCommand regressions).
 *   2. openGitToolWindow — tool window resolves; webview HTML has CSP + nonce.
 *   3. openDialog        — smallest webview panel (NewBranchDialog) creates,
 *                          has CSP + nonce, disposes cleanly.
 *   4. toggleFlag        — flip `intellig.useCommitToolWindow` and
 *                          `intellig.useTabbedGitToolWindow` off→on→off without
 *                          any activation re-crash.
 *   5. deactivate        — extension deactivates; no throws; disposables run.
 *
 * These tests exercise the real extension host; no mocks. Activation bugs that
 * the unit-test mocks would silently paper over (last-writer-wins on
 * `registerCommand`) surface here.
 */

import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    // Repo root — the folder containing the extension manifest (package.json).
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');

    // Compiled suite loader. `tsc` emits this alongside the launcher.
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // Disable other extensions so they don't interfere with activation or
      // command registration counts. `--disable-workspace-trust` bypasses the
      // "Do you trust the authors" gate that otherwise stalls the host.
      launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
    });
  } catch (err) {
    console.error('Extension host smoke suite failed:', err);
    process.exit(1);
  }
}

void main();

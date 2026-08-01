/**
 * Tier-2 command E2E suite launcher.
 *
 * Distinct from the R6 Gap-A ext-host smoke suite (`test/ext-host/`) and
 * from the unit/property harnesses that run in-process. This launcher boots
 * a real VS Code Extension Host with an empty sentinel workspace folder, and
 * every test swaps in its own fixture via `updateWorkspaceFolders` to keep
 * the ~20-30 command specs isolated without paying the cost of a fresh host
 * per test.
 *
 * Wall-time budget: < 90s total. See `suite/index.ts` for the per-spec Mocha
 * budget.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';
import { VSCODE_TEST_VERSION } from '../support/vscodeVersion';

async function main(): Promise<void> {
  let tempWorkspace: string | undefined;
  let userDataDir: string | undefined;
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // An empty scratch folder to serve as the initial workspace. The
    // individual tests swap their own fixtures in via
    // `updateWorkspaceFolders` — this sentinel only exists so VS Code boots
    // with a workspace at all (activation-on-startup is tied to having one).
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-e2e-init-'));

    // VS Code opens its main IPC socket inside the user-data dir, and a unix
    // socket path caps at 103 characters. The default sits under the checkout,
    // which overflows from a worktree (`workspace-notes/worktrees/<name>/…` is
    // ~118 chars) and kills the launch with EINVAL before any spec runs. A
    // short root keeps the lane runnable from every checkout; unique per run so
    // a stale or parallel run cannot claim the same socket.
    // os.tmpdir() despite the workspace-notes/tmp rule: this is HOST scratch
    // for the editor process, not test data, and it must stay short enough to
    // fit the socket limit from any worktree — which workspace-notes/tmp cannot.
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-e2e-'));

    const exitCode = await runTests({
      version: VSCODE_TEST_VERSION,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        tempWorkspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        `--user-data-dir=${userDataDir}`,
      ],
    });

    if (typeof exitCode === 'number' && exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (err) {
    console.error('Tier-2 E2E suite failed:', err);
    process.exit(1);
  } finally {
    for (const scratch of [tempWorkspace, userDataDir]) {
      if (scratch) {
        try {
          fs.rmSync(scratch, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    }
  }
}

void main();

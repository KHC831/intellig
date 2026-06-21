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

async function main(): Promise<void> {
  let tempWorkspace: string | undefined;
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // An empty scratch folder to serve as the initial workspace. The
    // individual tests swap their own fixtures in via
    // `updateWorkspaceFolders` — this sentinel only exists so VS Code boots
    // with a workspace at all (activation-on-startup is tied to having one).
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-e2e-init-'));

    const exitCode = await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [tempWorkspace, '--disable-extensions', '--disable-workspace-trust'],
    });

    if (typeof exitCode === 'number' && exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (err) {
    console.error('Tier-2 E2E suite failed:', err);
    process.exit(1);
  } finally {
    if (tempWorkspace) {
      try {
        fs.rmSync(tempWorkspace, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}

void main();

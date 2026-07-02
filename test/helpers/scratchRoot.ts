/**
 * The shared test-scratch root (gitignored `workspace-notes/tmp`) and its
 * self-healing sweep. Real-git tests create their repos under this root; each
 * cleans up in `afterEach`, but an interrupted run (killed process, crashed
 * suite) never reaches that hook and leaks the dir — which the extension's
 * repo discovery then lists as a workspace repository.
 *
 * Registered as a mocha global fixture via `.mocharc.json` `require`, so every
 * mocha lane (unit + property) empties the root once before the run (healing
 * whatever a previous interrupted run leaked) and once after (leaving the
 * workspace clean). Runs once per process, not per test, so it can never
 * delete a live test's scratch dir mid-suite.
 */

import * as fs from 'fs';
import * as path from 'path';

/** `<repo>/workspace-notes/tmp` — the only place tests may create scratch dirs. */
export const SCRATCH_ROOT = path.resolve(__dirname, '../../workspace-notes/tmp');

/**
 * Empty the scratch root (removing every entry, keeping — and if needed
 * creating — the root itself). Guarded to only ever sweep a
 * `workspace-notes/tmp` path, so a bad resolution can't delete real files.
 */
export function cleanScratchRoot(root: string = SCRATCH_ROOT): void {
  if (path.basename(root) !== 'tmp' || path.basename(path.dirname(root)) !== 'workspace-notes') {
    throw new Error(`refusing to sweep ${root}: not a workspace-notes/tmp directory`);
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
}

/** Mocha global fixture: heal leaks from a previous interrupted run. */
export function mochaGlobalSetup(): void {
  cleanScratchRoot();
}

/** Mocha global fixture: leave the workspace clean after the run. */
export function mochaGlobalTeardown(): void {
  cleanScratchRoot();
}

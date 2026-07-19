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
 * Errno codes that mean "something wrote into the tree while we were deleting
 * it" rather than "this delete cannot succeed" — Finder recreating .DS_Store
 * inside a directory the recursive delete has already walked is the case that
 * actually killed a run. Worth exactly one retry; anything else is a real fault.
 */
const TRANSIENT_SWEEP_CODES = new Set(['ENOTEMPTY', 'EBUSY']);

/**
 * Empty the scratch root (removing every entry, keeping — and if needed
 * creating — the root itself). Guarded to only ever sweep a
 * `workspace-notes/tmp` path, so a bad resolution can't delete real files.
 *
 * Retries once on a concurrent-write errno so an OS process touching the tree
 * mid-sweep can't fail the whole suite; a second failure propagates.
 */
export function cleanScratchRoot(
  root: string = SCRATCH_ROOT,
  // Injected so the retry can be fault-tested: `fs.rmSync` is a
  // non-configurable module property, so it cannot be stubbed in place.
  removeTree: (target: string) => void = defaultRemoveTree
): void {
  if (path.basename(root) !== 'tmp' || path.basename(path.dirname(root)) !== 'workspace-notes') {
    throw new Error(`refusing to sweep ${root}: not a workspace-notes/tmp directory`);
  }
  try {
    removeTree(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined || !TRANSIENT_SWEEP_CODES.has(code)) {
      throw error;
    }
    removeTree(root);
  }
  fs.mkdirSync(root, { recursive: true });
}

function defaultRemoveTree(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

/** Mocha global fixture: heal leaks from a previous interrupted run. */
export function mochaGlobalSetup(): void {
  cleanScratchRoot();
}

/** Mocha global fixture: leave the workspace clean after the run. */
export function mochaGlobalTeardown(): void {
  cleanScratchRoot();
}

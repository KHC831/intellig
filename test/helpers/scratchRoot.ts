/**
 * The shared test-scratch base (gitignored `workspace-notes/tmp`) and its
 * self-healing sweep. Real-git tests create their repos under
 * {@link SCRATCH_ROOT}; each cleans up in `afterEach`, but an interrupted run
 * (killed process, crashed suite) never reaches that hook and leaks the dir —
 * which the extension's repo discovery then lists as a workspace repository.
 *
 * Every mocha lane on the checkout runs the sweep, and lanes overlap: a dev
 * running one file while `npm test` is going, two agents in a shared tree, a
 * property lane beside a unit lane. So the sweep must never empty the base
 * wholesale — that deletes a live fixture out from under another process, and
 * lands as a bewildering ENOENT inside whichever real-git suite was mid-flight.
 * Each process therefore owns `workspace-notes/tmp/<pid>` and reclaims only
 * directories whose owning process is gone.
 */

import * as fs from 'fs';
import * as path from 'path';

/** `<repo>/workspace-notes/tmp` — the only tree tests may create scratch dirs in. */
export const SCRATCH_BASE = path.resolve(__dirname, '../../workspace-notes/tmp');

/** This process's own scratch dir. Tests create their fixtures in here. */
export const SCRATCH_ROOT = path.join(SCRATCH_BASE, String(process.pid));

/**
 * Errno codes that mean "something wrote into the tree while we were deleting
 * it" rather than "this delete cannot succeed" — Finder recreating .DS_Store
 * inside a directory the recursive delete has already walked is the case that
 * actually killed a run. Worth exactly one retry; anything else is a real fault.
 */
const TRANSIENT_SWEEP_CODES = new Set(['ENOTEMPTY', 'EBUSY']);

/**
 * A pid-named root older than this is reclaimed even if something is running
 * under that pid: pids are recycled, so a leaked root can be adopted by an
 * unrelated long-lived process and would otherwise never be swept. Far longer
 * than any test run, so it cannot reach a live lane's fixtures.
 */
const STALE_ROOT_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a process id is still running, so its scratch dir may be live.
 * `kill` is injected (defaulting to the real `process.kill`) so the EPERM
 * arm — "the pid exists, owned by someone else" — can be fault-tested
 * without depending on a real other-owned process existing in whatever
 * environment the suite runs in.
 */
function pidIsAlive(
  pid: number,
  kill: (pid: number, signal: 0) => void = (p, s) => process.kill(p, s)
): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * @internal Production code MUST NOT call this — it exists only so the test
 * suite can inject a scripted `kill` and exercise pidIsAlive's EPERM/ESRCH
 * arms deterministically.
 */
export function __pidIsAliveForTest(pid: number, kill: (pid: number, signal: 0) => void): boolean {
  return pidIsAlive(pid, kill);
}

/** Whether `dir` was last touched long enough ago that no run still owns it. */
function isStale(dir: string, now: number): boolean {
  try {
    return now - fs.statSync(dir).mtimeMs > STALE_ROOT_MS;
  } catch {
    // Unreadable: leave it to the liveness check rather than guessing.
    return false;
  }
}

function removeWithRetry(target: string, removeTree: (t: string) => void): void {
  try {
    removeTree(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined || !TRANSIENT_SWEEP_CODES.has(code)) {
      throw error;
    }
    removeTree(target);
  }
}

/**
 * Reclaim abandoned scratch dirs under `base`, then (re)create this process's
 * own. Only entries no live process owns are removed: a numerically-named dir
 * whose pid is gone, or anything not named for a pid at all (a leak from
 * before the per-process layout). Guarded to only ever sweep a
 * `workspace-notes/tmp` path, so a bad resolution can't delete real files.
 *
 * Retries once per entry on a concurrent-write errno so an OS process touching
 * the tree mid-sweep can't fail the whole suite; a second failure propagates.
 */
export function cleanScratchRoot(
  base: string = SCRATCH_BASE,
  // Injected so the retry can be fault-tested: `fs.rmSync` is a
  // non-configurable module property, so it cannot be stubbed in place.
  removeTree: (target: string) => void = defaultRemoveTree,
  own: string = SCRATCH_ROOT
): void {
  if (path.basename(base) !== 'tmp' || path.basename(path.dirname(base)) !== 'workspace-notes') {
    throw new Error(`refusing to sweep ${base}: not a workspace-notes/tmp directory`);
  }
  let entries: string[];
  const now = Date.now();
  try {
    entries = fs.readdirSync(base);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const full = path.join(base, entry);
    if (/^\d+$/.test(entry) && pidIsAlive(Number(entry)) && !isStale(full, now)) {
      continue;
    }
    removeWithRetry(full, removeTree);
  }
  removeWithRetry(own, removeTree);
  fs.mkdirSync(own, { recursive: true });
}

/**
 * Drop this process's own scratch dir, leaving other lanes' alone. Guarded
 * the same way cleanScratchRoot is guarded: `own`'s parent must be a
 * `workspace-notes/tmp`, so a mistaken default (SCRATCH_BASE instead of
 * SCRATCH_ROOT — the whole tmp dir instead of this run's own pid-named
 * subdirectory of it) refuses loudly instead of silently emptying every
 * concurrent lane's fixtures.
 */
export function dropOwnScratchRoot(
  own: string = SCRATCH_ROOT,
  removeTree: (target: string) => void = defaultRemoveTree
): void {
  const parent = path.dirname(own);
  if (
    path.basename(parent) !== 'tmp' ||
    path.basename(path.dirname(parent)) !== 'workspace-notes'
  ) {
    throw new Error(`refusing to remove ${own}: not a workspace-notes/tmp/<pid> directory`);
  }
  removeWithRetry(own, removeTree);
}

function defaultRemoveTree(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

/** Mocha global fixture: heal leaks from runs that are no longer with us. */
export function mochaGlobalSetup(): void {
  cleanScratchRoot();
}

/** Mocha global fixture: leave the workspace clean after the run. */
export function mochaGlobalTeardown(): void {
  dropOwnScratchRoot();
}

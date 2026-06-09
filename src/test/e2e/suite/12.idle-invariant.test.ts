/**
 * Tier-2 E2E — post-activate idle invariant against a real git fixture.
 *
 * Mirrors the ext-host smoke spec at `src/test/ext-host/suite/07.post-activate-idle.test.ts`,
 * but runs against a Tier-2 `createFixtureRepo` fixture instead of whatever
 * workspace the launcher happened to open. The distinction matters:
 *
 *   The retroactive GitService watcher infinite-loop bug (pre-TL-78) only
 *   reproduces when the watcher is observing a `.git/` directory to which
 *   subprocess side-effects actually propagate. The ext-host suite watches
 *   the dev workspace repo, which works — but Tier-2 watches a dedicated
 *   fresh temp repo whose `.git/` is hot and isolated. Either layer can
 *   catch the loop; having both is defence-in-depth, and Tier-2 is the
 *   signal a future regression has more room to land when the ext-host
 *   host boots with a different workspace configuration.
 *
 * The spawn-counter uses the same `child_process.spawn` module-object
 * replacement trick as the ext-host version: TypeScript compiles
 * `import { spawn } from 'child_process'` to `(0, child_process_1.spawn)(...)`,
 * an access through the cached module exports on every call. Replacing
 * `require('child_process').spawn` after modules are loaded therefore
 * intercepts all future calls from already-loaded code.
 *
 * Thresholds:
 *   IDLE_WINDOW_MS         5s of observation with no user input
 *   IDLE_SPAWN_THRESHOLD   ≤ 3 (empirical healthy baseline is 0–2)
 *   IDLE_SPAWN_HARD_FAIL   ≥ 10 (distinguishes flakey from loop)
 *   TOTAL_BUDGET           ≤ 50 total across the suite (matches ext-host)
 *
 * The Tier-2 fixture boots the same sentinel workspace + per-test repo
 * binding used by every other 01-11 spec; the only novelty here is the
 * spawn-counter. `useFixtureWorkspace` registers the repo with GitService
 * so the watcher is observing `<fixture>/.git/**` during the idle window.
 *
 * Retroactive validation path (DO NOT COMMIT):
 *   Temporarily broaden `WATCH_GLOB` in GitService.setupRepositoryWatcher
 *   to `.git/**\/*` and re-run this file. The spec should fail with
 *   "REFRESH LOOP SUSPECTED" in <5s. Revert before handoff.
 */

import * as assert from 'assert';
import * as cp from 'child_process';
import * as vscode from 'vscode';

import { createFixtureRepo, Fixture } from '../support/gitFixture';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';

const ACTIVATION_SETTLE_MS = 2_000;
const IDLE_WINDOW_MS = 5_000;
const IDLE_SPAWN_THRESHOLD = 3;
const IDLE_SPAWN_HARD_FAIL = 10;
const TOTAL_BUDGET = 50;

interface SpawnRecord {
  command: string;
  args: readonly string[];
  at: number;
}

/**
 * Hook `child_process.spawn` on the CJS module-exports object. Returns the
 * captured record list + a `dispose()` that restores the original.
 *
 * Caveat: tests that spawn `git` directly (e.g. via `execGit` in the
 * fixture helper) will also increment the counter. The idle-window logic
 * compensates by reading a baseline AFTER the fixture setup completes.
 */
function installSpawnCounter(): { spawns: SpawnRecord[]; dispose: () => void } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('child_process') as { spawn: typeof cp.spawn };
  const original = mod.spawn;
  const spawns: SpawnRecord[] = [];

  const hooked = function hookedSpawn(
    command: string,
    argsOrOptions?: readonly string[] | cp.SpawnOptions,
    _options?: cp.SpawnOptions
  ): cp.ChildProcess {
    void _options;
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    if (isGitCommand(command)) {
      spawns.push({ command, args, at: Date.now() });
    }
    return (original as unknown as (...a: unknown[]) => cp.ChildProcess).apply(
      mod,
      // eslint-disable-next-line prefer-rest-params
      arguments as unknown as unknown[]
    );
  };

  Object.defineProperty(mod, 'spawn', {
    value: hooked,
    configurable: true,
    writable: true,
    enumerable: true,
  });

  return {
    spawns,
    dispose: () => {
      Object.defineProperty(mod, 'spawn', {
        value: original,
        configurable: true,
        writable: true,
        enumerable: true,
      });
    },
  };
}

function isGitCommand(cmd: string): boolean {
  const normalized = cmd.replace(/\\/g, '/');
  const base = normalized.split('/').pop() ?? normalized;
  return base === 'git' || base === 'git.exe';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('e2e — post-activate idle invariant (Tier-2 real-repo reproduction)', function () {
  // The test body sleeps for ACTIVATION_SETTLE_MS + IDLE_WINDOW_MS plus
  // fixture setup — widen the Mocha budget so the Tier-2 default (15s)
  // doesn't bite us on a cold machine.
  this.timeout(60_000);

  let fix: Fixture;
  let counter: ReturnType<typeof installSpawnCounter> | undefined;

  beforeEach(async () => {
    fix = await createFixtureRepo({
      commits: 10,
      branches: [{ name: 'feature-branch' }],
      tags: [{ name: 'v0.1.0' }],
    });
    await useFixtureWorkspace(fix.rootPath);
    // Install the spawn counter AFTER fixture setup so the ~30 git
    // invocations that build the fixture don't pollute the baseline or
    // the total-count budget.
    counter = installSpawnCounter();
  });

  afterEach(async () => {
    if (counter) {
      counter.dispose();
      counter = undefined;
    }
    await clearWorkspace();
    await fix.cleanup();
  });

  it('idle window has ≤ IDLE_SPAWN_THRESHOLD git spawns (catches watcher loop)', async () => {
    assert.ok(counter, 'spawn counter not installed');

    // Let activation + initial repo-bind refresh settle. Any git spawns
    // from discovery, status, branch, tag reads belong to the ACTIVATION
    // budget rather than the idle budget.
    await sleep(ACTIVATION_SETTLE_MS);
    const baselineCount = counter.spawns.length;

    // Trigger a benign `.git/**`-adjacent event to wake the watcher. The
    // ext-host spec writes outside the watched subtree; the Tier-2 repo
    // is the watched subtree, so a single refresh command is the right
    // amplifier. A healthy watcher collapses the event into at most one
    // debounced reload.
    await vscode.commands.executeCommand('intellig.refresh');

    // Start the idle window. No further commands, no input, no writes.
    const idleWindowStart = Date.now();
    await sleep(IDLE_WINDOW_MS);
    const idleWindowEnd = Date.now();

    const idleSpawns = counter.spawns.filter(
      (s) => s.at >= idleWindowStart && s.at <= idleWindowEnd
    );

    // eslint-disable-next-line no-console
    console.log(
      `[idle invariant tier-2] baseline (post-settle) git spawns: ${baselineCount}; ` +
        `idle window (${IDLE_WINDOW_MS / 1000}s) git spawns: ${idleSpawns.length}; ` +
        `total since counter install: ${counter.spawns.length}`
    );

    if (idleSpawns.length <= IDLE_SPAWN_THRESHOLD) {
      return;
    }

    const tail = idleSpawns.slice(-20).map((s) => ({
      at: new Date(s.at).toISOString(),
      cmd: s.command,
      args: s.args.join(' '),
    }));
    const loopSuspected = idleSpawns.length >= IDLE_SPAWN_HARD_FAIL;

    const header = loopSuspected
      ? `REFRESH LOOP SUSPECTED — ${idleSpawns.length} git spawns in ${IDLE_WINDOW_MS / 1000}s idle window ` +
        `(threshold ${IDLE_SPAWN_THRESHOLD}, hard-fail ${IDLE_SPAWN_HARD_FAIL}).`
      : `IDLE BUDGET EXCEEDED — ${idleSpawns.length} git spawns in ${IDLE_WINDOW_MS / 1000}s idle window ` +
        `(threshold ${IDLE_SPAWN_THRESHOLD}). Possible refresh-chattiness regression.`;

    assert.fail(
      `${header}\n` +
        `Last ${tail.length} spawns:\n` +
        tail.map((t) => `  [${t.at}] ${t.cmd} ${t.args}`).join('\n') +
        `\n` +
        `The watcher-loop fix narrowed .git/* watch patterns, added a 250ms ` +
        `debounce, and an in-flight guard. A regression here likely means one ` +
        `of those three guards was weakened.`
    );
  });

  /**
   * Pins the activation-only spawn ceiling.
   *
   * This spec runs right after `beforeEach` installs the spawn counter,
   * so `counter.spawns.length` at this point reflects only what the
   * extension emitted during activation + repo-bind handshake — there
   * is no idle window observed here. A previous name ("total spawn
   * count across activation + idle…") misleadingly implied a combined
   * budget, but no idle window is awaited in this spec. The real
   * idle-window check lives in the sibling spec above, which sleeps
   * IDLE_WINDOW_MS and filters spawns by timestamp.
   *
   * `TOTAL_BUDGET` therefore caps **activation-only** spawns: a regression
   * that makes activation chatty (e.g. redundant branch/tag reads on
   * startup) trips this spec, even though the steady-state watcher is
   * healthy. Keeping the two signals separate lets a failure point at
   * "activation bloat" vs "watcher loop" without disambiguation.
   */
  it('activation-only git spawn count stays under TOTAL_BUDGET', () => {
    assert.ok(counter, 'spawn counter not installed');
    const total = counter.spawns.length;
    // eslint-disable-next-line no-console
    console.log(
      `[idle invariant tier-2] activation-only git spawns since counter install: ${total}/${TOTAL_BUDGET}`
    );
    if (total <= TOTAL_BUDGET) {
      return;
    }
    const tail = counter.spawns.slice(-20).map((s) => ({
      at: new Date(s.at).toISOString(),
      cmd: s.command,
      args: s.args.join(' '),
    }));
    assert.fail(
      `ACTIVATION-CHATTINESS SUSPECTED — ${total} git spawns between activation and ` +
        `the assertion (budget ${TOTAL_BUDGET}, no idle window awaited in this spec). ` +
        `A number this large points at redundant activation-path spawns (e.g. duplicated ` +
        `branch/tag reads, refresh-on-bind loops) rather than a steady-state watcher ` +
        `regression, which the sibling idle-window spec catches separately.\n` +
        `Last ${tail.length} spawns:\n` +
        tail.map((t) => `  [${t.at}] ${t.cmd} ${t.args}`).join('\n')
    );
  });
});

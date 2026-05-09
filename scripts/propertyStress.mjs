#!/usr/bin/env node
/**
 * Property-test stress runner.
 *
 * Runs `npm run test:property` N times sequentially with fail-fast behavior.
 * Used by `npm run test:property:stress` (default N=10) to surface flaky
 * property tests whose failure probability is low enough that the R1-R5
 * review rounds caught them only by chance (TR-4 at 3×, TR-5 at 5×, TR-6/TR-7
 * at 5×). A 10× budget is the standing gap-coverage policy so no new flake
 * slips through a single CI run.
 *
 * Single run wall-time: ~17s. 10× ≈ ~3 minutes. Acceptable for per-PR CI.
 *
 * Cross-platform so the same script works from bash, zsh, and PowerShell.
 *
 * Flags:
 *   --runs=N    number of iterations (default 10, overridable via STRESS_RUNS env)
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const DEFAULT_RUNS = 10;

function parseRuns() {
  const flag = process.argv.find((a) => a.startsWith('--runs='));
  if (flag) {
    const n = Number.parseInt(flag.slice('--runs='.length), 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  const env = process.env.STRESS_RUNS;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return DEFAULT_RUNS;
}

const runs = parseRuns();
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const started = Date.now();
for (let i = 1; i <= runs; i++) {
  const runStart = Date.now();
  process.stdout.write(`\n=== STRESS RUN ${i}/${runs} ===\n`);
  const result = spawnSync(npmCmd, ['run', 'test:property'], {
    stdio: 'inherit',
    env: process.env,
  });
  const runElapsed = ((Date.now() - runStart) / 1000).toFixed(1);
  if (result.status !== 0) {
    process.stderr.write(
      `\n=== STRESS RUN ${i}/${runs} FAILED after ${runElapsed}s — stopping fail-fast ===\n`
    );
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`=== STRESS RUN ${i}/${runs} OK (${runElapsed}s) ===\n`);
}

const total = ((Date.now() - started) / 1000).toFixed(1);
process.stdout.write(`\n=== ALL ${runs} STRESS RUNS PASSED (total ${total}s) ===\n`);

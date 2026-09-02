/**
 * Companion spec for scripts/check-ref-op-outcome-shared.sh.
 *
 * Proves the guard (a) passes against the real tree, (b) has teeth on a
 * re-typed outcome ladder that opens the dialog itself, (c) allows the same
 * conflict test when a router call follows within the window, (d) allows the
 * ladder inside refOperationOutcome.ts — where it lives — and (e) honours the
 * `ref-op-outcome-exempt:` marker.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-ref-op-outcome-shared.sh');
const TMP_ROOT = SCRATCH_ROOT;

function runGuard(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr ?? '' };
}

function checkSource(src: string, filename = 'offender.ts'): number | null {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'ref-op-outcome-guard-'));
  try {
    fs.writeFileSync(path.join(dir, filename), src, 'utf8');
    return runGuard([dir]).status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const LADDER = 'if (result.conflicts && result.conflicts.length > 0) {\n';

describe('check-ref-op-outcome-shared guard', () => {
  it('passes against the real tree', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on a clean tree; stderr:\n${stderr}`);
  });

  it('fails on a ladder that opens the dialog itself (has teeth)', () => {
    const offender =
      LADDER + '  await ctx.openResolveConflictsDialog(repo, result.conflicts, opts);\n}\n';
    assert.strictEqual(checkSource(offender), 1, 'a re-typed ladder must fail');
  });

  it('allows the conflict test when a router call follows it', () => {
    const routed = LADDER + '  await routeRebaseOutcome(ctx, repo, result, spec);\n}\n';
    assert.strictEqual(checkSource(routed), 0, 'a routed outcome must pass');
  });

  it('allows surfaceRebaseConflicts as the rebase router', () => {
    const routed =
      LADDER + '  await ctx.surfaceRebaseConflicts(repo, result.conflicts, onto, flag);\n}\n';
    assert.strictEqual(checkSource(routed), 0, 'the rebase seam must count as a router');
  });

  it('fails when the router call sits beyond the window', () => {
    const tooFar = LADDER + '  // filler\n'.repeat(12) + '  await routeRebaseOutcome(ctx);\n}\n';
    assert.strictEqual(checkSource(tooFar), 1, 'a routing call out of window must fail');
  });

  it('skips the module the ladder lives in', () => {
    const offender =
      LADDER + '  await ctx.openResolveConflictsDialog(repo, result.conflicts, opts);\n}\n';
    assert.strictEqual(
      checkSource(offender, 'refOperationOutcome.ts'),
      0,
      'the router module itself must be exempt by basename'
    );
  });

  it('skips a line carrying the ref-op-outcome-exempt marker', () => {
    const exempted =
      'const n = result.conflicts.length; // ref-op-outcome-exempt: a count, not a routing decision\n';
    assert.strictEqual(checkSource(exempted), 0, 'a marked line must be allowed');
  });
});

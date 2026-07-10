/**
 * Companion spec for scripts/check-conflict-predicate-shared.sh.
 *
 * Proves the guard (a) passes against the real tree, (b) has teeth on BOTH a
 * bare `indexStatus === 'U'` and a property-access `s.workTreeStatus === 'U'`
 * shape, (c) honours the `conflict-predicate-exempt:` marker, and (d) ignores
 * a comment-only mention of the shape.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-conflict-predicate-shared.sh');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes/tmp');

function runGuard(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr ?? '' };
}

function checkSource(src: string): number | null {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'conflict-pred-guard-'));
  try {
    fs.writeFileSync(path.join(dir, 'offender.ts'), src, 'utf8');
    return runGuard([dir]).status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-conflict-predicate-shared guard', () => {
  it('passes against the real tree', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on a clean tree; stderr:\n${stderr}`);
  });

  it('fails on a bare indexStatus === U check (has teeth)', () => {
    assert.strictEqual(
      checkSource("if (indexStatus === 'U') return 'conflicted';\n"),
      1,
      'a bare U-status conflict check must fail'
    );
  });

  it('fails on a property-access receiver s.workTreeStatus === U', () => {
    assert.strictEqual(
      checkSource("const c = s.indexStatus === 'U' || s.workTreeStatus === 'U';\n"),
      1,
      'a property-access U check must also fail'
    );
  });

  it('fails on a !== U exclusion filter', () => {
    assert.strictEqual(
      checkSource("const staged = s.indexStatus !== 'U' && s.indexStatus !== ' ';\n"),
      1,
      'a !== U exclusion is the same hand-rolled predicate and must fail'
    );
  });

  it('skips a line carrying the conflict-predicate-exempt marker', () => {
    assert.strictEqual(
      checkSource(
        "statusChar === 'U' // conflict-predicate-exempt: single-letter name-status marker\n"
      ),
      0,
      'a marked single-letter marker must be allowed'
    );
  });

  it('ignores a comment-only mention of the shape', () => {
    assert.strictEqual(
      checkSource("// A naive `=== 'U'` check misses AA/DD conflicts.\n"),
      0,
      'a prose comment must not trip the guard'
    );
  });
});

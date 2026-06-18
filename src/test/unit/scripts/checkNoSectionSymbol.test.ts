/**
 * Companion spec for scripts/check-no-section-symbol.sh (the U+00A7 ban).
 *
 * Proves the guard (a) passes against the real tree, (b) has teeth — it fails
 * when the glyph appears in a scanned path, and (c) honours its scope — the
 * src/test subtree is excluded so doc-coupled test titles keep the glyph.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-no-section-symbol.sh');
const GLYPH = Buffer.from([0xc2, 0xa7]).toString('utf8'); // U+00A7, never typed literally here

function runGuard(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr ?? '' };
}

describe('check-no-section-symbol guard', () => {
  it('passes against the real production source + scripts (default scope)', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on a clean tree; stderr:\n${stderr}`);
  });

  it('fails when the glyph appears in a scanned file (has teeth)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sect-guard-'));
    try {
      fs.writeFileSync(path.join(dir, 'offender.ts'), `// see ADR-009 ${GLYPH}6\n`, 'utf8');
      const { status, stderr } = runGuard([dir]);
      assert.strictEqual(status, 1, 'guard must fail when the glyph is present');
      assert.ok(/section-symbol guard FAILED/.test(stderr), 'should report the failure');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excludes the test subtree from scope', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sect-guard-'));
    try {
      const testDir = path.join(dir, 'test');
      fs.mkdirSync(testDir);
      fs.writeFileSync(path.join(testDir, 'spec.ts'), `// ADR-009 ${GLYPH}6 citation\n`, 'utf8');
      const { status } = runGuard([dir]);
      assert.strictEqual(status, 0, 'glyph under a test/ dir must be out of scope');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

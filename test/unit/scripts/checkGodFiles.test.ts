/**
 * Companion spec for scripts/check-god-files.mjs.
 *
 * Proves the ratchet (a) passes against the real tree, and has teeth on each
 * arm — every failing case names one arm and flips green if that arm is gutted:
 * (b) an un-ratcheted file over the cap, (c) a ratcheted file over its frozen
 * budget, (d) a ratchet entry whose file was deleted, (e) a ratchet entry whose
 * file shrank back within the cap — plus (f) an all-compliant tree passes.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-god-files.mjs');
const TMP_ROOT = SCRATCH_ROOT;

interface IFixture {
  cap: number;
  budgets: Record<string, number>;
  /** relative path under the fixture src root -> exact newline count to write. */
  files: Record<string, number>;
}

function runFixture(fixture: IFixture): { status: number | null; stderr: string } {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'god-files-'));
  try {
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    for (const [rel, lines] of Object.entries(fixture.files)) {
      const abs = path.join(srcDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '//\n'.repeat(lines), 'utf8');
    }
    const budgetsPath = path.join(dir, 'budgets.json');
    fs.writeFileSync(
      budgetsPath,
      JSON.stringify({ cap: fixture.cap, budgets: fixture.budgets }),
      'utf8'
    );
    const r = spawnSync('node', [SCRIPT, srcDir, budgetsPath], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-god-files guard', () => {
  it('passes against the real tree', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    assert.strictEqual(
      r.status,
      0,
      `guard should pass on the real tree; stderr:\n${r.stderr ?? ''}`
    );
  });

  it('fails an un-ratcheted file over the cap (cap arm has teeth)', () => {
    const { status, stderr } = runFixture({ cap: 800, budgets: {}, files: { 'big.ts': 900 } });
    assert.strictEqual(status, 1, `an un-ratcheted 900-line file must fail the 800 cap; ${stderr}`);
    assert.ok(stderr.includes('big.ts') && stderr.includes('cap'));
  });

  it('fails a ratcheted file over its frozen budget (budget arm has teeth)', () => {
    const { status, stderr } = runFixture({
      cap: 800,
      budgets: { 'foo.ts': 1000 },
      files: { 'foo.ts': 1200 },
    });
    assert.strictEqual(status, 1, `1200 lines must exceed the frozen budget of 1000; ${stderr}`);
    assert.ok(stderr.includes('foo.ts') && stderr.includes('budget'));
  });

  it('fails a ratchet entry whose file no longer exists (stale-missing arm)', () => {
    const { status, stderr } = runFixture({ cap: 800, budgets: { 'gone.ts': 1000 }, files: {} });
    assert.strictEqual(status, 1, `a ratchet entry for a deleted file must fail; ${stderr}`);
    assert.ok(stderr.includes('gone.ts') && stderr.includes('no longer exists'));
  });

  it('fails a ratchet entry that shrank back within the cap (stale-within-cap arm)', () => {
    const { status, stderr } = runFixture({
      cap: 800,
      budgets: { 'small.ts': 1000 },
      files: { 'small.ts': 400 },
    });
    assert.strictEqual(status, 1, `a ratchet entry now under the cap must be retired; ${stderr}`);
    assert.ok(stderr.includes('small.ts') && stderr.includes('cap'));
  });

  it('passes when every file is within its budget and the cap', () => {
    const { status, stderr } = runFixture({
      cap: 800,
      budgets: { 'listed.ts': 1200 },
      files: { 'listed.ts': 1200, 'nested/small.ts': 500 },
    });
    assert.strictEqual(status, 0, `a compliant tree must pass; ${stderr}`);
  });
});

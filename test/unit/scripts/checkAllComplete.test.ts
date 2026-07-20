/**
 * Companion spec for scripts/check-all-complete.mjs.
 *
 * A guard that cannot fail is worse than no guard — it reads as coverage.
 * These drive the script over fixture package.json files and pin the failure
 * arm (a fence defined but absent from the chain), the near-miss arm (a
 * prefix of another fence's name must not count as wired), and the passing
 * shape.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-all-complete.mjs');

function makeFixture(scripts: Record<string, string>): string {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'check-all-'));
  const file = path.join(root, 'package.json');
  fs.writeFileSync(file, JSON.stringify({ scripts }));
  return file;
}

function runGuard(packageJsonFile: string): { code: number; output: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT, packageJsonFile], { encoding: 'utf8' });
    return { code: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('check-all-complete guard', () => {
  it('passes when every fence is in the chain', () => {
    const file = makeFixture({
      'check:alpha': 'node scripts/alpha.mjs',
      'check:beta': 'node scripts/beta.mjs',
      'check:all': 'npm run check:alpha && npm run check:beta',
    });

    assert.strictEqual(runGuard(file).code, 0);
  });

  it('fails a chain entry that resolves to no script definition', () => {
    // The real shape: a union merge takes the chain but drops the definition,
    // so `npm run check:all` dies mid-run at npm's "Missing script".
    const file = makeFixture({
      'check:alpha': 'node scripts/alpha.mjs',
      'check:all': 'npm run check:alpha && npm run check:webview-async-guard',
    });

    const { code, output } = runGuard(file);

    assert.strictEqual(code, 1, 'a chain entry with no definition must fail the guard');
    assert.match(output, /check:webview-async-guard/);
    assert.match(output, /not defined|absent/);
  });

  it('reports every undefined chain entry, not just the first', () => {
    const file = makeFixture({
      'check:alpha': 'node scripts/alpha.mjs',
      'check:all':
        'npm run check:alpha && npm run check:webview-async-guard && npm run check:ghost',
    });

    const { output } = runGuard(file);

    assert.match(output, /check:webview-async-guard/);
    assert.match(output, /check:ghost/);
  });

  it('fails a fence that is defined but never run', () => {
    const file = makeFixture({
      'check:alpha': 'node scripts/alpha.mjs',
      'check:orphan': 'node scripts/orphan.mjs',
      'check:all': 'npm run check:alpha',
    });

    const { code, output } = runGuard(file);

    assert.strictEqual(code, 1, 'an unwired fence must fail the guard');
    assert.match(output, /check:orphan/);
  });

  it('does not accept a longer fence name as wiring a shorter one', () => {
    const file = makeFixture({
      'check:config': 'node scripts/config.mjs',
      'check:config-coherence': 'node scripts/config-coherence.mjs',
      'check:all': 'npm run check:config-coherence',
    });

    const { code, output } = runGuard(file);

    assert.strictEqual(code, 1);
    assert.match(output, /check:config\b/);
  });

  it('fails when there is no chain at all', () => {
    const file = makeFixture({ 'check:alpha': 'node scripts/alpha.mjs' });

    assert.strictEqual(runGuard(file).code, 1);
  });
});

describe('the real check:all chain runs every defined fence', () => {
  it('is complete (allowlist applied)', () => {
    // Real mode: no argument, so the script reads the repo's own package.json
    // and applies scripts/check-all-allowlist.txt.
    try {
      execFileSync('node', [SCRIPT], {
        encoding: 'utf8',
        cwd: path.resolve(__dirname, '../../..'),
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      assert.fail(`check:all is missing a fence:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
    }
  });
});

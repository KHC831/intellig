/**
 * Companion spec for scripts/check-src-greppable.mjs.
 *
 * The guard exists because a NUL byte makes grep suppress a file's matching
 * lines while still exiting 0 — the other grep-based guards then read zero
 * violations and report the file clean. These pin that it actually catches the
 * byte, including the exact shapes that were live in src/ before this landed.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-src-greppable.mjs');
const NUL = String.fromCharCode(0);

/** Write `files` into a fresh fixture dir; returns its path. */
function makeFixture(files: Record<string, string>): string {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'greppable-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function runGuard(root: string): { code: number; output: string } {
  try {
    return { code: 0, output: execFileSync('node', [SCRIPT, root], { encoding: 'utf8' }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('check-src-greppable guard', () => {
  it('passes a tree of plain-text sources', () => {
    const root = makeFixture({
      'a.ts': 'export const a = 1;\n',
      'sub/b.ts': 'export const b = 2;\n',
    });

    assert.strictEqual(runGuard(root).code, 0);
  });

  it('fails a literal NUL used as a delimiter (the commitGraph shape)', () => {
    const root = makeFixture({
      'commitGraph.ts': 'export const key = `${hash}' + NUL + '${root}`;\n',
    });

    const result = runGuard(root);

    assert.strictEqual(result.code, 1);
    assert.match(result.output, /commitGraph\.ts/);
    assert.match(result.output, /NUL byte/);
  });

  it('fails a literal control byte inside a regex class (the validator shape)', () => {
    const root = makeFixture({ 'validator.ts': `if (/[${NUL}-\\x1f]/.test(name)) {}\n` });

    assert.strictEqual(runGuard(root).code, 1);
  });

  it('accepts the escape spelling that replaced them', () => {
    const root = makeFixture({
      'commitGraph.ts': 'export const key = `${hash}\\0${root}`;\n',
      'validator.ts': 'if (/[\\x00-\\x1f\\x7f]/.test(name)) {}\n',
    });

    assert.strictEqual(runGuard(root).code, 0);
  });

  it('reports the offending line number', () => {
    const root = makeFixture({ 'a.ts': `const a = 1;\nconst b = '${NUL}';\n` });

    assert.match(runGuard(root).output, /a\.ts:2/);
  });
});

describe('check-src-greppable guard — the real tree', () => {
  it('passes on the shipped src/ tree', () => {
    assert.match(execFileSync('node', [SCRIPT], { encoding: 'utf8' }), /OK/);
  });
});

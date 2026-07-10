/**
 * Companion spec for scripts/check-dead-exports.mjs.
 *
 * Proves the guard (a) passes against the real src tree, and (b) has teeth —
 * an orphan module in a fixture tree (reachable from no entry point) fails,
 * while a module reached transitively from the entry point passes.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-dead-exports.mjs');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes/tmp');

function run(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr ?? '' };
}

function mkFixture(files: Record<string, string>): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'dead-exports-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

describe('check-dead-exports guard', () => {
  it('passes against the real src tree (default mode)', () => {
    const { status, stderr } = run([]);
    assert.strictEqual(status, 0, `guard should pass on the real tree; stderr:\n${stderr}`);
  });

  it('fails on an orphan module unreachable from the entry point (has teeth)', () => {
    const dir = mkFixture({
      'entry.ts': "import { used } from './reached';\nexport const start = used;\n",
      'reached.ts': 'export const used = 1;\n',
      'orphan.ts': 'export const dead = 2;\n',
    });
    try {
      const { status, stderr } = run([dir, 'entry.ts']);
      assert.strictEqual(status, 1, 'an orphan module must fail the guard');
      assert.ok(/orphan\.ts/.test(stderr), `should name the orphan; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when every module is reachable transitively from the entry point', () => {
    const dir = mkFixture({
      'entry.ts': "import './a';\n",
      'a.ts': "import { b } from './nested/b';\nexport const a = b;\n",
      'nested/b.ts': 'export const b = 3;\n',
    });
    try {
      const { status, stderr } = run([dir, 'entry.ts']);
      assert.strictEqual(status, 0, `a fully-reachable tree must pass; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

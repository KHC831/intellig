/**
 * Companion spec for scripts/check-test-path-equality.mjs: it passes the real
 * tree, fails a comparison with only one side resolved (directly or through a
 * const), accepts both sides resolved and the exempt marker, and fails closed
 * on an empty tree (ADR-007).
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-test-path-equality.mjs');

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const check = (files: Record<string, string>): ReturnType<typeof runGuard> => {
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'test-path-equality-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, rel), content);
  }
  return runGuard([root]);
};

describe('check-test-path-equality guard', () => {
  it('passes against the real tree', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, stderr);
  });

  it('fails a comparison with one resolved side', () => {
    for (const source of [
      'const hit = list.find((e) => e.path === fs.realpathSync(target));\n',
      'assert.strictEqual(entry.path, fs.realpathSync.native(target));\n',
      'if (canonicalizeFsPath(a) !== b) {}\n',
    ]) {
      const { status, stderr } = check({ 'a.test.ts': source });
      assert.strictEqual(status, 1, source);
      assert.match(stderr, /a\.test\.ts:1/);
    }
  });

  it('follows a const bound to a resolved path', () => {
    const { status, stderr } = check({
      'a.test.ts':
        'const real = fs.realpathSync(target);\nconst hit = list.find((e) => e.path === real);\n',
    });
    assert.strictEqual(status, 1);
    assert.match(stderr, /a\.test\.ts:2/);
  });

  it('accepts both sides resolved, and the exempt marker', () => {
    const { status, stdout, stderr } = check({
      'a.test.ts':
        'assert.strictEqual(fs.realpathSync.native(root), fs.realpathSync.native(tmp));\n' +
        '// path-equality-exempt: built by canonicalizeFsPath upstream\n' +
        'assert.strictEqual(entry.path, fs.realpathSync(target));\n',
    });
    assert.strictEqual(status, 0, stderr);
    assert.match(stdout, /1 exempt/);
  });

  it('fails closed on a tree with no test files', () => {
    const { status, stderr } = check({ 'README.txt': 'nothing\n' });
    assert.strictEqual(status, 1);
    assert.match(stderr, /vacuous/);
  });
});

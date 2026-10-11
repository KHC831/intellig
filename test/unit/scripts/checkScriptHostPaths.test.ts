/**
 * Companion spec for scripts/check-script-host-paths.mjs: it passes the real
 * tree, fails a hand-rolled grep-hit split in shell and a bare relative() call
 * in a Node guard, honours the exempt marker, ignores comments, and fails
 * closed on an empty tree (ADR-007).
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-script-host-paths.mjs');

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A scratch directory holding these files. */
function writeScratchTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'script-host-paths-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const check = (files: Record<string, string>): ReturnType<typeof runGuard> =>
  runGuard([writeScratchTree(files)]);

describe('check-script-host-paths guard', () => {
  it('passes against the real tree', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, stderr);
  });

  it('fails a hand-rolled grep-hit split', () => {
    const { status, stderr } = check({
      'guard.sh': 'while read -r hit; do\n  file=${hit%%:*}\ndone\n',
    });
    assert.strictEqual(status, 1);
    assert.match(stderr, /guard\.sh:2/);
  });

  it('fails a bare relative() call', () => {
    for (const source of [
      "import { relative } from 'node:path';\nconsole.log(relative(a, b));\n",
      "import * as path from 'path';\nconst r = path.relative(a, b);\n",
    ]) {
      const { status, stderr } = check({ 'guard.mjs': source });
      assert.strictEqual(status, 1, source);
      assert.match(stderr, /guard\.mjs:2/);
    }
  });

  it('accepts a line marked exempt on the line itself or the line above', () => {
    const { status, stdout } = check({
      'a.sh': 'f=${x%%:*} # script-path-exempt: a path:name list entry\n',
      'b.mjs': '// script-path-exempt: the shared helper\nexport const r = path.relative(a, b);\n',
    });
    assert.strictEqual(status, 0);
    assert.match(stdout, /2 exempt/);
  });

  it('ignores a mention in a comment or a string', () => {
    const { status, stderr } = check({
      'a.sh': '# never split with ${hit%%:*} here\necho ok\n',
      'b.mjs': "// path.relative(a, b) spells host separators\nconst s = 'relative(a)';\n",
    });
    assert.strictEqual(status, 0, stderr);
  });

  it('fails closed on a tree with no scripts', () => {
    const { status, stderr } = check({ 'README.txt': 'nothing\n' });
    assert.strictEqual(status, 1);
    assert.match(stderr, /vacuous/);
  });
});

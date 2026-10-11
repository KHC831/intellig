/**
 * Companion spec for scripts/check-in-flight-maps.mjs: it passes the real
 * tree, fails each shape of a hand-rolled map of in-flight promises, honours
 * the exempt marker, ignores a mention in a comment or a string, and fails
 * closed on an empty tree (ADR-007).
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-in-flight-maps.mjs');

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A scratch directory holding these files. */
function writeScratchTree(prefix: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, prefix));
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const check = (source: string): { status: number | null; stdout: string; stderr: string } =>
  runGuard([writeScratchTree('in-flight-maps-', { 'svc.ts': source })]);

describe('check-in-flight-maps guard', () => {
  it('passes against the real tree', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, stderr);
  });

  it('fails a hand-rolled map of in-flight promises', () => {
    for (const source of [
      'class S {\n  private inFlight: Map<string, Promise<void>> = new Map();\n}\n',
      'const slots = new Map<string, Promise<number[]>>();\n',
    ]) {
      const { status, stderr } = check(source);
      assert.strictEqual(status, 1, `should fail: ${source}`);
      assert.match(stderr, /svc\.ts:\d+/);
    }
  });

  it('accepts a map marked exempt on the line above or the line itself', () => {
    const { status, stdout } = check(
      '// in-flight-map-exempt: a serial queue tail\nconst a = new Map<string, Promise<void>>();\n' +
        'const b = new Map<string, Promise<void>>(); // in-flight-map-exempt: drained at teardown\n'
    );
    assert.strictEqual(status, 0);
    assert.match(stdout, /2 exempt/);
  });

  it('ignores a mention in a comment or a string, and a Promise-free map', () => {
    const { status } = check(
      '// a Map<string, Promise<void>> would be wrong here\n' +
        "const doc = 'Map<string, Promise<void>>';\n" +
        'const ok = new Map<string, number>();\n'
    );
    assert.strictEqual(status, 0);
  });

  it('fails closed when it scans nothing', () => {
    const { status } = runGuard([writeScratchTree('in-flight-maps-empty-', { 'notes.md': '' })]);
    assert.strictEqual(status, 1);
  });
});

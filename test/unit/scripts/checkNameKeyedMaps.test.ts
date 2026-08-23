/**
 * Companion spec for scripts/check-name-keyed-maps.mjs.
 *
 * Proves the guard passes on the real tree AND has teeth on each shape it
 * claims to catch, plus the exempt hatch, the safe alternatives, and the
 * fail-closed floor. A guard that only ever reports OK is indistinguishable
 * from one whose pattern stopped matching.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-name-keyed-maps.mjs');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes/tmp');

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeFixture(files: Record<string, string>): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'name-keyed-'));
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(src, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return src;
}

describe('check-name-keyed-maps guard', () => {
  it('passes against the real tree', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on the real tree; stderr:\n${stderr}`);
  });

  // One case per shape the guard claims to catch, so a regex that stops
  // matching one of them cannot hide behind the other two.
  const CAUGHT: ReadonlyArray<{ name: string; code: string }> = [
    { name: 'Record<string, T> annotation', code: `const m: Record<string, number> = {};\n` },
    { name: 'index-signature annotation', code: `const m: { [k: string]: number } = {};\n` },
    { name: 'as-cast form', code: `const m = {} as Record<string, number>;\n` },
  ];
  for (const shape of CAUGHT) {
    it(`has teeth on the ${shape.name}`, () => {
      const { status, stderr } = runGuard([makeFixture({ 'a.ts': shape.code })]);
      assert.strictEqual(status, 1, `${shape.name} must fail; stderr:\n${stderr}`);
      assert.ok(/string-keyed record/.test(stderr));
    });
  }

  const SAFE: ReadonlyArray<{ name: string; code: string }> = [
    { name: 'Map', code: `const m = new Map<string, number>();\n` },
    { name: 'Set', code: `const s = new Set<string>();\n` },
    {
      name: 'Object.create(null)',
      code: `const m = Object.create(null) as Record<string, number>;\n`,
    },
  ];
  for (const shape of SAFE) {
    it(`accepts ${shape.name}`, () => {
      const { status, stderr } = runGuard([makeFixture({ 'a.ts': shape.code })]);
      assert.strictEqual(status, 0, `${shape.name} must pass; stderr:\n${stderr}`);
    });
  }

  it('honors the exempt annotation on the line and the line above', () => {
    const src = makeFixture({
      'a.ts':
        `// name-keyed-map-exempt: keys are literals this file owns\n` +
        `const a: Record<string, number> = {};\n` +
        `const b: Record<string, number> = {}; // name-keyed-map-exempt: same\n`,
    });
    const { status, stderr } = runGuard([src]);
    assert.strictEqual(status, 0, `exempt records must pass; stderr:\n${stderr}`);
    assert.ok(/2 exempt/.test(spawnSync('node', [SCRIPT, src], { encoding: 'utf8' }).stdout));
  });

  it('is FAIL-CLOSED: scanning zero files fails instead of reporting OK', () => {
    const { status, stderr } = runGuard([path.join(TMP_ROOT, 'does-not-exist')]);
    assert.strictEqual(status, 1, 'a vacuous scan must fail');
    assert.ok(/vacuous/.test(stderr), `expected the vacuity arm; got:\n${stderr}`);
  });
});

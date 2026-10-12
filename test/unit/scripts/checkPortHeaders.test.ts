/**
 * Companion spec for scripts/check-port-headers.mjs: it passes the real tree,
 * fails a listed file without the JetBrains line, an unlisted file carrying
 * it, and a declared port missing from the manifest, accepts the
 * reference-only marker, and fails closed on an empty manifest (ADR-007).
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-port-headers.mjs');
const HEADER = '// Copyright 2000-2024 JetBrains s.r.o. and contributors. Apache 2.0 license.\n';
const DECLARED = "/**\n * Faithful port of IntelliJ's `DfsUtil` (platform/vcs-log/graph).\n */\n";

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A fixture root with this manifest and these src/test files. */
function check(listed: string[], files: Record<string, string>): ReturnType<typeof runGuard> {
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'port-headers-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(
    path.join(root, 'scripts', 'ported-files.json'),
    JSON.stringify({ files: Object.fromEntries(listed.map((f) => [f, 'upstream'])) })
  );
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return runGuard([root]);
}

describe('check-port-headers guard', () => {
  it('passes against the real tree', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, stderr);
  });

  it('passes listed files that carry the header', () => {
    const { status, stderr } = check(['src/a.ts'], { 'src/a.ts': HEADER + DECLARED });
    assert.strictEqual(status, 0, stderr);
  });

  it('fails a listed file without the header, or missing', () => {
    const { status, stderr } = check(['src/a.ts', 'src/gone.ts'], { 'src/a.ts': DECLARED });
    assert.strictEqual(status, 1);
    assert.match(stderr, /src\/a\.ts: ported file without/);
    assert.match(stderr, /src\/gone\.ts: listed .* but missing/);
  });

  it('fails an unlisted file carrying the JetBrains line', () => {
    const { status, stderr } = check(['src/a.ts'], {
      'src/a.ts': HEADER,
      'test/b.test.ts': HEADER,
    });
    assert.strictEqual(status, 1);
    assert.match(stderr, /test\/b\.test\.ts: carries the JetBrains line/);
  });

  it('fails a declared port missing from the manifest', () => {
    const { status, stderr } = check(['src/a.ts'], { 'src/a.ts': HEADER, 'src/dfs.ts': DECLARED });
    assert.strictEqual(status, 1);
    assert.match(stderr, /src\/dfs\.ts: says it is a port/);
  });

  it('accepts a declared port marked reference-only', () => {
    const { status, stderr } = check(['src/a.ts'], {
      'src/a.ts': HEADER,
      'src/checks.ts':
        "/**\n * IntelliG's port of git4idea's handler chain.\n *\n" +
        ' * intellij-reference-only: follows the shape; the code is our own.\n */\n',
    });
    assert.strictEqual(status, 0, stderr);
  });

  it('fails closed on an empty manifest', () => {
    const { status, stderr } = check([], { 'src/a.ts': 'export {};\n' });
    assert.strictEqual(status, 1);
    assert.match(stderr, /vacuous/);
  });
});

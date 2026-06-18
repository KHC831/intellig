/**
 * Companion spec for scripts/check-command-reachability.mjs.
 *
 * Proves the guard (a) passes against the real manifest + source, and
 * (b) has teeth — a command declared in package.json with no registration in
 * production source fails, while one that IS present passes.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-command-reachability.mjs');

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('check-command-reachability guard', () => {
  it('passes against the real package.json + src', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on the real tree; stderr:\n${stderr}`);
  });

  it('fails when a declared command is absent from production source (has teeth)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-reach-'));
    try {
      const pkg = {
        contributes: {
          commands: [{ command: 'intellig.real' }, { command: 'intellig.phantom' }],
        },
      };
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
      const src = path.join(dir, 'src');
      fs.mkdirSync(src);
      // Only intellig.real is registered; intellig.phantom appears nowhere.
      fs.writeFileSync(
        path.join(src, 'reg.ts'),
        `registerCommand('intellig.real', () => {});\n`,
        'utf8'
      );
      const { status, stderr } = runGuard([path.join(dir, 'package.json'), src]);
      assert.strictEqual(status, 1, 'guard must fail when a declared command is unregistered');
      assert.ok(/intellig\.phantom/.test(stderr), 'should name the phantom command');
      assert.ok(!/intellig\.real/.test(stderr), 'should not flag the registered command');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores the test subtree when scanning for registration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-reach-'));
    try {
      const pkg = { contributes: { commands: [{ command: 'intellig.only' }] } };
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
      const src = path.join(dir, 'src');
      const testDir = path.join(src, 'test');
      fs.mkdirSync(testDir, { recursive: true });
      // The id appears ONLY under a test/ dir — registration must live in prod.
      fs.writeFileSync(path.join(testDir, 'e2e.ts'), `executeCommand('intellig.only');\n`, 'utf8');
      const { status, stderr } = runGuard([path.join(dir, 'package.json'), src]);
      assert.strictEqual(status, 1, 'a command present only under test/ must still fail');
      assert.ok(/intellig\.only/.test(stderr), 'should name the test-only command');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

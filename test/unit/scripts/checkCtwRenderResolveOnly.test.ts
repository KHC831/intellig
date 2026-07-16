/**
 * Companion spec for scripts/check-ctw-render-resolve-only.sh.
 *
 * Proves: passes on the real tree (CommitToolWindow.ts has zero _render()
 * call sites — its resolve render lives in the base class); fails on a
 * synthetic file that re-introduces a post-resolve _render() call; honors
 * the render-exempt justification comment; and ignores _renderOnResolve
 * (the sanctioned resolve hook name).
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-ctw-render-resolve-only.sh');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes', 'tmp');

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeFixtureFile(name: string, content: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `ctwrender-${name}-`));
  const file = path.join(dir, 'CommitToolWindow.ts');
  fs.writeFileSync(file, content, 'utf8');
  return { dir, file };
}

describe('check-ctw-render-resolve-only guard', () => {
  before(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
  });

  it('passes against the real CommitToolWindow.ts', () => {
    const { status, stdout, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on the real file; ${stdout}\n${stderr}`);
  });

  it('fails on a post-resolve _render() call site', () => {
    const fx = makeFixtureFile('raw', 'class C {\n  refresh() {\n    this._render();\n  }\n}\n');
    try {
      const { status, stdout } = runGuard([fx.file]);
      assert.strictEqual(status, 1, 'a _render() call site must fail');
      assert.ok(/_render\(\)/.test(stdout), `should name the call; stdout:\n${stdout}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('passes a render-exempt-justified call site', () => {
    const fx = makeFixtureFile(
      'exempt',
      'class C {\n  refresh() {\n    this._render(); // render-exempt: resolve-hook override, see _renderOnResolve\n  }\n}\n'
    );
    try {
      const { status, stdout } = runGuard([fx.file]);
      assert.strictEqual(status, 0, `an exempt call must pass; stdout:\n${stdout}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('does not fire on _renderOnResolve or _pushLiveUpdate mentions', () => {
    const fx = makeFixtureFile(
      'clean',
      'class C {\n  protected _renderOnResolve(): void {}\n  refresh() {\n    void this._pushLiveUpdate();\n  }\n}\n'
    );
    try {
      const { status, stdout } = runGuard([fx.file]);
      assert.strictEqual(status, 0, `no raw _render() call — must pass; stdout:\n${stdout}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});

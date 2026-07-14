/**
 * Companion spec for scripts/check-persisted-state.mjs.
 *
 * Proves the ban (a) passes on the real tree, (b) catches raw Memento
 * get/update on the four conventional identifiers (workspaceState /
 * globalState / memento / store, optional leading underscore), including the multiline
 * split, (c) honors the `// persisted-state-exempt:` escape hatch, and (d) does
 * NOT fire on `.getState()` view accessors, a `context.workspaceState`
 * constructor arg, or the webview `vscode.getState()` handle.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-persisted-state.mjs');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes', 'tmp');

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Write a fresh temp srcDir with the given files (relative paths under src/). */
function makeFixture(name: string, files: Record<string, string>): { dir: string; srcDir: string } {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `pstate-${name}-`));
  const srcDir = path.join(dir, 'src');
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return { dir, srcDir };
}

describe('check-persisted-state guard', () => {
  before(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
  });

  it('passes against the real src tree', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on the real tree; stderr:\n${stderr}`);
  });

  it('fails on a raw _workspaceState.get() with no exempt comment', () => {
    const fx = makeFixture('ban', {
      'feature.ts': 'class F {\n  read() {\n    return this._workspaceState.get("k");\n  }\n}\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir]);
      assert.strictEqual(status, 1, 'a raw Memento get must fail');
      assert.ok(/feature\.ts:3/.test(stderr), `should name file:line; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('passes when the raw call carries a persisted-state-exempt comment above it', () => {
    const fx = makeFixture('exempt', {
      'feature.ts':
        'class F {\n  read() {\n' +
        '    // persisted-state-exempt: one-off bootstrap probe\n' +
        '    return this._workspaceState.get("k");\n  }\n}\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir]);
      assert.strictEqual(status, 0, `an exempt raw call must pass; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('catches the aliased _memento.update() and bare globalState.get() forms', () => {
    const fx = makeFixture('aliases', {
      'a.ts': 'export function w(_memento) {\n  return _memento.update("k", 1);\n}\n',
      'b.ts': 'export function r(ctx) {\n  return globalState.get("k");\n}\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir]);
      assert.strictEqual(status, 1, 'both alias forms must fail');
      assert.ok(/a\.ts:2/.test(stderr), `should name _memento site; stderr:\n${stderr}`);
      assert.ok(/b\.ts:2/.test(stderr), `should name globalState site; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('catches a `store`-aliased Memento (store.get / _store.update)', () => {
    const fx = makeFixture('store-alias', {
      'a.ts': 'export function r(store) {\n  return store.get("k");\n}\n',
      'b.ts': 'class F {\n  w() {\n    return this._store.update("k", 1);\n  }\n}\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir]);
      assert.strictEqual(status, 1, 'a store-aliased Memento must fail');
      assert.ok(/a\.ts:2/.test(stderr), `should name store.get site; stderr:\n${stderr}`);
      assert.ok(/b\.ts:3/.test(stderr), `should name _store.update site; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('does not fire on getState(), a context.workspaceState arg, or vscode.getState()', () => {
    const fx = makeFixture('false-positives', {
      'view.ts':
        'class V {\n  getState() { return this._inMemory; }\n  use() { return this.getState(); }\n}\n',
      'wire.ts':
        'export function make(context) {\n  return new Store(context.workspaceState, context.globalState);\n}\n',
      'webview.ts':
        'declare const vscode: { getState(): unknown };\nexport function s() { return vscode.getState(); }\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir]);
      assert.strictEqual(status, 0, `none of these are raw Memento access; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('catches a Memento receiver/.get split across two lines', () => {
    const fx = makeFixture('multiline', {
      'feature.ts':
        'class F {\n  read() {\n    return this._workspaceState\n      .get("k");\n  }\n}\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir]);
      assert.strictEqual(status, 1, 'a multiline Memento get must fail');
      assert.ok(/feature\.ts:3/.test(stderr), `should name the receiver line; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});

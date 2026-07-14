/**
 * Companion spec for scripts/check-typed-messages.mjs.
 *
 * Proves: passes on the real tree; Rule A bans raw onDidReceiveMessage (incl.
 * multiline) with a `typed-messages-exempt` escape hatch; Rule B bans the raw
 * webview.postMessage handle but allows the typed this.postMessage Base method;
 * Rule C requires assertNever in a protocol-importing handler; no false positive
 * on getState/vscode.getState/comments; and the ratcheting allowlist tolerates a
 * listed file, fails an unlisted one, and cannot regrow once empty.
 *
 * The fence takes `[srcDir] [allowlistCsv]`; passing an explicit (possibly
 * empty) allowlist lets each case control the ratchet deterministically.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-typed-messages.mjs');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes', 'tmp');

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeFixture(name: string, files: Record<string, string>): { dir: string; srcDir: string } {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `tmsg-${name}-`));
  const srcDir = path.join(dir, 'src');
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return { dir, srcDir };
}

describe('check-typed-messages guard', () => {
  before(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
  });

  it('passes against the real src tree (with the seeded allowlist)', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on the real tree; stderr:\n${stderr}`);
  });

  it('Rule A: fails on a raw onDidReceiveMessage with no exempt (empty allowlist)', () => {
    const fx = makeFixture('ruleA', {
      'feature.ts':
        'class F {\n  wire(p) {\n    p.webview.onDidReceiveMessage((m) => this.h(m));\n  }\n}\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 1, 'raw onDidReceiveMessage must fail');
      assert.ok(/feature\.ts:3/.test(stderr), `should name file:line; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('Rule A: passes when a typed-messages-exempt comment sits above the call', () => {
    const fx = makeFixture('ruleA-exempt', {
      'feature.ts':
        'class F {\n  wire(p) {\n' +
        '    // typed-messages-exempt: standalone class, guarded dispatch\n' +
        '    p.webview.onDidReceiveMessage((m) => this.h(m));\n  }\n}\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 0, `an exempt raw handler must pass; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('Rule B: fails on raw webview.postMessage but allows typed this.postMessage', () => {
    const raw = makeFixture('ruleB-raw', {
      'a.ts': 'class A {\n  send(p) {\n    void p.webview.postMessage({ type: "x" });\n  }\n}\n',
    });
    const typed = makeFixture('ruleB-typed', {
      'b.ts': 'class B {\n  send() {\n    void this.postMessage({ type: "x" });\n  }\n}\n',
    });
    try {
      const rawRun = runGuard([raw.srcDir, '']);
      assert.strictEqual(rawRun.status, 1, 'raw webview.postMessage must fail');
      assert.ok(
        /a\.ts:3/.test(rawRun.stderr),
        `should name the raw handle; stderr:\n${rawRun.stderr}`
      );
      const typedRun = runGuard([typed.srcDir, '']);
      assert.strictEqual(
        typedRun.status,
        0,
        `this.postMessage must pass; stderr:\n${typedRun.stderr}`
      );
    } finally {
      fs.rmSync(raw.dir, { recursive: true, force: true });
      fs.rmSync(typed.dir, { recursive: true, force: true });
    }
  });

  it('Rule B: catches an identifier-suffixed handle (`_fooWebview.postMessage`)', () => {
    // Regression: an aliased handle whose receiver is not the literal `webview`
    // used to slip the fence. The receiver pattern is `\w*[wW]ebview`, so any
    // `*Webview` handle is caught.
    const fx = makeFixture('ruleB-alias', {
      'a.ts': 'class A {\n  send(msg) {\n    void this._fooWebview.postMessage(msg);\n  }\n}\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 1, 'an aliased *Webview handle must fail');
      assert.ok(/a\.ts:3/.test(stderr), `should name the aliased handle; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('Rule B: catches an optional-chained send (`webview?.postMessage`)', () => {
    // Regression: `?.` between receiver and `postMessage` used to evade the
    // dot-only pattern; the receiver group now allows `?.` as well as `.`.
    const fx = makeFixture('ruleB-optchain', {
      'b.ts': 'class B {\n  send(p, msg) {\n    void p.webview?.postMessage(msg);\n  }\n}\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 1, 'an optional-chained send must fail');
      assert.ok(
        /b\.ts:3/.test(stderr),
        `should name the optional-chained send; stderr:\n${stderr}`
      );
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('Rule C: fails a protocol-importing handler that lacks an assertNever gate', () => {
    const fx = makeFixture('ruleC', {
      'panel.ts':
        "import { asFooInbound } from './foo.protocol';\n" +
        'class P {\n  _onMessage(raw) {\n' +
        '    const m = asFooInbound(raw);\n    if (!m) return;\n' +
        "    switch (m.type) {\n      case 'a': return;\n    }\n  }\n}\n",
      'foo.protocol.ts': "export type FooInbound = { type: 'a' };\n",
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 1, 'a protocol handler without assertNever must fail');
      assert.ok(/assertNever/.test(stderr), `should name the missing gate; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('does not fire on getState(), vscode.getState(), or a prose comment', () => {
    const fx = makeFixture('false-positives', {
      'view.ts':
        'class V {\n  getState() { return this._s; }\n  use() { return this.getState(); }\n}\n',
      'persist.ts':
        'declare const vscode: { getState(): unknown };\nexport const s = () => vscode.getState();\n',
      'doc.ts':
        '// The provider receives messages via onDidReceiveMessage and posts with postMessage.\nexport const x = 1;\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 0, `none of these are raw dispatch; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('Rule A: catches a multiline onDidReceiveMessage( split across lines', () => {
    const fx = makeFixture('multiline', {
      // `onDidReceiveMessage` and its `(` are split across lines — only a
      // content-based (\s* crossing newline) match catches it.
      'feature.ts':
        'class F {\n  wire(p) {\n    p.webview.onDidReceiveMessage\n      ((m) => this.h(m));\n  }\n}\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 1, 'a multiline raw handler must fail');
      assert.ok(/feature\.ts:3/.test(stderr), `should name the receiver line; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('ratchet: allowlisted file passes, identical unlisted file fails, empty allowlist stays closed', () => {
    const fx = makeFixture('ratchet', {
      'legacy/Old.ts':
        'class O {\n  wire(p) {\n    p.webview.onDidReceiveMessage((m) => this.h(m));\n  }\n}\n',
    });
    try {
      const listed = runGuard([fx.srcDir, path.join('legacy', 'Old.ts')]);
      assert.strictEqual(
        listed.status,
        0,
        `an allowlisted raw site must pass; stderr:\n${listed.stderr}`
      );
      const empty = runGuard([fx.srcDir, '']);
      assert.strictEqual(empty.status, 1, 'the same site fails once the allowlist is empty');
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});

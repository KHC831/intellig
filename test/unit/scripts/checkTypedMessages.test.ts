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

  it('Rule C: passes a forwarding shell that carries a rule-c exempt with reason', () => {
    // A dispatcher extraction moves the switch AND its assertNever gate to a
    // module; the provider keeps a thin forwarder. The file-scoped rule-c
    // marker (distinct from the line-scoped A/B marker, which such files may
    // already carry for other rules) says where the gate went.
    const fx = makeFixture('ruleCExempt', {
      'panel.ts':
        "import { asFooInbound } from './foo.protocol';\n" +
        'class P {\n' +
        '  // typed-messages-exempt-rule-c: the switch and its exhaustiveness gate live in handlers.ts\n' +
        '  _onMessage(raw) {\n    dispatchFoo(this, raw);\n  }\n}\n',
      'foo.protocol.ts': "export type FooInbound = { type: 'a' };\n",
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 0, `rule-c exempt with reason must pass; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('Rule C: a prose mention of assertNever in a comment is not a gate', () => {
    const fx = makeFixture('ruleCProse', {
      'panel.ts':
        "import { asFooInbound } from './foo.protocol';\n" +
        'class P {\n' +
        '  // this handler used to carry an assertNever gate\n' +
        '  _onMessage(raw) {\n' +
        '    const m = asFooInbound(raw);\n    if (!m) return;\n' +
        "    switch (m.type) {\n      case 'a': return;\n    }\n  }\n}\n",
      'foo.protocol.ts': "export type FooInbound = { type: 'a' };\n",
    });
    try {
      const { status } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 1, 'a comment mentioning assertNever must not satisfy rule C');
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('Rule C: a bare A/B exempt comment does NOT satisfy the rule-c gate', () => {
    const fx = makeFixture('ruleCNoBypass', {
      'panel.ts':
        "import { asFooInbound } from './foo.protocol';\n" +
        'class P {\n' +
        '  // typed-messages-exempt: unrelated rule-A justification\n' +
        '  _onMessage(raw) {\n' +
        '    const m = asFooInbound(raw);\n    if (!m) return;\n' +
        "    switch (m.type) {\n      case 'a': return;\n    }\n  }\n}\n",
      'foo.protocol.ts': "export type FooInbound = { type: 'a' };\n",
    });
    try {
      const { status } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 1, 'the line-scoped A/B marker must not bypass rule C');
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('Rule D: fails a file defining an *_INBOUND_TYPES array with no InboundArrayTie', () => {
    const fx = makeFixture('ruleD', {
      'foo.protocol.ts':
        "export type FooInbound = { type: 'a' } | { type: 'b' };\n" +
        "export const FOO_INBOUND_TYPES = ['a', 'b'] as const;\n",
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 1, 'an INBOUND_TYPES array without the compile tie must fail');
      assert.ok(/InboundArrayTie/.test(stderr), `should name the missing tie; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('Rule D: passes when the file carries the InboundArrayTie compile tie', () => {
    const fx = makeFixture('ruleD-ok', {
      'foo.protocol.ts':
        "import type { AssertInboundArrayTie, InboundArrayTie } from '../utils/protocolTie';\n" +
        "export type FooInbound = { type: 'a' } | { type: 'b' };\n" +
        "export const FOO_INBOUND_TYPES = ['a', 'b'] as const;\n" +
        'type _Tie = AssertInboundArrayTie<InboundArrayTie<FooInbound, typeof FOO_INBOUND_TYPES>>;\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 0, `a tied INBOUND_TYPES array must pass; stderr:\n${stderr}`);
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

  it('Rule E: fails an outbound arm no webview entry consumes', () => {
    const fx = makeFixture('ruleE', {
      'panel/foo.protocol.ts':
        "export type FooOutbound =\n  | { type: 'updateModel'; model: { a: string; b: number } }\n  | { type: 'neverConsumed'; payload: string };\n",
      'panel/webview/main.ts':
        "import type { FooOutbound } from '../foo.protocol';\n" +
        "window.addEventListener('message', (ev) => {\n" +
        '  const m = ev.data as FooOutbound;\n' +
        "  if (m.type === 'updateModel') {\n    apply(m);\n  }\n});\n" +
        'function apply(_m: unknown) {}\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 1, 'a host arm with no webview consumer must fail');
      assert.ok(/neverConsumed/.test(stderr), `should name the dead arm; stderr:\n${stderr}`);
      assert.ok(!/updateModel/.test(stderr), `the consumed arm must not flag; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('Rule E: multi-field members do not truncate the union scan (inner semicolons)', () => {
    // `{ type: 'a'; path: string }` carries semicolons INSIDE the member —
    // a first-semicolon slice would stop scanning before the second arm.
    const fx = makeFixture('ruleE-multifield', {
      'panel/foo.protocol.ts':
        "export type FooOutbound =\n  | { type: 'first'; path: string; error?: string }\n  | { type: 'second'; ok: boolean };\n",
      'panel/webview/main.ts':
        "import type { FooOutbound } from '../foo.protocol';\n" +
        "console.log('first' as FooOutbound['type']);\n",
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 1, 'the second arm must still be scanned and fail');
      assert.ok(/second/.test(stderr), `should name the second arm; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('Rule E: a fence-exempt comment on the union member passes', () => {
    const fx = makeFixture('ruleE-exempt', {
      'panel/foo.protocol.ts':
        'export type FooOutbound =\n' +
        "  | { type: 'updateModel' }\n" +
        '  // fence-exempt: consumed by the follower window, not the entry\n' +
        "  | { type: 'followerOnly' };\n",
      'panel/webview/main.ts':
        "import type { FooOutbound } from '../foo.protocol';\n" +
        "console.log('updateModel' as FooOutbound['type']);\n",
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 0, `an exempt arm must pass; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('Rule E: inbound unions are out of scope (one-directional fence)', () => {
    const fx = makeFixture('ruleE-inbound', {
      'panel/foo.protocol.ts':
        "export type FooInbound = { type: 'clicked' } | { type: 'typed' };\n",
      'panel/webview/main.ts':
        "import type { FooInbound } from '../foo.protocol';\nconsole.log('clicked' as FooInbound['type']);\n",
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 0, `inbound-only protocols must pass; stderr:\n${stderr}`);
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

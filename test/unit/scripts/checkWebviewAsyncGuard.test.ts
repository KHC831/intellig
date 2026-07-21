/**
 * Companion spec for scripts/check-webview-async-guard.mjs.
 *
 * Proves: passes on the real tree; fails on a synthetic webview entry that
 * schedules a bare callback (the shape that let a merge-window render die
 * silently mid-session); accepts a callback wrapped in a REAL guard helper
 * (one whose in-file body try/catches), inline and split across lines, while
 * REJECTING a same-named decoy that guards nothing and an unresolvable
 * imported guard. Resolution runs over the source-scan code view, so a real
 * guard whose body holds a `}` inside a string still passes and a decoy whose
 * only try/catch sits inside a string literal still fails. Honors the
 * async-guard-exempt comment; and ignores scheduling outside a `webview`
 * directory and inside comments.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-webview-async-guard.mjs');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes', 'tmp');

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A fixture root holding `<root>/feature/webview/entry.ts`. */
function makeFixture(name: string, content: string, dirName = 'webview'): string {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, `asyncguard-${name}-`));
  const dir = path.join(root, 'feature', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'entry.ts'), content, 'utf8');
  return root;
}

describe('check-webview-async-guard guard', () => {
  const roots: string[] = [];

  before(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
  });

  after(() => {
    for (const root of roots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function fixture(name: string, content: string, dirName?: string): string {
    const root = makeFixture(name, content, dirName);
    roots.push(root);
    return root;
  }

  it('passes against the real src tree', () => {
    const { status, stdout, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on the real tree; ${stdout}\n${stderr}`);
  });

  it('fails on a bare queueMicrotask callback', () => {
    const root = fixture(
      'bare',
      'function f() {\n  queueMicrotask(() => {\n    render();\n  });\n}\n'
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 1, 'a bare scheduled callback must fail');
    assert.ok(/queueMicrotask/.test(stderr), `should name the scheduler; stderr:\n${stderr}`);
  });

  it('fails on a bare setTimeout and requestAnimationFrame callback', () => {
    const root = fixture(
      'others',
      'function f() {\n  setTimeout(() => { a(); }, 10);\n  requestAnimationFrame(() => { b(); });\n}\n'
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 1);
    assert.ok(/setTimeout/.test(stderr) && /requestAnimationFrame/.test(stderr), stderr);
  });

  // A helper whose body actually wraps the work in try/catch, defined in-file
  // so the guard can resolve what the name refers to. Without this definition
  // these fixtures would pass on the NAME alone — a green control.
  const GUARD_DECL =
    'function guardContinuation(label, fn) {\n' +
    '  return () => {\n' +
    '    try {\n' +
    '      fn();\n' +
    '    } catch (e) {\n' +
    '      report(e);\n' +
    '    }\n' +
    '  };\n' +
    '}\n';

  it('accepts a callback wrapped in a real (try/catch) guard helper', () => {
    const root = fixture(
      'guarded',
      GUARD_DECL +
        "function f() {\n  queueMicrotask(guardContinuation('render', () => {\n    render();\n  }));\n}\n"
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 0, `a guarded callback must pass; ${stderr}`);
  });

  it('accepts a guarded callback split across lines', () => {
    const root = fixture(
      'split',
      GUARD_DECL +
        "function f() {\n  queueMicrotask(\n    guardContinuation('render', () => {\n      render();\n    })\n  );\n}\n"
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 0, `a split guarded call must pass; ${stderr}`);
  });

  it('fails on a same-named DECOY helper that does not try/catch', () => {
    const root = fixture(
      'decoy',
      'function guardNothing(fn) {\n  return fn;\n}\n' +
        'function f() {\n  queueMicrotask(guardNothing(() => {\n    render();\n  }));\n}\n'
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 1, 'a name-shaped decoy that guards nothing must not pass');
    assert.ok(/queueMicrotask/.test(stderr), `should name the scheduler; stderr:\n${stderr}`);
  });

  it('accepts a real guard helper whose body carries a brace inside a string', () => {
    // A `}` in a string literal must not close the brace-match early and hide
    // the try/catch that follows it. Resolution runs over the string-blanked
    // code view, so the literal brace does not perturb the match.
    const root = fixture(
      'strbrace',
      'function guardRender(fn) {\n' +
        '  const prefix = "}";\n' +
        '  try {\n' +
        '    fn();\n' +
        '  } catch (e) {\n' +
        '    report(prefix, e);\n' +
        '  }\n' +
        '}\n' +
        'function f() {\n  queueMicrotask(guardRender(() => {\n    render();\n  }));\n}\n'
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 0, `a real guard with a brace-in-string must pass; ${stderr}`);
  });

  it('fails on a decoy whose only try/catch is inside a string literal', () => {
    // The words appear in a log message, not in control flow. Blanking string
    // bodies before the try/catch test stops the message from posing as a guard.
    const root = fixture(
      'strdecoy',
      'function guardNothing(fn) {\n' +
        '  log("will try to catch errors later");\n' +
        '  return fn;\n' +
        '}\n' +
        'function f() {\n  queueMicrotask(guardNothing(() => {\n    render();\n  }));\n}\n'
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 1, 'try/catch inside a string must not satisfy the guard');
    assert.ok(/queueMicrotask/.test(stderr), `should name the scheduler; stderr:\n${stderr}`);
  });

  it('fails when the guard helper is imported (body unresolvable in-file)', () => {
    const root = fixture(
      'imported',
      "import { guardContinuation } from './helpers';\n" +
        "function f() {\n  queueMicrotask(guardContinuation('render', () => {\n    render();\n  }));\n}\n"
    );
    const { status } = runGuard([root]);
    assert.strictEqual(
      status,
      1,
      'an unresolvable guard reads as unguarded (exempt is the remedy)'
    );
  });

  it('honors the async-guard-exempt justification comment', () => {
    const root = fixture(
      'exempt',
      'function f() {\n  // async-guard-exempt: one scrollTop write, cannot throw.\n  requestAnimationFrame(() => {\n    el.scrollTop = 0;\n  });\n}\n'
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 0, `an exempted call must pass; ${stderr}`);
  });

  it('ignores scheduling outside a webview directory', () => {
    const root = fixture('outside', 'queueMicrotask(() => { render(); });\n', 'provider');
    const { status } = runGuard([root]);
    assert.strictEqual(status, 0, 'only webview entries are in scope');
  });

  it('ignores the pattern inside comments', () => {
    const root = fixture(
      'comment',
      'function f() {\n  // queueMicrotask(() => render()) is the shape this guard bans.\n  return 1;\n}\n'
    );
    const { status } = runGuard([root]);
    assert.strictEqual(status, 0, 'prose describing the pattern must not trip the guard');
  });

  it('catches the window./globalThis.-prefixed global forms', () => {
    const root = fixture(
      'prefixed',
      'function f() {\n  window.setTimeout(() => { a(); }, 10);\n}\n' +
        'function g() {\n  globalThis.queueMicrotask(() => { b(); });\n}\n'
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 1, 'reaching the global through window/globalThis is the same call');
    assert.ok(/setTimeout/.test(stderr) && /queueMicrotask/.test(stderr), stderr);
  });

  it('ignores a longer identifier that contains a scheduler name (boundary check)', () => {
    // `resetTimeout(` contains the substring `setTimeout(` at index 4, so it
    // REACHES the word-boundary check — unlike `mySetTimeout`, whose capital S
    // makes indexOf miss so the check is never exercised (a green control).
    // `before` ends in a word char, so the guard treats it as a different fn.
    const root = fixture('suffix', 'function f() {\n  resetTimeout(() => { a(); }, 1);\n}\n');
    const { status } = runGuard([root]);
    assert.strictEqual(
      status,
      0,
      'a longer identifier that merely contains the name is not the global'
    );
  });

  it('ignores method-form scheduling on an object', () => {
    const root = fixture('method', 'function f() {\n  this.setTimeout(() => { a(); }, 1);\n}\n');
    const { status } = runGuard([root]);
    assert.strictEqual(status, 0, 'only the globals are in scope');
  });
});

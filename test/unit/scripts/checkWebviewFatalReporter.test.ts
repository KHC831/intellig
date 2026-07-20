/**
 * Companion spec for scripts/check-webview-fatal-reporter.mjs.
 *
 * Proves: passes on the real tree (allowlist applied); fails an entry missing
 * either listener; passes one installing both; ignores non-entry webview files
 * and comment-only mentions; honors the fatal-reporter-exempt hatch; and does
 * NOT apply the allowlist in fixture mode, so the spec sees real behaviour.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-webview-fatal-reporter.mjs');
const ALLOWLIST = path.join(process.cwd(), 'scripts/check-webview-fatal-reporter-allowlist.txt');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes', 'tmp');

const REPORTER = [
  "window.addEventListener('error', () => {});",
  "window.addEventListener('unhandledrejection', () => {});",
].join('\n');

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('check-webview-fatal-reporter guard', () => {
  const roots: string[] = [];

  before(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
  });

  after(() => {
    for (const root of roots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function fixture(name: string, content: string, dirName = 'webview'): string {
    const root = fs.mkdtempSync(path.join(TMP_ROOT, `fatalrep-${name}-`));
    const dir = path.join(root, 'feature', dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'entry.ts'), content, 'utf8');
    roots.push(root);
    return root;
  }

  it('passes against the real src tree', () => {
    const { status, stdout, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on the real tree; ${stdout}\n${stderr}`);
  });

  it('fails an entry with no reporter at all', () => {
    const root = fixture('none', 'const v = acquireVsCodeApi();\n');
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 1);
    assert.ok(/'error'/.test(stderr) && /unhandledrejection/.test(stderr), stderr);
  });

  it('fails an entry that installs only one of the pair', () => {
    const root = fixture('half', `const v = acquireVsCodeApi();\n${REPORTER.split('\n')[0]}\n`);
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 1, 'both listeners are required');
    assert.ok(/unhandledrejection/.test(stderr), stderr);
    assert.ok(!/'error'/.test(stderr), 'the installed one must not be reported missing');
  });

  it('passes an entry installing both listeners', () => {
    const root = fixture('both', `const v = acquireVsCodeApi();\n${REPORTER}\n`);
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 0, `a reporting entry must pass; ${stderr}`);
  });

  it('fails an entry whose boot does other work before installing the reporter', () => {
    const root = fixture(
      'late',
      'const v = acquireVsCodeApi();\n' +
        'function boot(): void {\n  buildDom(document);\n' +
        `  ${REPORTER.split('\n').join('\n  ')}\n}\nboot();\n`
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 1, 'a throw during DOM construction must report too');
    assert.ok(/before installing the reporter/.test(stderr), stderr);
  });

  it('accepts an entry whose boot installs the reporter first', () => {
    const root = fixture(
      'early',
      'const v = acquireVsCodeApi();\n' +
        'function boot(): void {\n' +
        `  ${REPORTER.split('\n').join('\n  ')}\n  buildDom(document);\n}\nboot();\n`
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 0, `reporter-first must pass; ${stderr}`);
  });

  it('accepts a boot that delegates to a real install helper first', () => {
    // The helper must be resolvable in this file AND actually register both
    // listeners; a bare call to an undefined name is not the reporter.
    const root = fixture(
      'helperfirst',
      'const v = acquireVsCodeApi();\n' +
        `function installFatalReporter(): void {\n  ${REPORTER.split('\n').join('\n  ')}\n}\n` +
        'function boot(): void {\n  installFatalReporter();\n  buildDom(document);\n}\nboot();\n'
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 0, `a real install helper counts as the reporter; ${stderr}`);
  });

  it('rejects a call to an install helper that is not defined here', () => {
    const root = fixture(
      'helpermissing',
      'const v = acquireVsCodeApi();\n' +
        `${REPORTER}\n` +
        'function boot(): void {\n  installFatalReporter();\n  buildDom(document);\n}\nboot();\n'
    );
    const { status } = runGuard([root]);
    assert.strictEqual(status, 1, 'an unresolvable name proves nothing about ordering');
  });

  it('rejects a decoy install* call that installs nothing', () => {
    // Matching a NAME SHAPE rather than what the name refers to is the same
    // hole as `guardless` in the sibling guard; it must not come back.
    const root = fixture(
      'namedecoy',
      'const v = acquireVsCodeApi();\n' +
        'function installTheme(): void {\n  applyTheme();\n}\n' +
        `function boot(): void {\n  installTheme();\n  buildDom(document);\n  ${REPORTER.split('\n').join('\n  ')}\n}\n`
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 1, 'a helper that installs nothing is not the reporter');
    assert.ok(/installTheme/.test(stderr), stderr);
  });

  it('rejects a reporter installed only inside a conditional', () => {
    const root = fixture(
      'conditional',
      `const v = acquireVsCodeApi();\nfunction installFatalReporter(): void {\n  ${REPORTER.split('\n').join('\n  ')}\n}\n` +
        'function boot(): void {\n  if (SOMETHING) {\n    installFatalReporter();\n  }\n  buildDom(document);\n}\n'
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 1, 'a reporter that may never install is not installed');
    assert.ok(/conditionally/.test(stderr), stderr);
  });

  it('checks ordering in an arrow-assigned boot too', () => {
    const root = fixture(
      'arrowboot',
      'const v = acquireVsCodeApi();\n' +
        `export const boot = (): void => {\n  buildDom(document);\n  ${REPORTER.split('\n').join('\n  ')}\n};\n`
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 1, 'an arrow-assigned boot must not skip the ordering check');
    assert.ok(/buildDom/.test(stderr), stderr);
  });

  it('accepts an arrow-assigned boot that installs first', () => {
    const root = fixture(
      'arrowok',
      'const v = acquireVsCodeApi();\n' +
        `export const boot = (): void => {\n  ${REPORTER.split('\n').join('\n  ')}\n  buildDom(document);\n};\n`
    );
    const { status, stderr } = runGuard([root]);
    assert.strictEqual(status, 0, `reporter-first in an arrow boot must pass; ${stderr}`);
  });

  it('ignores a webview file that is not an entry', () => {
    const root = fixture('helper', 'export function helper(): number {\n  return 1;\n}\n');
    const { status } = runGuard([root]);
    assert.strictEqual(status, 0, 'only files taking the host API handle are entries');
  });

  it('does not accept a listener mentioned only in a comment', () => {
    const root = fixture(
      'commented',
      "const v = acquireVsCodeApi();\n// window.addEventListener('error', …) belongs here.\n" +
        "/* window.addEventListener('unhandledrejection', …) too. */\n"
    );
    const { status } = runGuard([root]);
    assert.strictEqual(status, 1, 'prose is not an installation');
  });

  it('honors the fatal-reporter-exempt hatch', () => {
    const root = fixture(
      'exempt',
      '// fatal-reporter-exempt: installed by the shared bootstrap.\nconst v = acquireVsCodeApi();\n'
    );
    const { status } = runGuard([root]);
    assert.strictEqual(status, 0);
  });

  it('ignores files outside a webview directory', () => {
    const root = fixture('outside', 'const v = acquireVsCodeApi();\n', 'provider');
    const { status } = runGuard([root]);
    assert.strictEqual(status, 0);
  });

  it('does not apply the allowlist in fixture mode', () => {
    // An allowlisted real path, reproduced under a fixture root, must still
    // fail — otherwise the spec could never observe the guard's real logic.
    const listed = fs
      .readFileSync(ALLOWLIST, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    assert.ok(listed.length > 0, 'the allowlist fixture assumes at least one entry');

    const root = fs.mkdtempSync(path.join(TMP_ROOT, 'fatalrep-listed-'));
    roots.push(root);
    const target = path.join(root, listed[0]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'const v = acquireVsCodeApi();\n', 'utf8');

    const { status } = runGuard([root]);
    assert.strictEqual(status, 1, 'fixture mode must ignore the allowlist');
  });

  it('every allowlisted entry still exists', () => {
    // A stale line would silently shrink the guard's scope.
    for (const entry of fs
      .readFileSync(ALLOWLIST, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'))) {
      assert.ok(fs.existsSync(entry), `allowlisted entry no longer exists: ${entry}`);
    }
  });
});

/**
 * Companion spec for scripts/check-third-party-notices.mjs: it passes the real
 * tree, fails a notice whose version differs from the installed one, a shipped
 * package with no notice, and a notice for a package nothing ships, ignores
 * imports that do not bundle code, and fails closed when nothing ships
 * (ADR-007).
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-third-party-notices.mjs');
const INSTALLED = { neverthrow: '8.2.0', 'monaco-editor': '0.52.2', '@vscode/codicons': '0.0.45' };
const ASSETS = { 'media/monaco/vs/loader.js': '', 'media/codicon.ttf': '' };
const SHIPPED_NOTICES = ['neverthrow 8.2.0', 'monaco-editor 0.52.2', '@vscode/codicons 0.0.45'];

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A fixture root with these notice headings, installed versions and files. */
function check(
  headings: string[],
  files: Record<string, string>,
  installed: Record<string, string> = INSTALLED
): ReturnType<typeof runGuard> {
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'third-party-notices-'));
  const packages = Object.fromEntries(
    Object.entries(installed).map(([name, version]) => [`node_modules/${name}`, { version }])
  );
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages }));
  fs.writeFileSync(
    path.join(root, 'THIRD_PARTY_NOTICES.md'),
    `# Third-party notices\n\n${headings.map((h) => `## ${h}\n\nLicense text.\n`).join('\n')}`
  );
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return runGuard([root]);
}

const USES_NEVERTHROW = { 'src/a.ts': "import { ok } from 'neverthrow';\n", ...ASSETS };

describe('check-third-party-notices guard', () => {
  it('passes against the real tree', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, stderr);
  });

  it('passes when every shipped package has a notice at its installed version', () => {
    const { status, stderr } = check(SHIPPED_NOTICES, USES_NEVERTHROW);
    assert.strictEqual(status, 0, stderr);
  });

  it('fails a notice whose version differs from the installed one', () => {
    const { status, stderr } = check(SHIPPED_NOTICES, USES_NEVERTHROW, {
      ...INSTALLED,
      'monaco-editor': '0.57.0',
    });
    assert.strictEqual(status, 1);
    assert.match(stderr, /monaco-editor: the notice names 0\.52\.2 but 0\.57\.0 is installed/);
  });

  it('fails a bundled import with no notice', () => {
    const { status, stderr } = check(SHIPPED_NOTICES, {
      ...USES_NEVERTHROW,
      'src/b.ts': "export { parse } from 'some-lib/sub';\nconst x = require('@scope/pkg');\n",
    });
    assert.strictEqual(status, 1);
    assert.match(stderr, /some-lib: ships .* but has no notice/);
    assert.match(stderr, /@scope\/pkg: ships .* but has no notice/);
  });

  it('fails a shipped asset with no notice', () => {
    const { status, stderr } = check(['neverthrow 8.2.0', 'monaco-editor 0.52.2'], USES_NEVERTHROW);
    assert.strictEqual(status, 1);
    assert.match(stderr, /@vscode\/codicons: ships .* but has no notice/);
  });

  it('ignores type-only imports, node built-ins, vscode, relative paths and tests', () => {
    const { status, stderr } = check(SHIPPED_NOTICES, {
      ...USES_NEVERTHROW,
      'src/b.ts': [
        "import type * as M from 'typed-only';",
        "import { type T } from 'typed-names';",
        "import * as fs from 'fs';",
        "import { createHash } from 'node:crypto';",
        "import * as vscode from 'vscode';",
        "import { y } from './y';",
        "const s = 'not-an-import';",
        '',
      ].join('\n'),
      'test/c.test.ts': "import * as sinon from 'sinon';\n",
    });
    assert.strictEqual(status, 0, stderr);
  });

  it('fails a notice for a package nothing ships', () => {
    const { status, stderr } = check([...SHIPPED_NOTICES, 'left-pad 1.3.0'], USES_NEVERTHROW, {
      ...INSTALLED,
      'left-pad': '1.3.0',
    });
    assert.strictEqual(status, 1);
    assert.match(stderr, /left-pad: has a notice but nothing ships it/);
  });

  it('fails closed when it finds nothing shipped', () => {
    const { status, stderr } = check([], {});
    assert.strictEqual(status, 1);
    assert.match(stderr, /found no shipped third-party package/);
  });
});

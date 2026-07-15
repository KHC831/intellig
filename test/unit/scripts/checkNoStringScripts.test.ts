/**
 * Companion spec for scripts/check-no-string-scripts.mjs.
 *
 * Proves: passes on the real tree (seeded ratchet); an inline
 * `<script>${x}</script>` with body fails in an unlisted file and passes in an
 * allowlisted one; external `<script src>` and the empty sentinel pass; a
 * `no-string-script-exempt` comment exempts an irreducible inline boot; a
 * multiline `<script\n nonce>` open tag is still caught (content-based); prose
 * `<script>` in a JSDoc comment does not false-positive; and the ratchet stays
 * closed once empty.
 *
 * The fence takes `[srcDir] [allowlistCsv]`; an explicit (possibly empty)
 * allowlist lets each case control the ratchet deterministically.
 */
import '../../setup';
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-no-string-scripts.mjs');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes', 'tmp');

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeFixture(name: string, files: Record<string, string>): { dir: string; srcDir: string } {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `nss-${name}-`));
  const srcDir = path.join(dir, 'src');
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return { dir, srcDir };
}

describe('check-no-string-scripts guard', () => {
  before(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
  });

  it('passes against the real src tree (with the seeded allowlist)', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on the real tree; stderr:\n${stderr}`);
  });

  it('fails on an inline <script>${x}</script> with body in an unlisted file', () => {
    const fx = makeFixture('inline', {
      'panel.ts':
        'export function html(script: string): string {\n' +
        '  return `<body><script nonce="${n}">${script}</script></body>`;\n}\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 1, 'an inline executable script must fail');
      assert.ok(/panel\.ts:2/.test(stderr), `should name file:line; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('passes the same inline script when its file is allowlisted', () => {
    const fx = makeFixture('inline-allow', {
      'panel.ts':
        'export function html(script: string): string {\n' +
        '  return `<body><script nonce="${n}">${script}</script></body>`;\n}\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, 'panel.ts']);
      assert.strictEqual(status, 0, `an allowlisted inline emitter must pass; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('passes an external <script src> tag and an empty sentinel', () => {
    const fx = makeFixture('external', {
      'ext.ts':
        'export const html = (uri: string): string =>\n' +
        '  `<body><script nonce="${n}" src="${uri}"></script></body>`;\n',
      'sentinel.ts':
        'export const html = (): string => `<body><script nonce="${n}"></script></body>`;\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(
        status,
        0,
        `external bundle tags + the empty sentinel must pass; stderr:\n${stderr}`
      );
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('exempts an irreducible inline boot behind a no-string-script-exempt comment', () => {
    const fx = makeFixture('exempt', {
      'monaco.ts':
        'export const html = (n: string): string => `<body>\n' +
        '<!-- no-string-script-exempt: irreducible Monaco AMD boot -->\n' +
        '<script nonce="${n}">require(["vs/editor"], boot);</script></body>`;\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 0, `an exempt inline boot must pass; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('catches a multiline <script\\n nonce> open tag (content-based)', () => {
    const fx = makeFixture('multiline', {
      'panel.ts':
        'export const html = (n: string, s: string): string => `<body><script\n' +
        '  nonce="${n}">${s}</script></body>`;\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(status, 1, 'a multiline open tag must still fail');
      assert.ok(/panel\.ts:1/.test(stderr), `should name the open-tag line; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('does not false-positive on a prose <script> mention inside a JSDoc comment', () => {
    const fx = makeFixture('prose', {
      'doc.ts':
        '/**\n * The template wraps the body in a nonced `<script>` tag.\n */\n' +
        'export const html = (uri: string): string =>\n' +
        '  `<body><script nonce="${n}" src="${uri}"></script></body>`;\n',
    });
    try {
      const { status, stderr } = runGuard([fx.srcDir, '']);
      assert.strictEqual(
        status,
        0,
        `a prose <script> in a comment (real tag is external) must not fail; stderr:\n${stderr}`
      );
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('ratchet: an unlisted inline emitter fails once the allowlist is empty (cannot regrow)', () => {
    const fx = makeFixture('ratchet', {
      'legacy/Old.ts':
        'export const html = (s: string): string => `<script nonce="${n}">${s}</script>`;\n',
    });
    try {
      const listed = runGuard([fx.srcDir, path.join('legacy', 'Old.ts')]);
      assert.strictEqual(
        listed.status,
        0,
        `an allowlisted site must pass; stderr:\n${listed.stderr}`
      );
      const empty = runGuard([fx.srcDir, '']);
      assert.strictEqual(empty.status, 1, 'the same site fails once the allowlist is empty');
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});

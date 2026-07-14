/**
 * Companion spec for scripts/check-context-keys.mjs.
 *
 * Proves the guard (a) passes against the real manifest + source, (b) bans raw
 * setContext outside the helper (including the multiline site-#5 shape), honors
 * the `// context-key-exempt:` escape hatch, (c) enforces bidirectional
 * coherence between CONTEXT_KEYS and package.json when-clauses, and (d) does not
 * mistake view-ids / tree-item contextValues (RHS of view/viewItem ==) for
 * context keys.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-context-keys.mjs');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes', 'tmp');

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Write a synthetic package.json + src pair under a fresh temp dir.
 * `keys` become CONTEXT_KEYS entries; `whenClauses` become keybinding when
 * strings; `extraFiles` are written verbatim under src/.
 */
function makeFixture(
  name: string,
  opts: {
    keys?: Record<string, string>;
    whenClauses?: string[];
    extraFiles?: Record<string, string>;
  }
): { dir: string; pkgPath: string; srcDir: string } {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `ctx-keys-${name}-`));
  const pkg = {
    contributes: {
      keybindings: (opts.whenClauses ?? []).map((when, i) => ({
        command: `intellig.cmd${i}`,
        key: 'ctrl+k',
        when,
      })),
    },
  };
  const pkgPath = path.join(dir, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg), 'utf8');

  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(path.join(srcDir, 'utils'), { recursive: true });
  const entries = Object.entries(opts.keys ?? {})
    .map(([k, v]) => `  ${k}: '${v}',`)
    .join('\n');
  fs.writeFileSync(
    path.join(srcDir, 'utils', 'contextKeys.ts'),
    `export const CONTEXT_KEYS = {\n${entries}\n} as const;\n`,
    'utf8'
  );
  for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) {
    const p = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return { dir, pkgPath, srcDir };
}

describe('check-context-keys guard', () => {
  before(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
  });

  it('passes against the real package.json + src', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on the real tree; stderr:\n${stderr}`);
  });

  it('fails on a raw setContext call outside the helper with no exempt comment', () => {
    const fx = makeFixture('ban', {
      keys: { foo: 'intellig.foo' },
      whenClauses: ['intellig.foo'],
      extraFiles: {
        'feature.ts':
          "import * as vscode from 'vscode';\n" +
          "vscode.commands.executeCommand('setContext', 'intellig.foo', true);\n",
      },
    });
    try {
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(status, 1, 'a raw setContext must fail the guard');
      assert.ok(/feature\.ts:2/.test(stderr), `should name file:line; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('passes when the raw call carries a context-key-exempt comment above it', () => {
    const fx = makeFixture('exempt', {
      keys: { foo: 'intellig.foo' },
      whenClauses: ['intellig.foo'],
      extraFiles: {
        'feature.ts':
          "import * as vscode from 'vscode';\n" +
          '// context-key-exempt: bespoke publisher for a legacy panel\n' +
          "vscode.commands.executeCommand('setContext', 'intellig.foo', true);\n",
      },
    });
    try {
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(status, 0, `an exempt raw call must pass; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('fails when a CONTEXT_KEYS entry is consumed by no when-clause (code -> pkg)', () => {
    const fx = makeFixture('code-to-pkg', {
      keys: { foo: 'intellig.foo', orphan: 'intellig.orphanKey' },
      whenClauses: ['intellig.foo'],
    });
    try {
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(status, 1, 'an unconsumed CONTEXT_KEYS entry must fail');
      assert.ok(
        /intellig\.orphanKey/.test(stderr),
        `should name the orphan key; stderr:\n${stderr}`
      );
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('fails when a when-clause key is absent from CONTEXT_KEYS (pkg -> code)', () => {
    const fx = makeFixture('pkg-to-code', {
      keys: { foo: 'intellig.foo' },
      whenClauses: ['intellig.foo', 'intellig.notAKey'],
    });
    try {
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(status, 1, 'an unknown when-clause key must fail');
      assert.ok(/intellig\.notAKey/.test(stderr), `should name the stray key; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('does not treat view-id / contextValue RHS tokens as context keys', () => {
    const fx = makeFixture('rhs-exclusion', {
      keys: {},
      whenClauses: [
        "view == 'intellig.someView'",
        'viewItem == intellig.someItem',
        "activeWebviewPanelId == 'intellig.somePanel'",
        'focusedView == intellig.someFocus',
      ],
    });
    try {
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(
        status,
        0,
        `RHS view/contextValue tokens must be excluded; stderr:\n${stderr}`
      );
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('catches a raw setContext whose call and setContext literal span two lines', () => {
    const fx = makeFixture('multiline', {
      keys: { foo: 'intellig.foo' },
      whenClauses: ['intellig.foo'],
      extraFiles: {
        'feature.ts':
          "import * as vscode from 'vscode';\n" +
          'await vscode.commands.executeCommand(\n' +
          "  'setContext',\n" +
          "  'intellig.foo',\n" +
          '  true\n' +
          ');\n',
      },
    });
    try {
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(status, 1, 'a multiline raw setContext must fail');
      assert.ok(/feature\.ts:2/.test(stderr), `should name the call line; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});

/**
 * Companion spec for scripts/check-config-keys.mjs.
 *
 * Proves the guard (a) passes on the real tree, (b) bans raw
 * getConfiguration('intellig') outside the seam (including the multiline shape),
 * honors the `// config-key-exempt:` escape hatch, (c) enforces bidirectional
 * coherence between CONFIG_KEYS and the package.json configuration schema, and
 * (d) does not fire on non-intellig sections (`editor`) or a bare
 * getConfiguration() method call.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-config-keys.mjs');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes', 'tmp');

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * `keys` become CONFIG_KEYS entries (logical -> setting name relative to
 * intellig.); `schemaKeys` become contributes.configuration.properties (full
 * `intellig.*` names); `extraFiles` are written verbatim under src/.
 */
function makeFixture(
  name: string,
  opts: {
    keys?: Record<string, string>;
    schemaKeys?: string[];
    extraFiles?: Record<string, string>;
  }
): { dir: string; pkgPath: string; srcDir: string } {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `cfg-keys-${name}-`));
  const pkg = {
    contributes: {
      configuration: {
        properties: Object.fromEntries((opts.schemaKeys ?? []).map((k) => [k, { type: 'string' }])),
      },
    },
  };
  const pkgPath = path.join(dir, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg), 'utf8');

  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(path.join(srcDir, 'config'), { recursive: true });
  const entries = Object.entries(opts.keys ?? {})
    .map(([k, v]) => `  ${k}: '${v}',`)
    .join('\n');
  fs.writeFileSync(
    path.join(srcDir, 'config', 'configKeys.ts'),
    `export const CONFIG_KEYS = {\n${entries}\n} as const;\n`,
    'utf8'
  );
  for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) {
    const p = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return { dir, pkgPath, srcDir };
}

describe('check-config-keys guard', () => {
  before(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
  });

  it('passes against the real package.json + src', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on the real tree; stderr:\n${stderr}`);
  });

  it('fails on a raw getConfiguration(intellig) call outside the seam with no exempt comment', () => {
    const fx = makeFixture('ban', {
      keys: { foo: 'foo' },
      schemaKeys: ['intellig.foo'],
      extraFiles: {
        'feature.ts':
          "import * as vscode from 'vscode';\n" +
          "const v = vscode.workspace.getConfiguration('intellig').get('foo');\n",
      },
    });
    try {
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(status, 1, 'a raw getConfiguration(intellig) must fail the guard');
      assert.ok(/feature\.ts:2/.test(stderr), `should name file:line; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('passes when the raw call carries a config-key-exempt comment above it', () => {
    const fx = makeFixture('exempt', {
      keys: { foo: 'foo' },
      schemaKeys: ['intellig.foo'],
      extraFiles: {
        'feature.ts':
          "import * as vscode from 'vscode';\n" +
          '// config-key-exempt: bespoke non-schema legacy key\n' +
          "const v = vscode.workspace.getConfiguration('intellig').get('foo');\n",
      },
    });
    try {
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(status, 0, `an exempt raw call must pass; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('fails when a CONFIG_KEYS name is absent from the schema (map -> schema)', () => {
    const fx = makeFixture('map-to-schema', {
      keys: { foo: 'foo', ghost: 'ghostKey' },
      schemaKeys: ['intellig.foo'],
    });
    try {
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(status, 1, 'a CONFIG_KEYS name absent from schema must fail');
      assert.ok(/ghostKey/.test(stderr), `should name the ghost key; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('fails when a schema key is absent from CONFIG_KEYS (schema -> map)', () => {
    const fx = makeFixture('schema-to-map', {
      keys: { foo: 'foo' },
      schemaKeys: ['intellig.foo', 'intellig.orphanSetting'],
    });
    try {
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(status, 1, 'a schema key absent from CONFIG_KEYS must fail');
      assert.ok(/orphanSetting/.test(stderr), `should name the orphan setting; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('does not fire on getConfiguration(editor) or a bare getConfiguration() method', () => {
    const fx = makeFixture('non-intellig', {
      keys: { foo: 'foo' },
      schemaKeys: ['intellig.foo'],
      extraFiles: {
        'feature.ts':
          "import * as vscode from 'vscode';\n" +
          "const a = vscode.workspace.getConfiguration('editor').get('fontSize');\n" +
          'const b = this.getConfiguration();\n',
      },
    });
    try {
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(status, 0, `non-intellig reads must pass; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('catches a raw getConfiguration whose call and intellig literal span two lines', () => {
    const fx = makeFixture('multiline', {
      keys: { foo: 'foo' },
      schemaKeys: ['intellig.foo'],
      extraFiles: {
        'feature.ts':
          "import * as vscode from 'vscode';\n" +
          'const v = vscode.workspace.getConfiguration(\n' +
          "  'intellig'\n" +
          ").get('foo');\n",
      },
    });
    try {
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(status, 1, 'a multiline raw getConfiguration(intellig) must fail');
      assert.ok(/feature\.ts:2/.test(stderr), `should name the call line; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});

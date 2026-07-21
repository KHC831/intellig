/**
 * Companion spec for scripts/check-precommit-verify-only.mjs.
 *
 * Proves the guard (a) passes on the real, verify-only package.json + hook,
 * (b) fails when a lint-staged command carries `--write` or `--fix`, (c) fails
 * when the .husky/pre-commit body rewrites staged content, (d) fails when a
 * lint-staged config lives in an external file the guard cannot read, and
 * (e) passes on verify-only controls for the command and hook arms.
 *
 * Each failing case is the mechanism-flip proof for one arm (ADR-007): remove
 * the MUTATING scan and the `--write` / hook cases go green; remove the
 * external-config scan and that case goes green — while the verify-only
 * controls are already green, so the fixtures are discriminating, not
 * always-red.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-precommit-verify-only.mjs');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes', 'tmp');

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeFixture(
  name: string,
  files: Record<string, string>
): { dir: string; file: (rel: string) => string } {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `precommit-${name}-`));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return { dir, file: (rel: string) => path.join(dir, rel) };
}

function pkg(lintStaged: unknown): string {
  return JSON.stringify({ name: 'fx', 'lint-staged': lintStaged }, null, 2);
}

describe('check-precommit-verify-only guard', () => {
  before(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
  });

  it('passes against the real repo package.json + hook', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on the real tree; stderr:\n${stderr}`);
  });

  it('fails when a lint-staged command carries prettier --write', () => {
    const fx = makeFixture('write', {
      'package.json': pkg({ '*.ts': ['prettier --write', 'eslint --max-warnings 0'] }),
    });
    try {
      const { status, stderr } = runGuard([fx.file('package.json')]);
      assert.strictEqual(status, 1, 'a --write lint-staged entry must fail');
      assert.ok(/prettier --write/.test(stderr), `should name the command; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('fails when a lint-staged command carries eslint --fix', () => {
    const fx = makeFixture('fix', {
      'package.json': pkg({ '*.ts': ['prettier --check', 'eslint --fix --max-warnings 0'] }),
    });
    try {
      const { status, stderr } = runGuard([fx.file('package.json')]);
      assert.strictEqual(status, 1, 'an --fix lint-staged entry must fail');
      assert.ok(/eslint --fix/.test(stderr), `should name the command; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('passes on a verify-only lint-staged config (control)', () => {
    const fx = makeFixture('verify', {
      'package.json': pkg({
        '*.ts': ['prettier --check', 'eslint --max-warnings 0'],
        '*.{json,md}': ['prettier --check --ignore-unknown'],
      }),
    });
    try {
      const { status, stderr } = runGuard([fx.file('package.json')]);
      assert.strictEqual(status, 0, `verify-only config must pass; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('fails when lint-staged config lives in an external file the guard cannot read', () => {
    // `npx lint-staged` auto-discovers `.lintstagedrc*` / `lint-staged.config.*`.
    // A config relocated there could reintroduce `--write` while the guard, which
    // reads only package.json, passes vacuously. The one sanctioned home is
    // package.json, so any external config file fails.
    const fx = makeFixture('external', {
      'package.json': pkg({ '*.ts': ['prettier --check'] }),
      '.lintstagedrc.json': JSON.stringify({ '*.ts': ['prettier --write'] }),
    });
    try {
      const { status, stderr } = runGuard([fx.file('package.json')]);
      assert.strictEqual(status, 1, 'an external lint-staged config must fail the guard');
      assert.ok(
        /outside package\.json|lintstagedrc/.test(stderr),
        `should name the external config; stderr:\n${stderr}`
      );
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  // lint-staged's lilconfig discovers many extensions and the package.yaml/yml
  // manifests; the fence must cover the whole family, not a hand-picked subset.
  for (const configName of ['.lintstagedrc.cts', 'lint-staged.config.mts', 'package.yaml']) {
    it(`fails on an external ${configName} the guard cannot statically read`, () => {
      const fx = makeFixture(`ext-${configName.replace(/\W/g, '')}`, {
        'package.json': pkg({ '*.ts': ['prettier --check'] }),
        [configName]: '// relocated config\n',
      });
      try {
        const { status } = runGuard([fx.file('package.json')]);
        assert.strictEqual(status, 1, `${configName} is a lint-staged config source and must fail`);
      } finally {
        fs.rmSync(fx.dir, { recursive: true, force: true });
      }
    });
  }

  it('does NOT match --fix-dry-run (eslint dry run does not write)', () => {
    const fx = makeFixture('dryrun', {
      'package.json': pkg({ '*.ts': ['eslint --fix-dry-run --max-warnings 0'] }),
    });
    try {
      const { status } = runGuard([fx.file('package.json')]);
      assert.strictEqual(status, 0, '--fix-dry-run does not mutate and must pass');
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('fails when the pre-commit hook body rewrites staged content', () => {
    const fx = makeFixture('hook-write', {
      'package.json': pkg({ '*.ts': ['prettier --check'] }),
      'pre-commit': 'prettier --write "src/**/*.ts"\nnpx lint-staged\n',
    });
    try {
      const { status, stderr } = runGuard([fx.file('package.json'), fx.file('pre-commit')]);
      assert.strictEqual(status, 1, 'a hook that shells prettier --write must fail');
      assert.ok(/pre-commit rewrites/.test(stderr), `should name the hook; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('passes on a verify-only pre-commit hook (control)', () => {
    const fx = makeFixture('hook-verify', {
      'package.json': pkg({ '*.ts': ['prettier --check'] }),
      'pre-commit': 'npx lint-staged\n',
    });
    try {
      const { status, stderr } = runGuard([fx.file('package.json'), fx.file('pre-commit')]);
      assert.strictEqual(status, 0, `verify-only hook must pass; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});

/**
 * Companion spec for scripts/check-src-greppable.mjs.
 *
 * The guard exists because a NUL byte makes grep suppress a file's matching
 * lines while still exiting 0 — the other grep-based guards then read zero
 * violations and report the file clean. These pin that it actually catches the
 * byte, including the exact shapes that were live in src/ before this landed.
 *
 * Its contract is about SHIPPED source in src/ and scripts/, so it enumerates
 * TRACKED files only:
 * Finder drops a binary .DS_Store into every directory it visits, and untracked
 * OS junk must be structurally incapable of failing the gate. The fixtures are
 * real git repositories so the `git ls-files` enumeration itself is exercised,
 * not a stand-in for it.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-src-greppable.mjs');
const NUL = String.fromCharCode(0);

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * Write `files` into a fresh fixture git repo and stage them. Entries whose
 * name is listed in `untracked` are written but deliberately NOT added, so the
 * spec can distinguish shipped source from junk sitting in the tree.
 */
function makeFixture(files: Record<string, string>, untracked: string[] = []): string {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'greppable-'));
  git(root, 'init', '-q');
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    if (!untracked.includes(name)) {
      git(root, 'add', '--', name);
    }
  }
  return root;
}

function runGuard(root: string, dirs: string[] = []): { code: number; output: string } {
  try {
    return {
      code: 0,
      output: execFileSync('node', [SCRIPT, root, ...dirs], { encoding: 'utf8' }),
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('check-src-greppable guard', () => {
  it('passes a tree of plain-text sources', () => {
    const root = makeFixture({
      'a.ts': 'export const a = 1;\n',
      'sub/b.ts': 'export const b = 2;\n',
    });

    assert.strictEqual(runGuard(root).code, 0);
  });

  it('fails a literal NUL used as a delimiter (the commitGraph shape)', () => {
    const root = makeFixture({
      'commitGraph.ts': 'export const key = `${hash}' + NUL + '${root}`;\n',
    });

    const result = runGuard(root);

    assert.strictEqual(result.code, 1);
    assert.match(result.output, /commitGraph\.ts/);
    assert.match(result.output, /NUL byte/);
  });

  it('fails a literal control byte inside a regex class (the validator shape)', () => {
    const root = makeFixture({ 'validator.ts': `if (/[${NUL}-\\x1f]/.test(name)) {}\n` });

    assert.strictEqual(runGuard(root).code, 1);
  });

  it('accepts the escape spelling that replaced them', () => {
    const root = makeFixture({
      'commitGraph.ts': 'export const key = `${hash}\\0${root}`;\n',
      'validator.ts': 'if (/[\\x00-\\x1f\\x7f]/.test(name)) {}\n',
    });

    assert.strictEqual(runGuard(root).code, 0);
  });

  it('ignores an UNTRACKED binary file (the .DS_Store shape)', () => {
    const root = makeFixture({ 'a.ts': 'export const a = 1;\n', '.DS_Store': `junk${NUL}junk` }, [
      '.DS_Store',
    ]);

    assert.strictEqual(
      runGuard(root).code,
      0,
      'OS junk in the working tree must not be able to fail the gate'
    );
  });

  it('still fails a TRACKED binary file', () => {
    const root = makeFixture({ 'a.ts': `const a = '${NUL}';\n` });

    assert.strictEqual(runGuard(root).code, 1);
  });

  it('ignores untracked junk sitting beside a tracked offender, and still reports the offender', () => {
    const root = makeFixture({ 'bad.ts': `const a = '${NUL}';\n`, 'sub/.DS_Store': `junk${NUL}` }, [
      'sub/.DS_Store',
    ]);

    const result = runGuard(root);

    assert.strictEqual(result.code, 1);
    assert.match(result.output, /bad\.ts/);
    assert.doesNotMatch(result.output, /DS_Store/);
  });

  it('skips a tracked file missing from the working tree', () => {
    // A plain `rm` of a tracked file, or a paused rebase, leaves `git
    // ls-files` naming a path that is not on disk. The guard's subject is
    // working-tree content, so an absent file cannot be grep-invisible.
    const root = makeFixture({
      'a.ts': 'export const a = 1;\n',
      'gone.ts': 'export const gone = 2;\n',
    });
    fs.rmSync(path.join(root, 'gone.ts'));

    const result = runGuard(root);

    assert.strictEqual(result.code, 0, `a deleted tracked file must not crash: ${result.output}`);
    assert.ok(result.output.includes('gone.ts'), `the skip must be visible: ${result.output}`);
  });

  it('still reports a real offender alongside a missing file', () => {
    const root = makeFixture({
      'gone.ts': 'export const gone = 2;\n',
      'bad.ts': 'export const key = `' + NUL + '`;\n',
    });
    fs.rmSync(path.join(root, 'gone.ts'));

    const result = runGuard(root);

    assert.strictEqual(result.code, 1, 'the missing file must not mask the offender');
    assert.ok(result.output.includes('bad.ts'));
  });

  it('reports the offending line number', () => {
    const root = makeFixture({ 'a.ts': `const a = 1;\nconst b = '${NUL}';\n` });

    assert.match(runGuard(root).output, /a\.ts:2/);
  });
});

describe('check-src-greppable guard — scanned directories', () => {
  /** Fixture repo with a tracked binary in each of src/, scripts/ and test/. */
  function makeScopeFixture(): string {
    const NUL_FILE = `const sentinel = '${NUL}';\n`;
    return makeFixture({
      'src/a.ts': NUL_FILE,
      'scripts/b.mjs': NUL_FILE,
      'test/c.test.ts': NUL_FILE,
    });
  }

  it('reports offenders in BOTH scanned directories', () => {
    const result = runGuard(makeScopeFixture(), ['src', 'scripts']);

    assert.strictEqual(result.code, 1);
    assert.match(result.output, /src\/a\.ts/);
    assert.match(
      result.output,
      /scripts\/b\.mjs/,
      'scripts/ is in scope — guard scripts hide worst'
    );
  });

  it('leaves test/ out of scope, where binary fixtures are legitimate', () => {
    const result = runGuard(makeScopeFixture(), ['src', 'scripts']);

    assert.doesNotMatch(result.output, /test\/c\.test\.ts/);
  });

  it('pins the real-mode scope to src/ and scripts/', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../scripts/check-src-greppable.mjs'),
      'utf8'
    );
    const declared = /const SCANNED_DIRS = \[([^\]]*)\]/.exec(source)?.[1] ?? '';

    assert.deepStrictEqual(
      declared
        .split(',')
        .map((d) => d.trim().replace(/'/g, ''))
        .filter(Boolean),
      ['src', 'scripts']
    );
  });
});

describe('check-src-greppable guard — the real tree', () => {
  it('passes on the shipped src/ tree', () => {
    assert.match(execFileSync('node', [SCRIPT], { encoding: 'utf8' }), /OK/);
  });
});

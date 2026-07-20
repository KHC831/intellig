/**
 * Companion spec for scripts/check-git-path-unquoted.sh.
 *
 * Proves the guard (a) passes against the real tree, (b) has teeth on both
 * halves of the class — a `(\S+)` token capture over git path output, and a
 * `--name-only` / `ls-tree` invocation without `-z` — and (c) honours the
 * `git-path-quote-exempt` escape hatch. Explicit-path mode treats every
 * given file as non-sanctioned so fixtures exercise the teeth.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-git-path-unquoted.sh');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes/tmp');

function runGuard(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '' };
}

function checkSource(src: string): number | null {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'git-path-guard-'));
  try {
    fs.writeFileSync(path.join(dir, 'offender.ts'), src, 'utf8');
    return runGuard([dir]).status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-git-path-unquoted guard', () => {
  it('passes against the real tree', () => {
    const { status, stdout } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on a clean tree; stdout:\n${stdout}`);
  });

  it('a (\\S+) token capture over a diff --git header fails (has teeth)', () => {
    assert.strictEqual(
      checkSource('const GIT_DIFF_HEADER = /^diff --git\\s+(\\S+)\\s+(\\S+).*$/;\n'),
      1,
      'the whitespace-token header capture must fail the guard'
    );
  });

  it('a (\\S+) capture over apply prose fails', () => {
    assert.strictEqual(
      checkSource('const m = line.match(/^Checking patch (\\S+)\\.\\.\\.$/);\n'),
      1,
      'a token capture over per-file apply prose must fail the guard'
    );
  });

  it('a --name-only invocation without -z fails', () => {
    assert.strictEqual(
      checkSource("const r = await gitCli.exec(['diff', '--name-only', range], opts);\n"),
      1,
      'a path listing without NUL delimiting must fail the guard'
    );
  });

  it('an ls-tree invocation without -z fails', () => {
    assert.strictEqual(
      checkSource("const r = await gitCli.exec(['ls-tree', '--name-only', '-r', hash], opts);\n"),
      1,
      'ls-tree without NUL delimiting must fail the guard'
    );
  });

  it('the same listing WITH -z passes', () => {
    assert.strictEqual(
      checkSource(
        "const r = await gitCli.exec(['ls-tree', '--name-only', '-r', '-z', hash], o);\n"
      ),
      0,
      '-z is the sanctioned way to read paths back'
    );
  });

  it('an ls-files invocation without -z fails', () => {
    assert.strictEqual(
      checkSource("const r = await gitCli.exec(['ls-files', '-u'], opts);\n"),
      1,
      'ls-files emits C-quoted paths'
    );
  });

  it('a status --porcelain invocation without -z fails', () => {
    assert.strictEqual(
      checkSource("const r = await gitCli.exec(['status', '--porcelain'], opts);\n"),
      1,
      'porcelain v1 C-quotes paths'
    );
  });

  it('a diff --name-status invocation without -z fails', () => {
    assert.strictEqual(
      checkSource("const r = await gitCli.exec(['diff', '--name-status', ref], opts);\n"),
      1,
      'name-status emits C-quoted paths'
    );
  });

  it('a diff-tree invocation without -z fails', () => {
    assert.strictEqual(
      checkSource("const r = await gitCli.exec(['diff-tree', '-r', hash], opts);\n"),
      1,
      'diff-tree emits C-quoted paths'
    );
  });

  it('a diff --numstat invocation without -z fails', () => {
    assert.strictEqual(
      checkSource("const r = await gitCli.exec(['diff', '--numstat', range], o);\n"),
      1,
      'numstat C-quotes its path column'
    );
  });

  it('each newly-covered subcommand passes once -z is present', () => {
    const withZ = [
      "const r = await gitCli.exec(['ls-files', '-u', '-z'], opts);\n",
      "const r = await gitCli.exec(['status', '--porcelain', '-z'], opts);\n",
      "const r = await gitCli.exec(['diff', '--name-status', '-z', ref], opts);\n",
      "const r = await gitCli.exec(['diff-tree', '-r', '-z', hash], opts);\n",
      "const r = await gitCli.exec(['diff', '--numstat', '-z', range], opts);\n",
    ];
    withZ.forEach((src) => assert.strictEqual(checkSource(src), 0, src));
  });

  it('honours the git-path-quote-exempt marker on the preceding line', () => {
    assert.strictEqual(
      checkSource(
        '// git-path-quote-exempt: output is only tested for emptiness, never parsed\n' +
          "const r = await gitCli.exec(['diff', '--cached', '--name-only', '--', p], o);\n"
      ),
      0,
      'the escape hatch must suppress the finding'
    );
  });

  it('ignores prose inside comments', () => {
    assert.strictEqual(
      checkSource('// `git diff --name-only oldHash..newHash` gives only that range\n'),
      0,
      'a docblock mentioning the flag is not an invocation'
    );
  });
});

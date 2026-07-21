/**
 * Companion spec for scripts/check-git-path-unquoted.sh.
 *
 * Proves the guard (a) passes against the real tree, (b) has teeth on both
 * halves of the class — a whitespace-token capture (`(\S+)`, `(\S*)`, or the
 * `([^\s]…)` spelling) over git path-output prose OR a listing token (a capture
 * co-located with `ls-tree … -z` still fails, since a whitespace split
 * truncates a spaced name even under -z), and a `--name-only` / `ls-tree`
 * invocation without `-z` — (c) looks up `-z` over the WHOLE enclosing argv
 * array whether the listing sits on the opening `[` line or an inner line, and
 * ignores brackets inside string literals so a stray `'['` cannot bridge the
 * span, and (d) honours the `git-path-quote-exempt` escape hatch. Explicit-path
 * mode treats every given file as non-sanctioned so fixtures exercise the teeth.
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

  it('the ([^\\s]+) spelling of the whitespace token also fails (blind spot closed)', () => {
    assert.strictEqual(
      checkSource('const m = line.match(/^diff --git a\\/([^\\s]+) b\\/([^\\s]+)$/);\n'),
      1,
      'an equivalent capture spelling must not evade the guard'
    );
  });

  it('a (\\S*) capture over a diff --git header fails', () => {
    assert.strictEqual(
      checkSource('const GIT_DIFF_HEADER = /^diff --git\\s+(\\S*)\\s+(\\S*).*$/;\n'),
      1,
      'the star quantifier is the same whitespace token'
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

  it('a prettier-wrapped element-per-line argv keeps -z on a sibling line and passes', () => {
    assert.strictEqual(
      checkSource(
        'const args = [\n' +
          "  'ls-files',\n" +
          "  '-u',\n" +
          "  '-z',\n" +
          '];\n' +
          'const r = await gitCli.exec(args, opts);\n'
      ),
      0,
      '-z on a sibling line of the same [ … ] array must count (no false positive)'
    );
  });

  it('a wrapped element-per-line argv that omits -z still fails', () => {
    assert.strictEqual(
      checkSource(
        'const args = [\n' +
          "  'ls-files',\n" +
          "  '-u',\n" +
          '];\n' +
          'const r = await gitCli.exec(args, opts);\n'
      ),
      1,
      'the enclosing-array lookup must not blanket-pass a genuinely missing -z'
    );
  });

  it('a listing on the array OPENING line still looks up -z on a wrapped sibling', () => {
    // The subcommand shares the `[` line (entering depth 0), and `-z` wraps to
    // the next line. The span lookup must still run for the array this line
    // opens, not skip it because depthBefore is 0 here.
    assert.strictEqual(
      checkSource(
        "const r = await gitCli.exec(['ls-tree', '--name-only', '-r',\n" + "  '-z', hash], opts);\n"
      ),
      0,
      'the enclosing-array lookup must cover an array opened on the listing line'
    );
  });

  it('a stray "[" inside a string must not bridge the span to an unrelated -z', () => {
    // A bracket in a string literal is not argv nesting. Counting it kept depth
    // above zero for the rest of the file, so a genuinely -z-less listing
    // borrowed a `-z` from an unrelated sibling array and passed.
    assert.strictEqual(
      checkSource(
        "const open = '[';\n" +
          "const r1 = gitCli.exec(['rev-parse', '-z'], o);\n" +
          "const r2 = gitCli.exec(['ls-files', '-u'], o);\n"
      ),
      1,
      'a bracket inside a string literal must not count toward argv nesting'
    );
  });

  it('a -z appearing only in a comment line inside the array does not satisfy the guard', () => {
    // The span scan reads every line of the enclosing array; a full-line
    // comment that merely mentions -z is not a real flag and must not count.
    assert.strictEqual(
      checkSource(
        'const args = [\n' +
          "  'ls-files',\n" +
          '  // we could pass -z here\n' +
          "  '-u',\n" +
          '];\n' +
          'const r = await gitCli.exec(args, o);\n'
      ),
      1,
      'a -z inside a comment is not a real NUL-delimiter flag'
    );
  });

  it('a (\\S+) capture co-located with ls-tree fails even when -z is present', () => {
    // `-z` makes arm (b) pass, but a whitespace split still truncates any name
    // carrying a space, so a whitespace-token capture over ls-tree output is
    // wrong regardless of `-z` and must fail on arm (a).
    assert.strictEqual(
      checkSource(
        "const name = (await gitCli.exec(['ls-tree', '-z', ref])).stdout.match(/(\\S+)$/);\n"
      ),
      1,
      'a whitespace-token capture over ls-tree output is wrong even under -z'
    );
  });

  it('an earlier unrelated capture does not mask a real capture over the listing output', () => {
    // Two captures on one line: the first is over `x` (harmless), the second
    // consumes ls-tree output. Keying on the LEFTMOST capture would let the
    // harmless one mask the real one; the check must look for a capture AFTER
    // the listing token.
    assert.strictEqual(
      checkSource(
        "const a = x.match(/(\\S+)/); const n = (await gitCli.exec(['ls-tree', '-z', ref])).stdout.match(/(\\S+)$/);\n"
      ),
      1,
      'a capture positioned after the listing must fire despite an earlier unrelated one'
    );
  });

  it('a -z guarded by an inline block comment on its line still counts', () => {
    // `/* keep */ '-z',` is a code line, not a whole-line comment; the span
    // scan must not treat a leading `/*` as a full comment and drop the -z.
    assert.strictEqual(
      checkSource(
        'const args = [\n' +
          "  'ls-files',\n" +
          "  /* keep */ '-z',\n" +
          '];\n' +
          'const r = gitCli.exec(args, o);\n'
      ),
      0,
      'an inline block comment before -z must not skip the whole line'
    );
  });

  it('an unrelated capture sharing a line with a -z listing does not false-positive', () => {
    // The `(\S+)` is over `other`, not the git output, and the ls-files call is
    // safely NUL-delimited. Arm (a) must fire only when the capture consumes the
    // listing's OUTPUT (positioned after it), not on mere co-location.
    assert.strictEqual(
      checkSource("const b = other.match(/(\\S+)/); const r = exec(['ls-files', '-z'], o);\n"),
      0,
      'a capture positioned before the listing token is not over its output'
    );
  });

  it('a // inside a string argument does not hide a real -z on the same line', () => {
    // Detection reads the raw line, so a `//` inside a string is not mistaken
    // for a comment that swallows the trailing -z.
    assert.strictEqual(
      checkSource("const r = gitCli.exec(['ls-files', 'x//y', '-z']);\n"),
      0,
      'a string containing // must not be treated as a comment'
    );
  });

  it('inline block comments around a listing do not hide a missing -z', () => {
    // A greedy strip would erase the ls-files token between the two comments;
    // reading the raw line keeps the listing visible so the missing -z fails.
    assert.strictEqual(
      checkSource("const r = gitCli.exec([/* cmd */ 'ls-files', /* flag */ '-u']);\n"),
      1,
      'the listing token between two inline comments must still be seen'
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

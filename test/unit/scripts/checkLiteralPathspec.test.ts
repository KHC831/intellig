/**
 * Companion spec for the literal-pathspec guard.
 *
 * The guard is proved to (a) pass against the real tree, (b) have TEETH — a
 * bare path after `--` exits 1, (c) accept the forms that are correct, and
 * (d) fail loudly when it stops matching its own owner. Each teeth assertion
 * carries a negative control, so it cannot pass by the guard rejecting
 * everything it is handed.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const NAME = 'check-literal-pathspec.sh';
const TMP_ROOT = SCRATCH_ROOT;

/**
 * An owner that still exports the wrapper, applies the signature, and
 * declares PATH_SLOT_KIND — everything both guard arms need from it.
 */
const OWNER_PATH = 'git-core/gitCli.ts';
const LITERAL_PATHSPEC_FN =
  'export function literalPathspec(p: string): string {\n' +
  "  if (p === '') {\n" +
  "    throw new Error('empty');\n" +
  '  }\n' +
  '  return `:(literal)${p}`;\n' +
  '}\n';
const INTACT_OWNER =
  LITERAL_PATHSPEC_FN +
  "export const PATH_SLOT_KIND: Readonly<Record<string, 'pathspec' | 'filename'>> = {\n" +
  "  diff: 'pathspec',\n" +
  "  blame: 'filename',\n" +
  '};\n';

/** An owner missing PATH_SLOT_KIND entirely, for the arm's anti-vacuity test. */
const OWNER_WITHOUT_SLOTS = LITERAL_PATHSPEC_FN;

/** An owner whose wrapper no longer refuses an empty path. */
const OWNER_WITHOUT_EMPTY_GUARD =
  'export function literalPathspec(p: string): string {\n  return `:(literal)${p}`;\n}\n' +
  "export const PATH_SLOT_KIND: Readonly<Record<string, 'pathspec' | 'filename'>> = {\n" +
  "  diff: 'pathspec',\n" +
  '};\n';

function overFixture(files: Record<string, string>): { status: number | null; stderr: string } {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'pathspec-guard-'));
  try {
    const withOwner = OWNER_PATH in files ? files : { [OWNER_PATH]: INTACT_OWNER, ...files };
    for (const [rel, content] of Object.entries(withOwner)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    const r = spawnSync('bash', [path.join(process.cwd(), 'scripts', NAME), dir], {
      encoding: 'utf8',
    });
    return { status: r.status, stderr: r.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-literal-pathspec guard', () => {
  it('passes against the real tree', () => {
    const r = spawnSync('bash', [path.join(process.cwd(), 'scripts', NAME)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  });

  for (const [shape, argv] of [
    ['a bare identifier', "gitCli.exec(['checkout', 'HEAD', '--', filePath]);"],
    ['a spread', "gitCli.exec(['add', '--', ...paths]);"],
    ['a member expression', "gitCli.exec(['checkout', 'HEAD^', '--', diff.oldPath]);"],
  ] as const) {
    it(`rejects ${shape} after --`, () => {
      const { status, stderr } = overFixture({ 'ops.ts': `${argv}\n` });
      assert.strictEqual(status, 1, `${shape} must be rejected`);
      assert.match(stderr, /ops\.ts/, `rejected for the wrong reason:\n${stderr}`);
    });
  }

  it('accepts a wrapped path', () => {
    const { status, stderr } = overFixture({
      'ops.ts': "gitCli.exec(['checkout', 'HEAD', '--', literalPathspec(filePath)]);\n",
    });
    assert.strictEqual(status, 0, stderr);
  });

  // The scan finds `--` by literal text, not by parsing the array — nothing
  // here should depend on which quote character an argv element happens to
  // use. eslint enforces single quotes across this codebase today, but a
  // data-loss guard must not go blind if that lint rule ever changes; it
  // reads the language, not a house formatting style.
  it('rejects a bare path after a DOUBLE-quoted --', () => {
    const { status, stderr } = overFixture({
      'ops.ts': 'gitCli.exec(["checkout", "HEAD", "--", filePath]);\n',
    });
    assert.strictEqual(status, 1, 'a double-quoted -- must not hide a bare path');
    assert.match(stderr, /ops\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('accepts a wrapped path after a DOUBLE-quoted --', () => {
    const { status, stderr } = overFixture({
      'ops.ts': 'gitCli.exec(["checkout", "HEAD", "--", literalPathspec(filePath)]);\n',
    });
    assert.strictEqual(status, 0, stderr);
  });

  it('rejects .concat(paths) after a DOUBLE-quoted --', () => {
    const { status, stderr } = overFixture({
      'ops.ts': 'gitCli.exec(["add", "--"].concat(paths));\n',
    });
    assert.strictEqual(status, 1, 'a double-quoted -- must not hide a .concat(rawPaths) bypass');
    assert.match(stderr, /ops\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('accepts a local assigned from the wrapper', () => {
    const { status, stderr } = overFixture({
      'ops.ts':
        'const spec = literalPathspec(filePath);\n' +
        "gitCli.exec(['diff', '--', spec], { cwd });\n",
    });
    assert.strictEqual(status, 0, stderr);
  });

  it('rejects a same-named local that is NOT wrapped', () => {
    // The by-name acceptance is file-wide, so a second local of the same name
    // holding a raw path would otherwise ride in on the first one's exemption
    // — and the call it feeds here is the data-loss one.
    const { status, stderr } = overFixture({
      'ops.ts':
        'const spec = literalPathspec(userPath);\n' +
        "gitCli.exec(['diff', '--', spec], { cwd });\n" +
        'function elsewhere(rawPath: string): void {\n' +
        '  const spec = rawPath;\n' +
        "  gitCli.exec(['checkout', 'HEAD', '--', spec]);\n" +
        '}\n',
    });
    assert.strictEqual(status, 1, 'an unwrapped local of the same name must be rejected');
    assert.match(stderr, /ops\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  // Four bypasses a reviewer wrote to fixtures: the wrapper name is checked
  // for PRESENCE on the line rather than for actually wrapping the flagged
  // argument, and only the FIRST argument after `--` was ever classified.

  it('rejects a bare path even when the wrapper name appears in a trailing comment', () => {
    const { status, stderr } = overFixture({
      'ops.ts':
        "gitCli.exec(['checkout', 'HEAD', '--', filePath]); // TODO literalPathspec later\n",
    });
    assert.strictEqual(status, 1, 'a comment mentioning the wrapper must not exempt a bare path');
    assert.match(stderr, /ops\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('rejects a second bare path on a line whose first path is wrapped', () => {
    const { status, stderr } = overFixture({
      'ops.ts': "gitCli.exec(['diff', '--', literalPathspec(oldPath), newPath]);\n",
    });
    assert.strictEqual(status, 1, 'a later unwrapped argument must not ride in on an earlier wrap');
    assert.match(stderr, /ops\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('rejects a parameter that shares a name with a wrapped local elsewhere in the file', () => {
    const { status, stderr } = overFixture({
      'ops.ts':
        'const spec = literalPathspec(p);\n' +
        'export function f(spec: string): void {\n' +
        "  gitCli.exec(['checkout', 'HEAD', '--', spec]);\n" +
        '}\n',
    });
    assert.strictEqual(
      status,
      1,
      'a parameter shadowing a wrapped local by name must not ride in on it'
    );
    assert.match(stderr, /ops\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('rejects .concat(paths) in place of a spread', () => {
    const { status, stderr } = overFixture({
      'ops.ts': "gitCli.exec(['add', '--'].concat(paths));\n",
    });
    assert.strictEqual(status, 1, '.concat(rawPaths) must be rejected the same as a bare spread');
    assert.match(stderr, /ops\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('accepts a spread of a .map(literalPathspec) result', () => {
    const { status, stderr } = overFixture({
      'ops.ts': "gitCli.exec(['add', '--', ...paths.map(literalPathspec)]);\n",
    });
    assert.strictEqual(status, 0, stderr);
  });

  // extractArgs balances parens across whatever text it is handed, so both
  // arms in this file scan the whole source rather than line by line — a
  // bare path wrapped onto its own line inside a multi-line array literal is
  // still caught.
  it('rejects a bare path in a multi-line array literal', () => {
    const { status, stderr } = overFixture({
      'ops.ts':
        'gitCli.exec([\n' +
        "  'checkout',\n" +
        "  'HEAD',\n" +
        "  '--',\n" +
        '  filePath,\n' +
        ']);\n',
    });
    assert.strictEqual(
      status,
      1,
      'a bare path must not evade the scan by wrapping onto its own line'
    );
    assert.match(stderr, /ops\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('accepts a wrapped path in a multi-line array literal', () => {
    const { status, stderr } = overFixture({
      'ops.ts':
        'gitCli.exec([\n' +
        "  'checkout',\n" +
        "  'HEAD',\n" +
        "  '--',\n" +
        '  literalPathspec(filePath),\n' +
        ']);\n',
    });
    assert.strictEqual(status, 0, stderr);
  });

  it('accepts a string literal after --', () => {
    const { status, stderr } = overFixture({
      'ops.ts': "gitCli.exec(['log', '--', 'src/known/file.ts']);\n",
    });
    assert.strictEqual(status, 0, stderr);
  });

  // A `//` inside a string literal is source text, not a comment start; awk
  // has no lexer, so this arm tracks quote state itself instead of matching
  // `//` textually. Both directions verified against real git separately:
  // 'src/a//b.ts' is a
  // legitimate literal pathspec; a bare path on a line that ALSO carries an
  // unrelated 'https://...' literal is still a real bare path.
  it('does not treat a // inside a string literal as a comment (false FAIL)', () => {
    const { status, stderr } = overFixture({
      'ops.ts': "gitCli.exec(['log', '--', 'src/a//b.ts']);\n",
    });
    assert.strictEqual(status, 0, stderr);
  });

  it('does not let a // inside an unrelated string blank a real bare path off the line (false PASS)', () => {
    const { status, stderr } = overFixture({
      'ops.ts': "gitCli.exec(['checkout', 'https://x', 'HEAD', '--', filePath]);\n",
    });
    assert.strictEqual(status, 1, 'the bare filePath after -- must still be caught');
    assert.match(stderr, /ops\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  // An apostrophe inside a /* ... */ JSDoc comment is not a string quote, so
  // it must not open a phantom string that runs until the next real quote
  // anywhere in the file and desyncs string-vs-code parity for everything
  // after it. Both directions, mirroring
  // the two tests above but with a block comment ahead of the call instead of
  // a string on the same line.
  it('does not let an apostrophe in a block comment hide a real bare path (false PASS)', () => {
    const { status, stderr } = overFixture({
      'ops.ts':
        "/**\n * Uses the repo's root to resolve this.\n */\n" +
        "gitCli.exec(['checkout', 'HEAD', '--', filePath]);\n",
    });
    assert.strictEqual(status, 1, 'a bare path after a block comment must still be caught');
    assert.match(stderr, /ops\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('does not let an apostrophe in a block comment break a correct call further down the file (false FAIL)', () => {
    const { status, stderr } = overFixture({
      'ops.ts':
        "/**\n * Uses the repo's root to resolve this.\n */\n" +
        "gitCli.exec(['checkout', 'HEAD', '--', literalPathspec(filePath)]);\n",
    });
    assert.strictEqual(status, 0, stderr);
  });

  // The lexer's own self-check: if a source file manages to leave it still
  // believing it's inside a string at end of file, that must fail the gate
  // loudly and name the file, not silently return a partially-lexed result.
  it('fails loudly, naming the file, when a source file desyncs the lexer', () => {
    const { status, stderr } = overFixture({
      'ops.ts': "gitCli.exec(['checkout', 'HEAD', '--', literalPathspec('never closed",
    });
    assert.strictEqual(status, 1);
    assert.match(stderr, /ops\.ts/, `must name the desynced file:\n${stderr}`);
    assert.match(stderr, /lexer bug/i, `must say this is a lexer bug:\n${stderr}`);
  });

  it('honours the marker on the line, and on the line above', () => {
    for (const body of [
      "gitCli.exec(['worktree', 'add', '--', dir, ref]); // pathspec-exempt: a directory\n",
      '// pathspec-exempt: a directory\n' + "gitCli.exec(['worktree', 'add', '--', dir, ref]);\n",
    ]) {
      const { status, stderr } = overFixture({ 'ops.ts': body });
      assert.strictEqual(status, 0, stderr);
    }
  });

  it('is NOT un-fenced by a marker parked at the top of the file', () => {
    const { status } = overFixture({
      'ops.ts':
        '// pathspec-exempt: everything below, allegedly\n' +
        'const unrelated = 1;\n'.repeat(3) +
        "gitCli.exec(['checkout', 'HEAD', '--', filePath]);\n",
    });
    assert.strictEqual(status, 1, 'a file-level marker must not un-fence the whole file');
  });

  // The owner file (git-core/gitCli.ts) is the one place a raw '--' argv
  // splice is legitimate — but that must not exempt the WHOLE file from the
  // scan: a second, unrelated bare path added there is caught the same as
  // anywhere else.
  it('rejects a bare path added to the owner file itself, not just its one exempted splice', () => {
    const { status, stderr } = overFixture({
      [OWNER_PATH]: INTACT_OWNER + "gitCli.exec(['checkout', 'HEAD', '--', filePath]);\n",
    });
    assert.strictEqual(status, 1, 'the owner file must not be exempt from the scan');
    assert.match(stderr, /gitCli\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('fails when the owner stops exporting the wrapper', () => {
    const { status, stderr } = overFixture({ [OWNER_PATH]: 'export const nothing = 1;\n' });
    assert.strictEqual(status, 1, 'a missing wrapper must fail loudly');
    assert.match(stderr, /owner/i, `failed for the wrong reason:\n${stderr}`);
  });

  it('fails when the owner stops applying the signature', () => {
    const { status, stderr } = overFixture({
      [OWNER_PATH]: 'export function literalPathspec(p: string): string {\n  return p;\n}\n',
    });
    assert.strictEqual(status, 1, 'a wrapper that no longer wraps must fail loudly');
    assert.match(stderr, /signature/i, `failed for the wrong reason:\n${stderr}`);
  });

  it('fails when the owner stops refusing an empty path', () => {
    // :(literal) with no payload is itself a pathspec that matches every
    // path — a neutered guard here would silently widen every destructive
    // caller (checkout/add/reset/rm) to "match everything".
    const { status, stderr } = overFixture({ [OWNER_PATH]: OWNER_WITHOUT_EMPTY_GUARD });
    assert.strictEqual(status, 1, 'a wrapper that no longer refuses empty must fail loudly');
    assert.match(stderr, /empty/i, `failed for the wrong reason:\n${stderr}`);
  });

  describe('buildGitArgs paths-argument arm', () => {
    it('rejects a buildGitArgs call passing paths for a subcommand missing from PATH_SLOT_KIND', () => {
      const { status, stderr } = overFixture({
        [OWNER_PATH]: INTACT_OWNER,
        'ops.ts': "buildGitArgs('mystery', [], [], [filePath]);\n",
      });
      assert.strictEqual(status, 1, 'an undeclared subcommand with a paths argument must fail');
      assert.match(stderr, /mystery/, `rejected for the wrong reason:\n${stderr}`);
    });

    it('accepts a buildGitArgs call passing paths for a subcommand declared in PATH_SLOT_KIND', () => {
      const { status, stderr } = overFixture({
        [OWNER_PATH]: INTACT_OWNER,
        'ops.ts': "buildGitArgs('diff', [], [], [filePath]);\n",
      });
      assert.strictEqual(status, 0, stderr);
    });

    it('does not flag a buildGitArgs(...) call written inside a comment', () => {
      // The inverse of arm 1's string-literal gap: arm 2 strips comments
      // before scanning, so documenting the table's contract next to a call
      // site — the natural thing to write — does not trip the gate.
      const { status, stderr } = overFixture({
        [OWNER_PATH]: INTACT_OWNER,
        'ops.ts':
          "// Example: buildGitArgs('rm', [], [], [p]) would need a PATH_SLOT_KIND entry.\n" +
          "const a = buildGitArgs('diff', [], [], [p]);\n",
      });
      assert.strictEqual(status, 0, stderr);
    });

    it('does not flag a buildGitArgs call with no paths argument', () => {
      const { status, stderr } = overFixture({
        [OWNER_PATH]: INTACT_OWNER,
        'ops.ts': "buildGitArgs('mystery', [], [ref]);\n",
      });
      assert.strictEqual(status, 0, stderr);
    });

    it('fails loudly when the owner stops declaring PATH_SLOT_KIND (anti-vacuity)', () => {
      const { status, stderr } = overFixture({
        [OWNER_PATH]: OWNER_WITHOUT_SLOTS,
        'ops.ts': "buildGitArgs('diff', [], [], [filePath]);\n",
      });
      assert.strictEqual(
        status,
        1,
        'a missing PATH_SLOT_KIND must fail loudly, not pass vacuously'
      );
      assert.match(stderr, /PATH_SLOT_KIND/, `failed for the wrong reason:\n${stderr}`);
    });

    // A subcommand the guard cannot statically resolve to a string literal
    // cannot be checked against PATH_SLOT_KIND either — and buildGitArgs
    // THROWS on an undeclared subcommand at runtime, so failing open here
    // would let a crash-on-first-exercise ship silently. Fail CLOSED instead,
    // with the same pathspec-exempt escape hatch the first arm uses.
    it('fails closed on a buildGitArgs call whose subcommand cannot be statically resolved', () => {
      const { status, stderr } = overFixture({
        [OWNER_PATH]: INTACT_OWNER,
        'ops.ts': 'const sub = pickSubcommand();\nbuildGitArgs(sub, [], [], [filePath]);\n',
      });
      assert.strictEqual(status, 1, 'a dynamic subcommand must fail closed, not be skipped');
      assert.match(stderr, /ops\.ts/, `rejected for the wrong reason:\n${stderr}`);
    });

    it('accepts a dynamic-subcommand buildGitArgs call marked pathspec-exempt', () => {
      const { status, stderr } = overFixture({
        [OWNER_PATH]: INTACT_OWNER,
        'ops.ts':
          'const sub = pickSubcommand();\n' +
          '// pathspec-exempt: sub is one of a fixed, reviewed literal set\n' +
          'buildGitArgs(sub, [], [], [filePath]);\n',
      });
      assert.strictEqual(status, 0, stderr);
    });

    // The trap this guard must not fall into: buildGitArgs' OWN declaration
    // (`export function buildGitArgs(subcommand: string, flags: string[],
    // refs: string[], paths?: string[])`) is itself a 4-"argument" match for
    // the same text scan, and its first parameter is never a string literal.
    // Fixture mirrors the real declaration shape exactly.
    it('does not flag the buildGitArgs() function declaration itself', () => {
      const { status, stderr } = overFixture({
        [OWNER_PATH]:
          INTACT_OWNER +
          'export function buildGitArgs(\n' +
          '  subcommand: string,\n' +
          '  flags: string[],\n' +
          '  refs: string[],\n' +
          '  paths?: string[]\n' +
          '): string[] {\n' +
          '  return [];\n' +
          '}\n',
      });
      assert.strictEqual(status, 0, stderr);
    });

    // buildGitArgs decides pathspec-vs-filename wrapping itself now — a
    // caller that also wraps risks a doubled :(literal):(literal) signature.
    it('rejects a buildGitArgs call whose paths argument is pre-wrapped with literalPathspec', () => {
      const { status, stderr } = overFixture({
        [OWNER_PATH]: INTACT_OWNER,
        'ops.ts': "buildGitArgs('diff', [], [], [literalPathspec(filePath)]);\n",
      });
      assert.strictEqual(status, 1, 'a pre-wrapped path into buildGitArgs must be rejected');
      assert.match(stderr, /ops\.ts/, `rejected for the wrong reason:\n${stderr}`);
    });

    // Unconditional, unlike the other two rules on this arm: buildGitArgs
    // owns 100% of the pathspec-vs-filename decision now, so there is no
    // longer a legitimate reason for a caller to wrap — pathspec-exempt must
    // NOT excuse this one.
    it('rejects a pre-wrapped path even when the line carries pathspec-exempt', () => {
      const { status, stderr } = overFixture({
        [OWNER_PATH]: INTACT_OWNER,
        'ops.ts':
          "buildGitArgs('diff', [], [], [literalPathspec(filePath)]); " +
          '// pathspec-exempt: bogus\n',
      });
      assert.strictEqual(
        status,
        1,
        'pathspec-exempt must not excuse a pre-wrapped buildGitArgs call'
      );
      assert.match(stderr, /ops\.ts/, `rejected for the wrong reason:\n${stderr}`);
    });
  });
});

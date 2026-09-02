/**
 * Companion spec for scripts/lib/exemptWindow.js's stripLineComments().
 *
 * check-literal-pathspec.sh's two node checkers, and check-ref-name-sort-shared.sh,
 * all read source through this lexer before scanning for the text they care
 * about — a gap here silently desyncs every guard built on it. Pinned
 * directly (no guard had ever exercised this file on its own before): block
 * comments, escaped quotes, template-literal `${...}` interpolation, regex
 * literals, and the end-of-file self-check that turns "this lexer is
 * confused" into a loud failure instead of a silently wrong result.
 */
import * as assert from 'assert';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { stripLineComments, isExemptWindow } = require(
  path.resolve(__dirname, '../../../scripts/lib/exemptWindow.js')
) as {
  stripLineComments: (src: string, label?: string, opts?: { blankStrings?: boolean }) => string;
  isExemptWindow: (lines: readonly string[], lineno: number, marker: string) => boolean;
};

describe('stripLineComments', () => {
  it('blanks a // line comment, preserving every other character offset', () => {
    const src = 'const a = 1; // trailing\nconst b = 2;\n';
    const out = stripLineComments(src);
    assert.strictEqual(out.length, src.length);
    assert.ok(!out.includes('trailing'), `comment text must be blanked:\n${out}`);
    assert.ok(out.includes('const b = 2;'), `code after the comment must survive:\n${out}`);
  });

  it('does not treat a // inside a string as a comment', () => {
    const src = "const url = 'http://x'; // real comment\n";
    const out = stripLineComments(src);
    assert.ok(out.includes("'http://x'"), `the string must survive intact:\n${out}`);
    assert.ok(!out.includes('real comment'), `the trailing comment must be blanked:\n${out}`);
  });

  it('copies an escaped quote through without ending the string early', () => {
    const src = "const s = 'it\\'s ok'; // trailing\n";
    const out = stripLineComments(src);
    assert.ok(out.includes("'it\\'s ok'"), `the escaped-quote string must survive intact:\n${out}`);
    assert.ok(!out.includes('trailing'), `the trailing comment must be blanked:\n${out}`);
  });

  // An apostrophe inside a /* ... */ block comment must not open a phantom
  // string that runs until the next real quote anywhere in the file — here,
  // the opening quote of a later http:// string, which a phantom string
  // would otherwise swallow as its own close, leaving the http:// read as
  // real (non-string) code and its // read as a real comment start.
  it('does not let an apostrophe inside a block comment open a phantom string', () => {
    const src = "/**\n * repo's root.\n */\n" + "const a = 'http://x'; // real comment\n";
    const out = stripLineComments(src);
    assert.strictEqual(out.length, src.length);
    const lines = out.split('\n');
    assert.strictEqual(lines[0].trim(), '', `block comment line must be blanked:\n${out}`);
    assert.strictEqual(lines[1].trim(), '', `block comment line must be blanked:\n${out}`);
    assert.strictEqual(lines[2].trim(), '', `block comment line must be blanked:\n${out}`);
    assert.ok(lines[3].includes("'http://x'"), `the string must survive intact:\n${out}`);
    assert.ok(!lines[3].includes('real comment'), `the trailing comment must be blanked:\n${out}`);
  });

  // A JSDoc line documenting a buildGitArgs(...) call, directly above a
  // real call — a block comment, not a line comment, so it must not desync
  // string state for what follows.
  it('blanks a /* */ block comment documenting a call, leaving the real call visible', () => {
    const src =
      "/** Build the argv for the caller's subcommand. */\n" +
      "const a = buildGitArgs('diff', [], [], [p]);\n";
    const out = stripLineComments(src);
    const lines = out.split('\n');
    assert.strictEqual(lines[0].trim(), '', `block comment line must be blanked:\n${out}`);
    assert.ok(
      lines[1].includes("buildGitArgs('diff', [], [], [p]);"),
      `the real call must survive intact:\n${out}`
    );
  });

  it("does not treat a // inside a template literal's own text as a comment", () => {
    const src = 'const url = `see http://example.com`;\n// trailing\n';
    const out = stripLineComments(src);
    assert.ok(out.includes('http://example.com'), `template text must survive intact:\n${out}`);
    assert.ok(!out.includes('trailing'), `the trailing comment must be blanked:\n${out}`);
  });

  it("treats a // inside a template literal's ${...} interpolation as a real comment", () => {
    const src = 'const x = `${a // real comment\n  + b}`;\n';
    const out = stripLineComments(src);
    assert.ok(
      !out.includes('real comment'),
      `a // inside interpolation is real code, so it must be blanked:\n${out}`
    );
    assert.ok(out.includes('+ b'), `the rest of the interpolation must survive:\n${out}`);
  });

  it('does not let a quote inside a regex literal open a phantom string', () => {
    const src = "const re = /don't match/;\n// after\n";
    const out = stripLineComments(src);
    assert.ok(out.includes("/don't match/"), `the regex literal must survive intact:\n${out}`);
    assert.ok(!out.includes('after'), `the trailing comment must be blanked:\n${out}`);
  });

  it('does not let a // inside a regex literal end it early', () => {
    const src = 'const re = /https?:\\/\\//;\n// after\n';
    const out = stripLineComments(src);
    assert.ok(out.includes('/https?:\\/\\//'), `the regex literal must survive intact:\n${out}`);
    assert.ok(!out.includes('after'), `the trailing comment must be blanked:\n${out}`);
  });

  it('treats a / after a value as division, not a regex start', () => {
    const src = 'const half = total / 2; // trailing\n';
    const out = stripLineComments(src);
    assert.ok(out.includes('total / 2'), `division must survive intact:\n${out}`);
    assert.ok(!out.includes('trailing'), `the trailing comment must be blanked:\n${out}`);
  });

  // A '/"' string cannot contain a raw newline in valid JS/TS: reaching one
  // while still "inside" a string must end the string there, so an earlier
  // stray quote (from some other lexer gap) corrupts at most one line.
  it("does not let an unterminated ' string swallow the rest of the file at a newline", () => {
    const src = "const oops = 'never closed\nconst safe = 1; // trailing\n";
    const out = stripLineComments(src);
    assert.ok(out.includes('const safe = 1;'), `code on the next line must survive:\n${out}`);
    assert.ok(!out.includes('trailing'), `the trailing comment must be blanked:\n${out}`);
  });

  it('throws, naming the file, when the file ends still inside a string', () => {
    const src = "const bad = 'oops";
    assert.throws(
      () => stripLineComments(src, 'weird-file.ts'),
      /weird-file\.ts/,
      'an unterminated string at EOF is a lexer bug and must fail loudly, not return silently'
    );
  });

  it('throws, naming the file, when the file ends still inside a block comment', () => {
    const src = 'const bad = 1; /* never closed';
    assert.throws(
      () => stripLineComments(src, 'weird-file.ts'),
      /weird-file\.ts/,
      'an unterminated block comment at EOF is a lexer bug and must fail loudly, not return silently'
    );
  });

  it('throws, naming the file, when the file ends still inside a template literal', () => {
    const src = 'const bad = `never closed';
    assert.throws(
      () => stripLineComments(src, 'weird-file.ts'),
      /weird-file\.ts/,
      'an unterminated template literal at EOF is a lexer bug and must fail loudly'
    );
  });

  it('does not throw on a well-formed file (no false self-check trip)', () => {
    const src = "const a = 'fine'; const b = `also fine ${a}`;\n// trailing\n";
    assert.doesNotThrow(() => stripLineComments(src, 'ok-file.ts'));
  });

  describe('{ blankStrings: true }', () => {
    it('blanks string payload text, preserving length and quotes', () => {
      const src = "const s = 'headers.sort(x) is the rule';\n";
      const out = stripLineComments(src, undefined, { blankStrings: true });
      assert.strictEqual(out.length, src.length);
      assert.ok(!out.includes('headers.sort'), `payload text must be blanked:\n${out}`);
      assert.ok(out.includes("''") === false && out.includes("'"), `quotes must survive:\n${out}`);
    });

    it('blanks template-literal payload text but leaves ${...} interpolation as real code', () => {
      const src = 'const s = `see http://example.com and ${a.sort(x)}`;\n';
      const out = stripLineComments(src, undefined, { blankStrings: true });
      assert.strictEqual(out.length, src.length);
      assert.ok(!out.includes('http://example.com'), `template text must be blanked:\n${out}`);
      assert.ok(out.includes('a.sort(x)'), `interpolated code must survive:\n${out}`);
    });

    it('does not blank a // comment differently than the default (still a comment)', () => {
      const src = "const s = 'x'; // real comment\n";
      const out = stripLineComments(src, undefined, { blankStrings: true });
      assert.ok(
        !out.includes('real comment'),
        `the trailing comment must still be blanked:\n${out}`
      );
    });

    it('preserves line count and offsets across a multi-line string-heavy file', () => {
      const src = "const a = 'one\\ntwo';\nconst b = `three\nfour`;\nconst c = 1;\n";
      const out = stripLineComments(src, undefined, { blankStrings: true });
      assert.strictEqual(out.length, src.length);
      assert.strictEqual(out.split('\n').length, src.split('\n').length);
      assert.ok(
        out.includes('const c = 1;'),
        `code after string-heavy lines must survive:\n${out}`
      );
    });

    it('leaves an escaped quote inside a string blanked, not ending the string early', () => {
      const src = "const s = 'it\\'s sort(x)'; const after = 2;\n";
      const out = stripLineComments(src, undefined, { blankStrings: true });
      assert.strictEqual(out.length, src.length);
      assert.ok(
        !out.includes('sort(x)'),
        `string payload must be blanked even past an escape:\n${out}`
      );
      assert.ok(out.includes('const after = 2;'), `code after the string must survive:\n${out}`);
    });

    it('is the default (false) when opts is omitted, matching the unblanked behaviour', () => {
      const src = "const url = 'http://x'; // real comment\n";
      const out = stripLineComments(src);
      assert.ok(
        out.includes("'http://x'"),
        `default call must leave string payload intact:\n${out}`
      );
    });
  });
});

// Tokenized with the real TypeScript scanner/parser (ts.createScanner +
// ts.createSourceFile), so regex-vs-division is resolved by the actual
// grammar rather than a "previous token" heuristic. These pin the shapes a
// hand-written heuristic got wrong: a `/` following `++`, `--`, a non-null
// `!`, or a generic's closing `>` is division, never a regex start.
describe('stripLineComments — regex-vs-division after a punctuation-ending operand', () => {
  for (const [shape, src] of [
    ['post-increment', 'const half = i++ / 2;'],
    ['post-decrement', 'const half = i-- / 2;'],
    ['a non-null assertion', 'const half = map.get(k)! / total;'],
    ['a generic close', 'const half = (x as Map<string, number>) / 2;'],
  ] as const) {
    it(`treats ${shape} followed by / as division, not a regex start`, () => {
      const out = stripLineComments(src);
      assert.strictEqual(out, src, `division must survive unchanged:\n${out}`);
    });
  }

  it('blanks a // comment following a post-increment division (does not read it as regex body)', () => {
    const src = 'let ctr = 0;\nexport const halfWidth = ctr++ / 2; // legacy note\n';
    const out = stripLineComments(src);
    assert.ok(out.includes('ctr++ / 2'), `division must survive:\n${out}`);
    assert.ok(!out.includes('legacy note'), `trailing comment must be blanked:\n${out}`);
  });

  it('does not throw when a non-null-assert division is followed by a template literal', () => {
    const src =
      'export function progress(hits: number | undefined, total: number) {\n' +
      '  return { ratio: hits! / total, label: `${hits}/${total}` };\n' +
      '}\n';
    assert.doesNotThrow(() => stripLineComments(src, 'progress.ts'));
  });

  // A correctly-wrapped git call sharing a file with a post-increment
  // division must not desync.
  it('does not desync a correctly-wrapped gitCli.exec call sharing a file with i++ / 2', () => {
    const src =
      'let i = 0;\n' +
      'export const halfWidth = i++ / 2;\n' +
      "gitCli.exec(['diff', '--', literalPathspec(p)]);\n";
    const out = stripLineComments(src);
    assert.strictEqual(out, src, `nothing here should be blanked at all:\n${out}`);
  });
});

// A `\`-line-continuation inside a string or template must not blank away
// the newline it escapes — every line number after it would otherwise shift
// by one.
describe('stripLineComments — backslash line-continuation', () => {
  it('preserves the newline of a line-continuation inside a template literal', () => {
    const src = 'const banner = `line one\\\nline two`;\nconst c = 1;\n';
    const out = stripLineComments(src, undefined, { blankStrings: true });
    assert.strictEqual(out.length, src.length);
    assert.strictEqual(out.split('\n').length, src.split('\n').length);
    assert.ok(out.split('\n')[2].includes('const c = 1;'), `line 3 must still be line 3:\n${out}`);
  });

  it('preserves the newline of a line-continuation inside a plain string', () => {
    const src = "const s = 'one\\\ntwo';\nconst c = 1;\n";
    const out = stripLineComments(src, undefined, { blankStrings: true });
    assert.strictEqual(out.split('\n').length, src.split('\n').length);
    assert.ok(out.split('\n')[2].includes('const c = 1;'), `line 3 must still be line 3:\n${out}`);
  });
});

// A regex literal's PATTERN is prose-like payload text, same as a string or
// template's — in blankStrings mode it must not be able to fake a real call
// site (e.g. a floor that counts `.sort(comparator)` occurrences) while
// leaving the delimiters and flags intact.
describe('stripLineComments — { blankStrings: true } and regex literals', () => {
  it('blanks a regex literal pattern, keeping the delimiters and flags', () => {
    const src = "const re = /don't sort(compareRefNames) here/gi;\n";
    const out = stripLineComments(src, undefined, { blankStrings: true });
    assert.strictEqual(out.length, src.length);
    assert.ok(!out.includes('sort(compareRefNames)'), `pattern text must be blanked:\n${out}`);
    assert.ok(out.includes('/gi'), `flags must survive:\n${out}`);
  });

  it('does not let a regex-literal pattern fake a real .sort(comparator) call', () => {
    const src = 'export const patterns = [\n  /.sort(compareRefNames)/,\n];\n';
    const out = stripLineComments(src, undefined, { blankStrings: true });
    assert.ok(
      !out.includes('.sort(compareRefNames)'),
      `regex text must not read as a real call:\n${out}`
    );
  });

  it('leaves a regex literal pattern intact when blankStrings is off (the default)', () => {
    const src = 'export const patterns = [\n  /.sort(compareRefNames)/,\n];\n';
    const out = stripLineComments(src);
    assert.strictEqual(out, src);
  });
});

// Adversarial cases pinned directly against this implementation: quote and
// comment shapes designed to fool a naive scanner.
describe('stripLineComments — adversarial cases', () => {
  it('does not extend a string past an escaped backslash before the closing quote', () => {
    const src = "const a = 'a\\\\'; // trailing\n";
    const out = stripLineComments(src);
    assert.ok(!out.includes('trailing'));
  });

  it('does not treat a quote inside a line comment as a string start', () => {
    const src = "// it's fine\nconst a = 1;\n";
    const out = stripLineComments(src);
    assert.ok(out.includes('const a = 1;'));
    assert.ok(!out.includes("it's fine"));
  });

  it('does not treat /* */ inside a string as a comment', () => {
    const src = "const s = 'a /* not a comment */ b';\n// after\n";
    const out = stripLineComments(src);
    assert.ok(out.includes('/* not a comment */'));
    assert.ok(!out.includes('after'));
  });

  it('does not let // inside a regex character class end the regex early', () => {
    const src = 'const re = /[a-z]\\/\\/[a-z]/;\n// after\n';
    const out = stripLineComments(src);
    assert.ok(out.includes('/[a-z]\\/\\/[a-z]/'));
    assert.ok(!out.includes('after'));
  });

  it('leaves a nested template inside ${...} interpolation intact', () => {
    const src = 'const s = `outer ${`inner ${x}`}`;\n// after\n';
    const out = stripLineComments(src);
    assert.ok(out.includes('outer '));
    assert.ok(out.includes('inner '));
    assert.ok(!out.includes('after'));
  });

  it('leaves an object literal inside ${...} interpolation intact', () => {
    const src = 'const s = `hi ${ {a:1}.a }`;\n';
    const out = stripLineComments(src);
    assert.strictEqual(out, src);
  });

  it('blanks a block comment written inside ${...} interpolation', () => {
    const src = 'const s = `hi ${ /* cmt */ a }`;\n';
    const out = stripLineComments(src);
    assert.ok(!out.includes('cmt'));
    assert.ok(out.includes(' a '));
  });

  it('does not let */ inside a string end a block comment', () => {
    const src = "const s = '/* not closed here */';\n// after\n";
    const out = stripLineComments(src);
    assert.ok(out.includes('/* not closed here */'));
    assert.ok(!out.includes('after'));
  });

  it('closes consecutive block comments independently', () => {
    const src = '/* one */ /* two */ const a = 1;\n';
    const out = stripLineComments(src);
    assert.ok(!out.includes('one') && !out.includes('two'));
    assert.ok(out.includes('const a = 1;'));
  });

  it('handles a regex literal that itself looks like a comment delimiter', () => {
    const src = 'const re = /\\/\\*/;\n// after\n';
    const out = stripLineComments(src);
    assert.ok(out.includes('/\\/\\*/'));
    assert.ok(!out.includes('after'));
  });

  it('treats a $ not followed by { in a template as plain text', () => {
    const src = 'const s = `cost is $5`;\n// after\n';
    const out = stripLineComments(src);
    assert.ok(out.includes('cost is $5'));
    assert.ok(!out.includes('after'));
  });

  it('closes a deeply nested interpolated template correctly', () => {
    const src = 'const s = `${ `${ {a:1}.a }` }`;\n// after\n';
    const out = stripLineComments(src);
    assert.ok(!out.includes('after'));
  });

  it("handles .replace(/'/g, ...) without opening a phantom string", () => {
    const src = "const a = s.replace(/'/g, '_');\n// after\n";
    const out = stripLineComments(src);
    assert.ok(out.includes("s.replace(/'/g, '_')"));
    assert.ok(!out.includes('after'));
  });

  it('treats a / after => as a regex start', () => {
    const src = 'const f = () => /abc/.test(x);\n';
    const out = stripLineComments(src);
    assert.strictEqual(out, src);
  });

  it('treats a / after : as a regex start', () => {
    const src = 'const o = { re: /abc/ };\n';
    const out = stripLineComments(src);
    assert.strictEqual(out, src);
  });
});

describe('isExemptWindow', () => {
  it('matches the marker on the flagged line itself', () => {
    const lines = ['gitCli.exec(x); // pathspec-exempt: reason'];
    assert.strictEqual(isExemptWindow(lines, 1, 'pathspec-exempt:'), true);
  });

  it('matches the marker on the line directly above', () => {
    const lines = ['// pathspec-exempt: reason', 'gitCli.exec(x);'];
    assert.strictEqual(isExemptWindow(lines, 2, 'pathspec-exempt:'), true);
  });

  it('does not match a marker two lines above', () => {
    const lines = ['// pathspec-exempt: reason', 'const noop = 1;', 'gitCli.exec(x);'];
    assert.strictEqual(isExemptWindow(lines, 3, 'pathspec-exempt:'), false);
  });
});

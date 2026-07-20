/**
 * Companion spec for scripts/lib/source-scan.mjs.
 *
 * The scanner is shared fence infrastructure: check-panel-dispose-seam and
 * check-host-revalidates both build on it. Their specs observe only exit codes,
 * so they can pin lexer behaviour only where it happens to change a verdict.
 * Offset and line-number correctness is invisible that way — escaped-newline
 * drift corrupted `lineAt`/`lineText` while every guard scenario stayed green.
 * These assertions read the three views directly for that reason.
 *
 * ADR-007 asks a fence for a companion spec; this file is that spec for the
 * library two fences stand on. It is deliberately NOT wired into `check:all` —
 * a guard script guarding a library used only by guard scripts is a layer too
 * many, and the unit lane already fails the build.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

interface ScanViews {
  code: string;
  comments: string;
  codeWithStrings: string;
}

const SCANNER = path.resolve(__dirname, '../../../scripts/lib/source-scan.mjs');

// The scanner is ESM and this lane compiles to commonjs, so it is exercised
// out of process — the same way the guard specs drive the guard scripts.
const HARNESS = `
import { scanSource, lineAt, lineText } from ${JSON.stringify(pathToFileURL(SCANNER).href)};
let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  raw += chunk;
}
const request = JSON.parse(raw);
const ops = {
  scan: () => scanSource(request.source),
  lineAt: () => lineAt(request.text, request.index),
  lineText: () => lineText(request.text, request.line),
};
process.stdout.write(JSON.stringify(ops[request.op]()));
`;

function callScanner<T>(request: Record<string, unknown>): T {
  const stdout = execFileSync('node', ['--input-type=module', '-e', HARNESS], {
    input: JSON.stringify(request),
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as T;
}

const scanSource = (source: string): ScanViews => callScanner<ScanViews>({ op: 'scan', source });
const lineAt = (text: string, index: number): number =>
  callScanner<number>({ op: 'lineAt', text, index });
const lineText = (text: string, line: number): string =>
  callScanner<string>({ op: 'lineText', text, line });

/** Offsets of every newline, so position is compared and not merely count. */
function newlineOffsets(text: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      offsets.push(i);
    }
  }
  return offsets;
}

const SAMPLES: Record<string, string> = {
  'line comment': 'const a = 1; // trailing note\nconst b = 2;\n',
  'block comment': '/* leading\n   note */\nconst a = 1;\n',
  'string literal': "const s = 'body text';\n",
  'template literal': 'const t = `body ${x} text`;\n',
  'line continuation': "const s = 'wide \\\n text';\n",
  'regex with quotes': 'const re = /["\']/;\nconst after = 1;\n',
  'regex with slash class': 'const re = /[/]a/;\nconst after = 1;\n',
  'division same line': 'const q = a / b; const after = 1;\n',
  'postfix division': 'const q = i++ / 2; const after = 1;\n',
  'import specifier': "import { X } from './mod/thing';\n",
  'escaped quote in string': "const s = 'it\\'s here';\n",
  'crlf line endings': 'const a = 1;\r\nconst b = 2;\r\n',
};

describe('source-scan lexer', () => {
  describe('view invariants (every sample)', () => {
    it('produces three views the same length as the input', () => {
      for (const [name, source] of Object.entries(SAMPLES)) {
        const views = scanSource(source);
        assert.strictEqual(views.code.length, source.length, `${name}: code length`);
        assert.strictEqual(views.comments.length, source.length, `${name}: comments length`);
        assert.strictEqual(
          views.codeWithStrings.length,
          source.length,
          `${name}: codeWithStrings length`
        );
      }
    });

    it('preserves newline COUNT AND POSITION in every view', () => {
      // Position, not just count: a lost newline that is re-added elsewhere
      // would keep the count and still misplace every line number after it.
      for (const [name, source] of Object.entries(SAMPLES)) {
        const expected = newlineOffsets(source);
        const views = scanSource(source);
        assert.deepStrictEqual(newlineOffsets(views.code), expected, `${name}: code newlines`);
        assert.deepStrictEqual(
          newlineOffsets(views.comments),
          expected,
          `${name}: comments newlines`
        );
        assert.deepStrictEqual(
          newlineOffsets(views.codeWithStrings),
          expected,
          `${name}: codeWithStrings newlines`
        );
      }
    });

    it('keeps code and comments disjoint', () => {
      for (const [name, source] of Object.entries(SAMPLES)) {
        const views = scanSource(source);
        for (let i = 0; i < source.length; i++) {
          const inCode = views.code[i] !== ' ';
          const inComments = views.comments[i] !== ' ';
          if (views.code[i] === '\n') {
            continue;
          }
          assert.ok(
            !(inCode && inComments),
            `${name}: offset ${i} (${JSON.stringify(source[i])}) is in both views`
          );
        }
      }
    });
  });

  describe('masking', () => {
    it('blanks comment bodies in code and keeps them in comments', () => {
      const views = scanSource('const a = 1; // secret note\n');

      assert.ok(!views.code.includes('secret'), 'a comment is not code');
      assert.ok(views.comments.includes('secret'), 'the comment view keeps it');
      assert.ok(views.code.includes('const a = 1;'), 'real code survives');
    });

    it('blanks a block comment body in code', () => {
      const views = scanSource('/* secret note */\nconst a = 1;\n');

      assert.ok(!views.code.includes('secret'));
      assert.ok(views.comments.includes('secret'));
    });

    it('blanks string bodies in code but keeps them in codeWithStrings', () => {
      const views = scanSource("const s = 'secret body';\n");

      assert.ok(!views.code.includes('secret'), 'a string body is not code');
      assert.ok(views.codeWithStrings.includes('secret'), 'module resolution still reads it');
      assert.strictEqual(
        (views.code.match(/'/g) ?? []).length,
        2,
        'both delimiters stay so a literal is still visible in the code view'
      );
    });

    it('blanks code in the comments view', () => {
      const views = scanSource('const uniqueIdentifier = 1;\n');

      assert.ok(!views.comments.includes('uniqueIdentifier'));
    });

    it('keeps an import specifier in codeWithStrings and out of code', () => {
      const views = scanSource("import { X } from './mod/thing';\n");

      assert.ok(views.codeWithStrings.includes('./mod/thing'), 'specifiers must stay resolvable');
      assert.ok(!views.code.includes('./mod/thing'), 'but a specifier is still a string literal');
    });
  });

  describe('regex literals', () => {
    it('does not let a quote inside a regex open string mode', () => {
      const views = scanSource('const re = /["\']/;\nconst afterMarker = 1;\n');

      assert.ok(
        views.code.includes('afterMarker'),
        'code after a quote-carrying regex must stay visible'
      );
    });

    it('masks a regex body in code', () => {
      const views = scanSource('const re = /secretPattern/;\n');

      assert.ok(!views.code.includes('secretPattern'), 'a regex body is not callable code');
    });

    it('ends a regex at an unescaped slash outside a character class', () => {
      const views = scanSource('const re = /[/]x/;\nconst afterMarker = 1;\n');

      assert.ok(views.code.includes('afterMarker'));
    });

    it('treats a slash after an identifier as division, not a regex', () => {
      // The load-bearing direction: reading this as a regex masks to
      // end-of-line and hides whatever follows on the same line.
      const views = scanSource('const q = a / b; const afterMarker = 1;\n');

      assert.ok(views.code.includes('afterMarker'), 'same-line code after division stays visible');
    });

    it('treats a slash after a postfix increment as division', () => {
      const views = scanSource('const q = i++ / 2; const afterMarker = 1;\n');

      assert.ok(views.code.includes('afterMarker'));
    });

    it('treats a slash after a regex-opening keyword as a regex', () => {
      const views = scanSource('function f() { return /secretPattern/.test(s); }\n');

      assert.ok(!views.code.includes('secretPattern'), 'return precedes a regex, not a division');
    });
  });

  describe('offsets stay addressable', () => {
    it('reports the raw-file line for an offset found in the code view', () => {
      const source = ['const a = 1;', "const s = 'x';", 'const targetMarker = 3;'].join('\n');
      const views = scanSource(source);

      const index = views.code.indexOf('targetMarker');
      assert.notStrictEqual(index, -1, 'the marker is visible in the code view');
      assert.strictEqual(lineAt(views.code, index), 3);
      assert.ok(lineText(source, 3).includes('targetMarker'), 'and that line addresses the file');
    });

    it('keeps line numbers addressable across a line continuation', () => {
      // The escaped newline must survive, or every line below it shifts and the
      // guards report a line that does not hold the offending call.
      const source = ["const banner = 'wide \\", " text';", 'const targetMarker = 3;'].join('\n');
      const views = scanSource(source);

      const index = views.code.indexOf('targetMarker');
      assert.notStrictEqual(index, -1);
      assert.strictEqual(lineAt(views.code, index), 3, 'a continuation must not shift the line');
      assert.ok(lineText(source, 3).includes('targetMarker'));
    });

    it('keeps offsets aligned with the raw source for a comment match', () => {
      const source = 'const a = 1;\n// exempt-marker here\nconst b = 2;\n';
      const views = scanSource(source);

      const index = views.comments.indexOf('exempt-marker');
      assert.strictEqual(lineAt(views.comments, index), 2);
      assert.ok(lineText(source, 2).includes('exempt-marker'));
    });
  });

  describe('the real guard scripts scan cleanly', () => {
    it('holds every view invariant over the shipped scripts', () => {
      const dir = path.resolve(__dirname, '../../../scripts');
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.mjs'))
        .map((f) => path.join(dir, f));

      assert.ok(files.length > 0, 'there are scripts to scan');

      for (const file of files) {
        const source = fs.readFileSync(file, 'utf8');
        const views = scanSource(source);
        const expected = newlineOffsets(source);

        assert.strictEqual(views.code.length, source.length, `${file}: code length`);
        assert.deepStrictEqual(newlineOffsets(views.code), expected, `${file}: newline positions`);
        assert.deepStrictEqual(
          newlineOffsets(views.comments),
          expected,
          `${file}: comment newline positions`
        );
      }
    });
  });
});

/*
 * source-scan.mjs — one lexical pass shared by the structural guards.
 *
 * Guards that match patterns against raw TypeScript keep re-learning the same
 * lesson: a mention inside a comment is not code, and a mention inside a string
 * literal is neither code nor comment. Patching that per-evasion produced a
 * round of "closed the constructed hole, left the adjacent one", so both the
 * code view and the comment view are produced ONCE, here.
 *
 * Both views are the SAME LENGTH as the input, with masked characters replaced
 * by spaces and newlines preserved. Offsets and line numbers therefore stay
 * valid in either view, so a guard can locate a match in `code` and inspect the
 * corresponding line in `comments`.
 *
 * Regex literals are lexed as their own context, so a quote character inside
 * one (`/["']/`) cannot open string mode. Their bodies are masked like string
 * bodies. Whether a `/` opens a regex or is division is decided from the last
 * significant token, which is the standard heuristic rather than a parse: after
 * an identifier, number, `)` or `]` a `/` is division, otherwise it opens a
 * regex. The one shape that misreads is a regex immediately after `)`, as in
 * `if (x) /re/.test(y)`, which is treated as division; that direction leaves
 * the body scanned as code rather than blanking real code.
 *
 * The invariants above are pinned in test/unit/scripts/sourceScan.test.ts,
 * asserted on the three views directly. A guard's exit code can only expose
 * lexer behaviour that changes a verdict, so offset and line-number
 * correctness is invisible through the guard suites.
 */

/** Keywords after which a `/` opens a regex literal rather than dividing. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * Split `source` into a code view (comments and string bodies blanked) and a
 * comment view (everything except comment bodies blanked).
 *
 * A third view, `codeWithStrings`, blanks comments only. Import and re-export
 * SPECIFIERS are string literals but are structurally meaningful — you cannot
 * hide a module path in a comment — so module resolution reads that view while
 * call detection reads `code`.
 *
 * @param {string} source
 * @returns {{ code: string, comments: string, codeWithStrings: string }}
 */
export function scanSource(source) {
  const code = [];
  const comments = [];
  const codeWithStrings = [];
  let i = 0;
  /** Last significant (non-whitespace, non-comment) code character seen. */
  let lastSignificant = '';
  /** The significant character before `lastSignificant`, to spot `++` / `--`. */
  let prevSignificant = '';
  /** Trailing identifier run ending at `lastSignificant`, for keyword checks. */
  let lastWord = '';

  const opensRegex = () => {
    if (lastSignificant === '') {
      return true;
    }
    if (/[)\]]/.test(lastSignificant)) {
      return false;
    }
    // A postfix `++` / `--` ends an expression, so the `/` after it divides.
    if (
      (lastSignificant === '+' || lastSignificant === '-') &&
      prevSignificant === lastSignificant
    ) {
      return false;
    }
    if (/[A-Za-z0-9_$]/.test(lastSignificant)) {
      return REGEX_PRECEDING_KEYWORDS.has(lastWord);
    }
    return true;
  };

  const noteSignificant = (ch) => {
    if (/\s/.test(ch)) {
      return;
    }
    prevSignificant = lastSignificant;
    lastSignificant = ch;
    lastWord = /[A-Za-z0-9_$]/.test(ch) ? lastWord + ch : '';
  };

  const push = (ch, intoCode, literal) => {
    if (ch === '\n') {
      code.push('\n');
      comments.push('\n');
      codeWithStrings.push('\n');
      return;
    }
    code.push(intoCode ? ch : ' ');
    comments.push(intoCode ? ' ' : ch);
    // `literal` is the original character for a string body, which `code`
    // blanks but `codeWithStrings` keeps.
    codeWithStrings.push(intoCode ? (literal ?? ch) : ' ');
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    // Line comment
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        push(source[i], false);
        i++;
      }
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      push(source[i], false);
      push(source[i + 1], false);
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        push(source[i], false);
        i++;
      }
      if (i < source.length) {
        push(source[i], false);
        push(source[i + 1], false);
        i += 2;
      }
      continue;
    }

    // String / template literal — the delimiters stay in the code view so a
    // guard can still see that a literal was there; only the body is blanked.
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      push(ch, true);
      noteSignificant(ch);
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          push(' ', true, source[i]);
          // A line continuation escapes a newline. Blanking it would drop the
          // line from every view and misplace every line number below.
          if (i + 1 < source.length) {
            push(source[i + 1] === '\n' ? '\n' : ' ', true, source[i + 1]);
          }
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          push(source[i], true);
          i++;
          break;
        }
        // Blank the body in `code` (a string is not code) but keep it in
        // `codeWithStrings` so module specifiers stay readable.
        push(source[i] === '\n' ? '\n' : ' ', true, source[i]);
        i++;
      }
      continue;
    }

    // Regex literal — lexed as its own context so a quote inside it cannot
    // open string mode. The body is masked like a string body.
    if (ch === '/' && opensRegex()) {
      push(ch, true);
      i++;
      let inClass = false;
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') {
          push(' ', true, source[i]);
          if (i + 1 < source.length) {
            push(' ', true, source[i + 1]);
          }
          i += 2;
          continue;
        }
        if (source[i] === '[') {
          inClass = true;
        } else if (source[i] === ']') {
          inClass = false;
        } else if (source[i] === '/' && !inClass) {
          push(source[i], true);
          i++;
          break;
        }
        push(' ', true, source[i]);
        i++;
      }
      prevSignificant = '/';
      lastSignificant = '/';
      lastWord = '';
      continue;
    }

    push(ch, true);
    noteSignificant(ch);
    i++;
  }

  return {
    code: code.join(''),
    comments: comments.join(''),
    codeWithStrings: codeWithStrings.join(''),
  };
}

/** The 1-indexed line number containing `index`. */
export function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** The full text of 1-indexed `line` in `source`. */
export function lineText(source, line) {
  return source.split('\n')[line - 1] ?? '';
}

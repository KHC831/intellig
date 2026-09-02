const ts = require('typescript');

// Shared by check-literal-pathspec.sh's two standalone node checkers (they
// run as separate processes, so they can't source scripts/lib/exempt-marker.sh
// the way the bash guards do) and by check-ref-name-sort-shared.sh. Same
// window as is_exempt() there: a marker on the flagged line itself, or the
// line directly above it — prettier moves a trailing comment off a
// multi-clause statement, so the above-line form is the stable placement.
function isExemptWindow(lines, lineno, marker) {
  const thisLine = lines[lineno - 1] ?? '';
  const aboveLine = lineno > 1 ? (lines[lineno - 2] ?? '') : '';
  return thisLine.includes(marker) || aboveLine.includes(marker);
}

// Every RegularExpressionLiteral node's start offset, in file order. A `/`
// starts a regex rather than division exactly when the real TypeScript
// grammar says so (post-increment, a non-null assertion, a generic's closing
// `>`, and every other shape that a hand-written "previous token" heuristic
// gets wrong) — parsing the file settles it once, instead of approximating
// it a second time.
function findRegexLiteralStarts(src, label) {
  const ast = ts.createSourceFile(
    label ?? '<input>',
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS
  );
  const starts = [];
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      starts.push(node.getStart(ast));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  starts.sort((a, b) => a - b);
  return starts;
}

// Blank the PAYLOAD of a string/template chunk (`text`), keeping its
// delimiters (`prefixLen`/`suffixLen` characters at each end) and any
// embedded newline intact — never a delimiter or a line break, so offsets
// and line numbers stay aligned with the real source.
function blankChunk(text, prefixLen, suffixLen) {
  const prefix = text.slice(0, prefixLen);
  const suffix = suffixLen > 0 ? text.slice(text.length - suffixLen) : '';
  const middle = text.slice(prefixLen, text.length - suffixLen);
  return prefix + middle.replace(/[^\n]/g, ' ') + suffix;
}

// Blank a regex literal's PATTERN, keeping the two `/` delimiters and any
// trailing flags — a pattern is prose-like payload text, same as a string or
// template's, and a caller scanning for real call syntax (blankStrings mode)
// must not mistake `/.sort(x)/` for one. The closing `/` is found from the
// right: flags are letters-only, so the rightmost `/` after which only
// letters remain is the real delimiter, never an escaped `/` in the body.
function blankRegexChunk(text) {
  const m = /^\/(.*)\/([A-Za-z]*)$/.exec(text);
  if (!m) {
    return text; // unterminated — nothing to safely delimit, leave as-is
  }
  return '/' + m[1].replace(/[^\n]/g, ' ') + '/' + m[2];
}

// Blank every `//` LINE COMMENT and `/* ... */` BLOCK COMMENT, replacing
// comment text (never a newline, so line numbers stay aligned) with spaces —
// every character OFFSET into the file is unchanged, so a position computed
// against the result still maps onto the right line of the real source.
// String, template-literal, and regex-literal text survives untouched: the
// pathspec class this guard exists to close for git ARGUMENTS applies
// equally to itself, so a `//` or a quote written inside one of those
// ('src/a//b.ts', "http://x", `http://x`, /don't/) must never read as a
// comment or a string delimiter.
//
// Tokenized with the real TypeScript scanner, driven by the real parser for
// the one thing the scanner alone can't resolve (whether a `/` starts a
// regex literal or divides two values) — see findRegexLiteralStarts. A
// template literal's `${...}` interpolation is real code: its own strings,
// comments, nested templates, and further interpolation all apply normally,
// tracked via a brace-depth counter per open template level so an object
// literal inside the interpolation doesn't close it early.
//
// opts.blankStrings additionally blanks string and template-literal PAYLOAD
// text (delimiters and embedded newlines survive), leaving `${...}`
// interpolation as real code. Off by default: check-literal-pathspec.sh
// needs string content intact to classify a pathspec argument.
// check-ref-name-sort-shared.sh wants it on, so a doc string or an array of
// prose sentences that happens to spell out `.sort(x)` cannot be mistaken
// for a real call.
//
// Self-check: if the file ends while a string, template literal, or block
// comment is still open, that is a bug in THIS function (real, already
// tsc-clean source has no unterminated string/comment) — throws, naming the
// file, rather than silently returning a partially-scanned result. A string
// that instead ends at a raw newline (the only way one legitimately can,
// mid-file) is not this case: the scanner already recovers there on its own
// and keeps tokenizing the rest of the file normally.
function stripLineComments(src, label, opts = {}) {
  const blankStrings = opts.blankStrings === true;
  const regexStarts = findRegexLiteralStarts(src, label);
  let regexIdx = 0;

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, src);
  const out = [];
  // Stack of enclosing template-literal contexts: one entry per open
  // template, counting unmatched `{` inside its current `${...}`
  // interpolation so an object literal in there doesn't close it early. A
  // `}` at depth 0 closes the interpolation and resumes the template's own
  // text (via reScanTemplateToken), rather than the frame itself — that only
  // happens at the template's closing backtick (TemplateTail).
  const templateBraceDepths = [];

  const fail = (what) => {
    throw new Error(
      `stripLineComments: file ends inside ${what} in ${label ?? '<input>'} — this is a lexer bug, not a source bug.`
    );
  };
  const isTruncatedAtEof = () =>
    (scanner.getTokenFlags() & ts.TokenFlags.Unterminated) !== 0 &&
    scanner.getTextPos() === src.length;

  // Recorded when hit, thrown once after the loop — a single point of truth
  // per kind, rather than a throw duplicated at every call site that can
  // reach EOF unterminated (a template's three: no-substitution, head, and
  // the reScanTemplateToken close).
  let pendingUnterminatedKind = null; // null | 'string' | 'template' | 'comment'
  let pendingUnterminatedQuote = '';

  let tok = scanner.scan();
  while (tok !== ts.SyntaxKind.EndOfFileToken) {
    const pos = scanner.getTokenPos();

    if (
      (tok === ts.SyntaxKind.SlashToken || tok === ts.SyntaxKind.SlashEqualsToken) &&
      regexIdx < regexStarts.length &&
      regexStarts[regexIdx] === pos
    ) {
      tok = scanner.reScanSlashToken();
      regexIdx++;
    }

    if (tok === ts.SyntaxKind.SingleLineCommentTrivia) {
      out.push(scanner.getTokenText().replace(/[^\n]/g, ' '));
    } else if (tok === ts.SyntaxKind.MultiLineCommentTrivia) {
      if (isTruncatedAtEof()) {
        pendingUnterminatedKind = 'comment';
      }
      out.push(scanner.getTokenText().replace(/[^\n]/g, ' '));
    } else if (tok === ts.SyntaxKind.StringLiteral) {
      const text = scanner.getTokenText();
      if (isTruncatedAtEof()) {
        pendingUnterminatedKind = 'string';
        pendingUnterminatedQuote = text[0];
      }
      const closed = !(scanner.getTokenFlags() & ts.TokenFlags.Unterminated);
      out.push(blankStrings ? blankChunk(text, 1, closed ? 1 : 0) : text);
    } else if (tok === ts.SyntaxKind.RegularExpressionLiteral) {
      const text = scanner.getTokenText();
      out.push(blankStrings ? blankRegexChunk(text) : text);
    } else if (tok === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
      const text = scanner.getTokenText();
      if (isTruncatedAtEof()) {
        pendingUnterminatedKind = 'template';
      }
      out.push(blankStrings ? blankChunk(text, 1, 1) : text);
    } else if (tok === ts.SyntaxKind.TemplateHead) {
      const text = scanner.getTokenText();
      if (isTruncatedAtEof()) {
        pendingUnterminatedKind = 'template';
      }
      out.push(blankStrings ? blankChunk(text, 1, 2) : text);
      templateBraceDepths.push(0);
    } else if (tok === ts.SyntaxKind.OpenBraceToken && templateBraceDepths.length > 0) {
      templateBraceDepths[templateBraceDepths.length - 1]++;
      out.push(scanner.getTokenText());
    } else if (
      tok === ts.SyntaxKind.CloseBraceToken &&
      templateBraceDepths.length > 0 &&
      templateBraceDepths[templateBraceDepths.length - 1] === 0
    ) {
      const retok = scanner.reScanTemplateToken(false);
      const text = scanner.getTokenText();
      if (isTruncatedAtEof()) {
        pendingUnterminatedKind = 'template';
      }
      const isTail = retok === ts.SyntaxKind.TemplateTail;
      out.push(blankStrings ? blankChunk(text, 1, isTail ? 1 : 2) : text);
      if (isTail) templateBraceDepths.pop();
    } else if (tok === ts.SyntaxKind.CloseBraceToken && templateBraceDepths.length > 0) {
      templateBraceDepths[templateBraceDepths.length - 1]--;
      out.push(scanner.getTokenText());
    } else {
      out.push(scanner.getTokenText());
    }

    tok = scanner.scan();
  }

  if (pendingUnterminatedKind === 'string') {
    fail(`a ${pendingUnterminatedQuote} string`);
  }
  if (pendingUnterminatedKind === 'template') {
    fail('a template literal');
  }
  if (pendingUnterminatedKind === 'comment') {
    fail('a block comment');
  }

  return out.join('');
}

module.exports = { isExemptWindow, stripLineComments };

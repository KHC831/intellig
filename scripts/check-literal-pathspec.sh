#!/usr/bin/env bash
#
# Structural CI guard — a file path reaches git as a LITERAL pathspec.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    A path handed to git is a PATHSPEC, not a filename: `*`, `?` and `[` are
#    wildcards, and `--` only separates paths from OPTIONS — it does not make
#    what follows literal. So an operation aimed at a file named `a[1].ts` also
#    matched `a1.ts`, because `[1]` is a character class. Verified against real
#    git: `git add -- 'a[1].ts'` staged the neighbour WITH the user's
#    uncommitted work in it, and `git checkout HEAD -- 'a[1].ts'` overwrote the
#    neighbour from HEAD, discarding that work with no error and nothing to
#    undo. Resolving a conflict staged a file that still held its conflict
#    markers. The signature `:(literal)` disables matching for one pathspec;
#    literalPathspec() in src/git-core/gitCli.ts applies it.
#
#    An EMPTY path is the same bug class from the other direction:
#    `:(literal)` with no payload is itself a valid pathspec that matches
#    EVERY path, where the bare '' git receives today is a hard `fatal`
#    (`empty string is not a valid pathspec`). Verified against real git:
#    `git checkout HEAD -- ''` exits 128; `git checkout HEAD --
#    ':(literal)'` exits 0 and reverts the entire working tree. literalPathspec()
#    refuses an empty path outright rather than wrapping it.
#
# 2. Heuristic
#    Everything after a `'--'` element in a git argv is a pathspec. This flags
#    an argv element that follows `'--'` and is neither a literal string nor
#    already wrapped. It scans the WHOLE file, not one line at a time: an argv
#    wrapped onto several lines (the shape prettier produces past printWidth,
#    or a call an author hand-wraps for readability) is not a gap — `--` and
#    its arguments are found and classified wherever in the file they land.
#    Matches `'--'` or `"--"` — this reads the LANGUAGE, not eslint's
#    single-quote house style, so this guard's coverage of a data-loss bug
#    class never depends silently on a rule in a different lane.
#    Both arms read the file through scripts/lib/exemptWindow.js's
#    stripLineComments(): a `//` LINE COMMENT is blanked before either arm
#    looks for `'--',` / `buildGitArgs(` text, but a `//` INSIDE a string or
#    template literal ('src/a//b.ts', "http://x") is left alone — the guard
#    that finds pathspec-magic bugs must not itself fall for treating source
#    text as a comment — awk has no lexer, so this tracks quote state itself
#    rather than matching `//` textually.
#    A pathspec that is MEANT to match a pattern, or an argument after `--`
#    that is not a pathspec at all (`git worktree add -- <dir> <ref>`), may
#    carry `// pathspec-exempt: <reason>` on that line or the one above. The
#    exemption is per LINE, never per file: a marker at the top of a file would
#    silently un-fence everything below it.
#
#    A second arm covers the ONE function that writes `--` itself:
#    `buildGitArgs(subcommand, flags, refs, paths)` (gitCli.ts) decides
#    per-subcommand, via its PATH_SLOT_KIND table, whether to wrap `paths`
#    literal or leave it bare — the first arm's heuristic never sees this,
#    because there is no `'--',` text at any `buildGitArgs(` call site. This
#    arm finds every 4-argument `buildGitArgs(` call, reads its subcommand
#    LITERAL, and fails when that subcommand has no PATH_SLOT_KIND entry — a
#    new caller adding a path slot for an undeclared subcommand fails the gate
#    instead of guessing pathspec-or-filename. The same arm also fails CLOSED
#    when the subcommand cannot be resolved to a string literal at all: since
#    buildGitArgs THROWS on an undeclared subcommand at runtime, skipping an
#    unresolvable call would let that throw ship silently and surface only
#    when some later change happens to exercise the path — a `//
#    pathspec-exempt: <reason>` marker (the same one the first arm uses) is
#    the reviewed escape hatch. And it fails on a `paths` argument that is
#    itself wrapped with `literalPathspec(...)`: buildGitArgs already decides
#    that, so a caller wrapping too risks a doubled `:(literal):(literal)`
#    signature (or a signature landing on a filename-kind subcommand that
#    must never see one) — unconditional, no exempt marker, because there is
#    no longer a legitimate reason for a buildGitArgs caller to wrap.
#
# 3. Known false-positive cases
#    - An argv ASSEMBLED by `push` calls far from the `'--'` itself (a path
#      built up across several statements, not several lines of one literal)
#      is invisible to the first arm — that needs dataflow this guard does
#      not do. This is the remaining gap. A wrapped-onto-several-lines array
#      or `.concat(...)` call is NOT this gap; both arms scan the whole file.
#      Code review covers the dataflow case, and the real-git specs cover the
#      destructive paths.
#    - A local is accepted by NAME, and only when every assignment to that
#      name in the file comes from the wrapper. Reassigning such a local from
#      a raw path (rather than declaring it) still slips through. A path
#      arriving already-wrapped from another module reads as bare here and
#      needs the marker.
#    - Test files are out of scope: a spec may build any argv it likes.
#    - `buildGitArgs`'s OWN declaration (`export function buildGitArgs(subcommand:
#      string, ...)`) is textually a 4-"argument" match for the second arm too,
#      and its first parameter is never a string literal — deliberately
#      excluded (a line immediately preceding `buildGitArgs(` ending in
#      `function` is the declaration, not a call). Proved by removing the
#      exclusion and watching the guard flag its own owner file.
#    - `gitCli.ts` itself is scanned like every other file (no whole-file
#      skip): its one `'--', ...(kind === 'pathspec' ? paths.map(literalPathspec)
#      : paths)` splice decides pathspec-vs-filename at RUNTIME from
#      PATH_SLOT_KIND, which the first arm's static text scan cannot follow —
#      it carries its own `pathspec-exempt` marker, same as any other
#      runtime-decided argument would.
#
# 4. Retirement criteria
#    Retire if every git call moves behind a typed argv builder that takes
#    pathspecs as a distinct type, which would make this a compile error.
#
# 5. Anti-vacuity
#    The owner must still export the wrapper, and the signature it applies must
#    still be the one this guard looks for. Otherwise a rename leaves this
#    scanning for a form nothing produces and printing OK forever. Likewise the
#    buildGitArgs arm requires PATH_SLOT_KIND to parse to at least one entry —
#    a renamed or emptied table would otherwise leave that arm silently
#    checking every subcommand against nothing and always failing (or, if
#    parsing failed open, always passing). The wrapper must also still refuse
#    an empty path (a fixed text window right after its declaration, checked
#    for an empty-string test and a throw) — otherwise a neutered guard prints
#    OK while `literalPathspec('')` silently wraps to the match-everything
#    `:(literal)`.
#
# Exit: 0 on clean. Non-zero if: a bare path follows `--` in a git argv; the
# wrapper no longer refuses an empty path; a buildGitArgs call passes paths
# for a subcommand missing from PATH_SLOT_KIND, for a subcommand that isn't a
# string literal (and isn't marked exempt), or
# with a path pre-wrapped in literalPathspec().

set -euo pipefail

# Both node checkers below run as standalone processes (mktemp'd files), not
# sourced bash — they reach scripts/lib/exemptWindow.js by this absolute
# path rather than sourcing scripts/lib/exempt-marker.sh the way the other
# guards do.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEMPT_WINDOW_LIB="$SCRIPT_DIR/lib/exemptWindow.js"

# Optional scan root so the companion spec can point the guard at a fixture
# tree. Defaults to the real source tree.
SCAN_ROOT="${1:-src}"

OWNER="$SCAN_ROOT/git-core/gitCli.ts"
WRAPPER='literalPathspec'
SIGNATURE=':(literal)'

# Anti-vacuity: the wrapper must exist and must still apply the signature.
if ! grep -q "export function ${WRAPPER}" "$OWNER" 2>/dev/null; then
  echo "literal-pathspec structural guard FAILED — the guard no longer matches its own owner:" >&2
  echo "  $OWNER does not export ${WRAPPER}()." >&2
  echo "  Update OWNER/WRAPPER here, or this guard fences nothing." >&2
  exit 1
fi
if ! grep -qF "$SIGNATURE" "$OWNER"; then
  echo "literal-pathspec structural guard FAILED — the guard no longer matches its own owner:" >&2
  echo "  $OWNER no longer applies the ${SIGNATURE} signature." >&2
  echo "  How a pathspec is made literal must have changed. Update SIGNATURE here." >&2
  exit 1
fi

# Anti-vacuity: the wrapper must still refuse an EMPTY path. `:(literal)` with
# no payload is itself a pathspec that matches every path, where the bare ''
# git receives today is a hard fatal — wrapping it would convert git's own
# refusal into a silent whole-working-tree match on every destructive caller.
# A pure text scan can't run the function, so this looks for the shape
# (an empty-string check followed by a throw) in the lines right after the
# wrapper's declaration — a fixed window, not a balanced-brace parse, is
# adequate here because this is a self-check on the guard's OWN owner, not
# the class defense itself.
EMPTY_PATH_WINDOW="$(grep -A 10 "export function ${WRAPPER}" "$OWNER" 2>/dev/null || true)"
if ! grep -qF "''" <<<"$EMPTY_PATH_WINDOW" || ! grep -q "throw" <<<"$EMPTY_PATH_WINDOW"; then
  echo "literal-pathspec structural guard FAILED — the guard no longer matches its own owner:" >&2
  echo "  ${WRAPPER}() in $OWNER no longer refuses an empty path." >&2
  echo "  An empty path must throw before it reaches the ${SIGNATURE} wrap — restore the guard," >&2
  echo "  or update EMPTY_PATH_WINDOW here if its shape genuinely changed." >&2
  exit 1
fi

# ── First arm: every argument after `'--'` (array-literal form, and the
# `[...].concat(paths)` form) must be a string literal, a literalPathspec(...)
# call, a spread of a .map(literalPathspec) result, or a bare reference to a
# local this file can PROVE is wrapper-only. A real tokenizer (balanced-paren
# comma splitting) rather than a line-substring search, so classification is
# per ARGUMENT, not per line — closes the class of bypass where the wrapper's
# NAME appears somewhere on the line without actually wrapping the flagged
# argument. Written to a temp file for the same reason as the second arm
# below: its own regex/backslash characters never have to survive bash
# double-quote interpolation.
BARE_PATH_CHECKER="$(mktemp -t check-literal-pathspec-bare-path.XXXXXX.js)"
PATH_SLOT_CHECKER=""
trap 'rm -f "$BARE_PATH_CHECKER" "$PATH_SLOT_CHECKER"' EXIT

cat > "$BARE_PATH_CHECKER" <<'NODE_EOF'
const fs = require('fs');
const path = require('path');

const scanRoot = process.argv[2];
const { isExemptWindow, stripLineComments } = require(process.argv[3]);
const WRAPPER = 'literalPathspec';
const MARKER = 'pathspec-exempt:';

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
}
const files = [];
walk(scanRoot, files);

// Local names this file can PROVE are wrapper-only: every const/let
// assignment to the name comes from literalPathspec(...), AND the name is
// never also used as a typed function parameter anywhere in the file (a
// parameter shadows unpredictably — same name, unrelated binding — so
// by-name trust must not extend to it).
function wrapperOnlyLocals(src) {
  const assignCounts = new Map();
  const wrappedCounts = new Map();
  const declRe = /\b(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n;]+)/g;
  let m;
  while ((m = declRe.exec(src)) !== null) {
    const name = m[1];
    const rhs = m[2].trim();
    assignCounts.set(name, (assignCounts.get(name) || 0) + 1);
    if (new RegExp('^' + WRAPPER + '\\(').test(rhs)) {
      wrappedCounts.set(name, (wrappedCounts.get(name) || 0) + 1);
    }
  }
  const paramNames = new Set();
  const paramRe = /[(,]\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
  while ((m = paramRe.exec(src)) !== null) {
    paramNames.add(m[1]);
  }
  const trusted = new Set();
  for (const [name, wrappedN] of wrappedCounts) {
    if (wrappedN > 0 && wrappedN === assignCounts.get(name) && !paramNames.has(name)) {
      trusted.add(name);
    }
  }
  return trusted;
}

// Comma-separated argument tokens starting at `startIdx`, stopping at the
// first bracket/paren that closes one level below where scanning started —
// the enclosing array literal or `.concat(...)` call. Scans across newlines:
// an argv wrapped onto several lines (the shape prettier produces past
// printWidth) is not a gap here, only the OTHER documented one (an argv
// assembled by `push` calls, far from the `'--'` itself, needs dataflow this
// guard does not do).
function extractArgs(codeSrc, startIdx) {
  const args = [];
  let cur = '';
  let depth = 0;
  for (let i = startIdx; i < codeSrc.length; i++) {
    const ch = codeSrc[i];
    if ('([{'.includes(ch)) {
      depth++;
      cur += ch;
    } else if (')]}'.includes(ch)) {
      if (depth === 0) {
        break;
      }
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) {
    args.push(cur.trim());
  }
  return args;
}

function isSafeArg(arg, trusted) {
  const a = arg.replace(/^\.\.\./, '').trim();
  if (/^'[^']*'$/.test(a) || /^"[^"]*"$/.test(a)) {
    return true; // a literal pattern is a deliberate pathspec, not a raw path
  }
  if (new RegExp('^' + WRAPPER + '\\(').test(a)) {
    return true; // wrapped inline
  }
  if (new RegExp('\\.map\\(' + WRAPPER + '\\)$').test(a)) {
    return true; // every element of the spread is wrapped
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(a) && trusted.has(a)) {
    return true; // a local this file proves is wrapper-only
  }
  return false;
}

const violations = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const trusted = wrapperOnlyLocals(src);
  const lines = src.split('\n');
  const codeSrc = stripLineComments(src, file);
  const flaggedLines = new Set();

  // Array-literal form: `'--', a, b, c`, scanned across the WHOLE file — an
  // argv wrapped onto several lines is not invisible here, only a `push`-
  // assembled argv far from the `'--'` itself still is (needs dataflow).
  // Matches either quote character: this reads the LANGUAGE, not eslint's
  // single-quote house style, so a data-loss guard's coverage never depends
  // silently on a lint rule in a different lane.
  const dashRe = /'--',|"--",/g;
  let dashMatch;
  while ((dashMatch = dashRe.exec(codeSrc)) !== null) {
    const dashIdx = dashMatch.index;
    const args = extractArgs(codeSrc, dashIdx + dashMatch[0].length);
    if (args.some((a) => !isSafeArg(a, trusted))) {
      flaggedLines.add(src.slice(0, dashIdx).split('\n').length);
    }
  }

  // `[...'--'].concat(a, b)` form — `'--'` is the array's LAST element, so no
  // comma follows it; the appended arguments never reach an array literal at
  // all. `\s*` between `]` and `.concat(` already spans newlines. Same
  // either-quote match as the arm above.
  const concatRe = /(?:'--'|"--")\]\s*\.concat\(/g;
  let concatMatch;
  while ((concatMatch = concatRe.exec(codeSrc)) !== null) {
    const openIdx = codeSrc.indexOf('(', concatMatch.index);
    const args = extractArgs(codeSrc, openIdx + 1);
    if (args.some((a) => !isSafeArg(a, trusted))) {
      flaggedLines.add(src.slice(0, concatMatch.index).split('\n').length);
    }
  }

  for (const lineno of flaggedLines) {
    // Per-line exemption: this line, or the comment line directly above it —
    // checked against the RAW lines (never comment-stripped), since the
    // marker legitimately lives in a trailing comment.
    if (!isExemptWindow(lines, lineno, MARKER)) {
      violations.push(file + ':' + lineno);
    }
  }
}

if (violations.length > 0) {
  console.error('literal-pathspec structural guard FAILED — a bare path reaches git as a pathspec:');
  for (const v of violations) {
    console.error('  ' + v);
  }
  console.error('');
  console.error("  Everything after '--' in a git argv is a PATHSPEC: a name holding");
  console.error('  *, ? or [ matches OTHER files, and the operation lands on them too.');
  console.error('  Wrap it: ' + WRAPPER + '(path), from src/git-core/gitCli.ts.');
  console.error('  A pathspec that is meant to match a pattern, or an argument after');
  console.error("  '--' that is not a pathspec, may carry a");
  console.error("  '// pathspec-exempt: <reason>' comment.");
  console.error('');
  console.error('See scripts/check-literal-pathspec.sh header for full rationale.');
  process.exit(1);
}
NODE_EOF

if ! node "$BARE_PATH_CHECKER" "$SCAN_ROOT" "$EXEMPT_WINDOW_LIB"; then
  exit 1
fi

# ── Second arm: every 4-argument buildGitArgs() call declares its subcommand
# in PATH_SLOT_KIND. buildGitArgs itself decides pathspec-vs-filename wrapping
# from that table (gitCli.ts), so this arm's job is only to make an undeclared
# subcommand fail loudly instead of buildGitArgs guessing (or throwing only at
# runtime, on whichever code path happens to exercise it). Written to a temp
# file (rather than `node -e "..."`) so its own regex/backslash characters
# never have to survive bash double-quote interpolation.
PATH_SLOT_CHECKER="$(mktemp -t check-literal-pathspec-path-slot.XXXXXX.js)"
# Cleanup: the single trap set above (over BARE_PATH_CHECKER) already covers
# this file too, now that it is non-empty.

cat > "$PATH_SLOT_CHECKER" <<'NODE_EOF'
const fs = require('fs');
const path = require('path');

const scanRoot = process.argv[2];
const { isExemptWindow, stripLineComments } = require(process.argv[3]);
const ownerPath = path.join(scanRoot, 'git-core/gitCli.ts');
let ownerSrc;
try {
  ownerSrc = fs.readFileSync(ownerPath, 'utf8');
} catch {
  console.error('literal-pathspec structural guard FAILED — the guard no longer matches its own owner:');
  console.error('  ' + ownerPath + ' does not exist.');
  process.exit(1);
}
const mapMatch = ownerSrc.match(/PATH_SLOT_KIND[^=]*=\s*{([\s\S]*?)};/);
const known = new Set();
if (mapMatch) {
  for (const m of mapMatch[1].matchAll(/(?:'([^']+)'|([A-Za-z_][\w-]*))\s*:\s*'(?:pathspec|filename)'/g)) {
    known.add(m[1] ?? m[2]);
  }
}
if (known.size === 0) {
  console.error('literal-pathspec structural guard FAILED — the guard no longer matches its own owner:');
  console.error('  ' + ownerPath + ' does not declare a non-empty PATH_SLOT_KIND.');
  console.error('  Update the owner/parsing here, or this arm fences nothing.');
  process.exit(1);
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
}
const files = [];
walk(scanRoot, files);

const MARKER = 'pathspec-exempt:';

const undeclaredViolations = [];
const dynamicViolations = [];
const preWrappedViolations = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  // A `buildGitArgs(...)` written inside a COMMENT (documenting the table's
  // contract next to a call site, the natural thing to write) must not be
  // read as a real call — search the comment-stripped copy, never raw src.
  // Same offsets as src (stripLineComments only blanks comment characters
  // to spaces), so a position found here still maps onto the right line.
  const codeSrc = stripLineComments(src, file);
  let searchFrom = 0;
  while (true) {
    const callStart = codeSrc.indexOf('buildGitArgs(', searchFrom);
    if (callStart === -1) {
      break;
    }
    const start = callStart + 'buildGitArgs('.length;

    // The function's OWN declaration (`export function buildGitArgs(`) is a
    // textual match too, and its first parameter is never a string literal —
    // exclude it deliberately, or it reads as an unresolvable dynamic
    // subcommand and the guard would fence its own definition.
    if (/function\s*$/.test(codeSrc.slice(0, callStart))) {
      searchFrom = start;
      continue;
    }

    let depth = 1;
    let i = start;
    for (; i < codeSrc.length && depth > 0; i++) {
      if (codeSrc[i] === '(') depth++;
      else if (codeSrc[i] === ')') depth--;
    }
    searchFrom = i;
    if (depth !== 0) {
      continue; // unbalanced — malformed or truncated source, skip
    }
    const callBody = codeSrc.slice(start, i - 1);
    const args = [];
    let cur = '';
    let nestDepth = 0;
    for (const ch of callBody) {
      if ('([{'.includes(ch)) nestDepth++;
      else if (')]}'.includes(ch)) nestDepth--;
      if (ch === ',' && nestDepth === 0) {
        args.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim().length > 0) {
      args.push(cur);
    }
    if (args.length < 4) {
      continue; // no paths argument — PATH_SLOT_KIND is never consulted
    }

    const lineno = codeSrc.slice(0, callStart).split('\n').length;
    const exempted = isExemptWindow(lines, lineno, MARKER);

    if (callBody.includes('literalPathspec(')) {
      // buildGitArgs decides pathspec-vs-filename wrapping itself (from
      // PATH_SLOT_KIND) — a caller that also wraps risks a doubled
      // :(literal):(literal) signature on a pathspec-kind subcommand, or a
      // filename-kind subcommand receiving a signature it must never see.
      preWrappedViolations.push(
        file + ':' + lineno + ': buildGitArgs(...) call pre-wraps a path with literalPathspec()'
      );
      continue;
    }

    const litMatch = args[0].trim().match(/^'([^']*)'$|^"([^"]*)"$/);
    if (!litMatch) {
      // A subcommand the guard cannot resolve to a string literal cannot be
      // checked against PATH_SLOT_KIND — and buildGitArgs THROWS on an
      // undeclared subcommand at runtime, so failing open here would let a
      // crash-on-first-exercise ship silently. Fail CLOSED.
      if (!exempted) {
        dynamicViolations.push(
          file +
            ':' +
            lineno +
            ': buildGitArgs(<dynamic subcommand>, ...) passes paths — cannot verify PATH_SLOT_KIND coverage statically'
        );
      }
      continue;
    }
    const name = litMatch[1] ?? litMatch[2];
    if (!known.has(name)) {
      undeclaredViolations.push(
        file +
          ':' +
          lineno +
          ': buildGitArgs(' +
          JSON.stringify(name) +
          ', ...) passes paths for a subcommand missing from PATH_SLOT_KIND'
      );
    }
  }
}

if (preWrappedViolations.length > 0) {
  console.error(
    'literal-pathspec structural guard FAILED — a buildGitArgs call pre-wraps a path that buildGitArgs itself already wraps:'
  );
  for (const v of preWrappedViolations) {
    console.error('  ' + v);
  }
  console.error('');
  console.error('  Pass the raw path — buildGitArgs wraps it (or not) per PATH_SLOT_KIND.');
  process.exit(1);
}
if (dynamicViolations.length > 0) {
  console.error(
    'literal-pathspec structural guard FAILED — a buildGitArgs call passes paths for a subcommand that is not a string literal:'
  );
  for (const v of dynamicViolations) {
    console.error('  ' + v);
  }
  console.error('');
  console.error(
    "  Use a string literal subcommand, or mark the line '// pathspec-exempt: <reason>'."
  );
  process.exit(1);
}
if (undeclaredViolations.length > 0) {
  console.error(
    'literal-pathspec structural guard FAILED — a buildGitArgs call passes paths for an undeclared subcommand:'
  );
  for (const v of undeclaredViolations) {
    console.error('  ' + v);
  }
  console.error('');
  console.error('  Add it to PATH_SLOT_KIND in ' + ownerPath + ': pathspec (glob magic honoured)');
  console.error('  or filename (read/echoed verbatim, e.g. am/apply/blame/check-attr/hash-object).');
  process.exit(1);
}
NODE_EOF

if ! node "$PATH_SLOT_CHECKER" "$SCAN_ROOT" "$EXEMPT_WINDOW_LIB"; then
  exit 1
fi

echo "literal-pathspec structural guard OK (paths reach git as literal pathspecs)."

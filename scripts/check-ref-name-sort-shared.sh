#!/usr/bin/env bash
#
# Structural CI guard — ref names sort through the shared comparator, never a
# bare `.sort()`, ANYWHERE in src. Not an allow-list of known surfaces: a
# directory list can only be as complete as the last audit that wrote it, and
# this class has already re-opened on a surface the list didn't name.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    `Array.prototype.sort()` with no comparator orders by UTF-16 code unit,
#    which puts every capitalised name ahead of every lowercase one
#    (Backup, Upstream, fork, origin). compareRefNames sorts with
#    `localeCompare` (Backup, fork, upstream, Upstream). A tree that mixes the
#    two orders its group HEADERS by one rule and the refs nested under them
#    by another, which reads as a sorting bug with no obvious cause. This class
#    has re-opened twice on a surface the previous fence didn't cover: first
#    the Branches tree's own remote-group headers (fixed, fenced to
#    src/branches only), then the Git tool window's branch filter (fixed,
#    fenced by widening the scan to name that directory too), then the commit
#    details panel's "contained in branches" list (gitParser.ts, nowhere near
#    either directory). A directory allow-list can only be as complete as the
#    last audit; scanning all of `src` closes the class of "a surface the list
#    doesn't name" rather than the third instance of it.
#
# 2. Heuristic + how it scales
#    Any bare, ZERO-ARGUMENT `.sort()` anywhere under SCAN_ROOT fails unless
#    marked. A sort with a comparator argument (`.sort(compareRefNames)`,
#    `.sort((a, b) => …)`) is never matched — out of scope by construction, not
#    by exemption. Plenty of `.sort()` calls in this codebase order commit
#    hashes, opaque fingerprint tokens, filenames, or object keys, not ref
#    names — those carry `// ref-sort-exempt: <reason>` on the sort line or
#    the one above it. Per LINE, never per file.
#
#    Both the bare-sort scan and the routed-sites floor below read source
#    through scripts/lib/exemptWindow.js's stripLineComments(), the same
#    lexer check-literal-pathspec.sh uses — a `//` or `/* ... */` comment is
#    blanked wherever it starts (not just at the start of a line), and string
#    and template-literal payload text is blanked too (`{ blankStrings: true
#    }`), so `.sort()`/`.sort(compareRefNames)` text written in prose or in a
#    doc string is neither a violation nor evidence for the floor — only real
#    call syntax is.
#
# 3. Known false-positive cases
#    A sort whose comparator is supplied on a LATER line than `.sort(` reads
#    as bare. Keep the comparator on the call line.
#
# 4. Retirement criteria
#    Retire if every ref-name list in the codebase moves behind a single
#    collection type that sorts on insertion through compareRefNames, making a
#    bare `.sort()` on a ref list unrepresentable.
#
# 5. Anti-vacuity
#    The shared comparator must still exist and still be exported from its one
#    owner (src/utils/refNameSort.ts — layer-neutral so both host and
#    webview code can import it without a layering violation). If it is renamed or
#    inlined, this guard is fencing against nothing and says so.
#
#    A second anti-vacuity arm, MIN_ROUTED_SITES: the bare-sort scan alone
#    passes a tree where every ref-name sort has been exempt-marked away
#    (real or not — the inversion to scan all of `src` made marking cheap
#    enough that this is a live failure mode, not a hypothetical one). At
#    least MIN_ROUTED_SITES call sites must actually route through
#    ${COMPARATOR:-compareRefNames}; fewer means the class isn't fenced, only
#    quiet. Matches the MIN_HANDLERS convention in
#    check-context-open-no-quickpick.sh. Checked BEFORE the bare-sort scan, so
#    a fixture that is both under the floor and carries a fresh bare sort
#    reports the floor failure (evidence is missing) rather than the
#    bare-sort failure (a site was found and rejected) — the more informative
#    of the two when both are true.
#
# Exit: 0 on clean. Non-zero if: fewer than MIN_ROUTED_SITES sites route
# through the comparator, or a bare sort orders ref names.

set -euo pipefail

# Resolve relative to this script's own location, not the caller's cwd — a
# worktree, a subdirectory, or a CI step with a different cwd must be able to
# invoke this by absolute path too.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEMPT_WINDOW_LIB="$SCRIPT_DIR/lib/exemptWindow.js"

# Optional scan root so the companion spec can point the guard at a fixture
# tree standing in for `src`. Defaults to the real source tree.
SCAN_ROOT="${1:-src}"
OWNER="$SCAN_ROOT/utils/refNameSort.ts"
COMPARATOR='compareRefNames'

if ! grep -q "export function ${COMPARATOR}" "$OWNER" 2>/dev/null; then
  echo "ref-name-sort structural guard FAILED — the comparator it points at is gone:" >&2
  echo "  $OWNER no longer exports ${COMPARATOR}()." >&2
  echo "  Update OWNER/COMPARATOR here, or this guard fences nothing." >&2
  exit 1
fi

# Floor: at least this many call sites must actually route through
# COMPARATOR. Exempt-marking every real site would otherwise pass the
# bare-sort scan below while fencing nothing. Real tree floor today: the
# Branches tree (refPathGrouping.ts, BranchTreeProvider.ts), the Git tool
# window's branch filter host+webview (loadedGraphQueries.ts,
# logFilterLists.ts), and parseContainingBranches (gitParser.ts) — comfortably
# above 3.
MIN_ROUTED_SITES=3

# Both the floor and the bare-sort scan run as one Node process (written to a
# temp file for the same reason as check-literal-pathspec.sh's checkers: its
# own regex/backslash characters never have to survive bash double-quote
# interpolation) so both read source through the SAME real lexer, never a
# second line-prefix comment heuristic.
SCAN_CHECKER="$(mktemp -t check-ref-name-sort-shared.XXXXXX.js)"
trap 'rm -f "$SCAN_CHECKER"' EXIT

cat > "$SCAN_CHECKER" <<'NODE_EOF'
const fs = require('fs');
const path = require('path');

const scanRoot = process.argv[2];
const { isExemptWindow, stripLineComments } = require(process.argv[3]);
const COMPARATOR = process.argv[4];
const MIN_ROUTED_SITES = Number(process.argv[5]);
const MARKER = 'ref-sort-exempt:';

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
}
const files = [];
walk(scanRoot, files);

// A direct `.sort(COMPARATOR)` call — never a comparator-wrapping lambda
// (`.sort((a, b) => COMPARATOR(...))`), which is out of scope by
// construction for the bare-sort scan below and so must not count as
// evidence here either.
const routedRe = new RegExp('\\.sort\\(\\s*' + COMPARATOR + '\\s*\\)', 'g');
const bareRe = /\.sort\(\)/g;

let routedCount = 0;
const violations = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  // Comments (of either shape) AND string/template-literal payload text are
  // blanked before either scan looks for `.sort(...)` — text describing or
  // naming a call, in prose or in a doc string, is neither a real call site
  // nor a real violation. Same offsets as src, so a position found here
  // still maps onto the right line of the real source.
  const codeSrc = stripLineComments(src, file, { blankStrings: true });

  for (const re of [routedRe]) {
    re.lastIndex = 0;
    while (re.exec(codeSrc) !== null) {
      routedCount++;
    }
  }

  bareRe.lastIndex = 0;
  let m;
  while ((m = bareRe.exec(codeSrc)) !== null) {
    const lineno = codeSrc.slice(0, m.index).split('\n').length;
    if (!isExemptWindow(lines, lineno, MARKER)) {
      violations.push(file + ':' + lineno);
    }
  }
}

if (routedCount < MIN_ROUTED_SITES) {
  console.error(`ref-name-sort structural guard FAILED — too few sites route through ${COMPARATOR}:`);
  console.error(`  found ${routedCount}, expected at least ${MIN_ROUTED_SITES}.`);
  console.error('  Exempt-marking every ref-name sort would pass the scan below while');
  console.error('  fencing nothing; this floor requires evidence the comparator is');
  console.error('  actually used. If a real surface genuinely moved away from');
  console.error(`  ${COMPARATOR}, investigate before lowering MIN_ROUTED_SITES here.`);
  process.exit(1);
}

if (violations.length > 0) {
  console.error('ref-name-sort structural guard FAILED — ref names sorted by code unit:');
  for (const v of violations) {
    console.error('  ' + v);
  }
  console.error('');
  console.error(`  Pass ${COMPARATOR} from ${path.join(scanRoot, 'utils/refNameSort.ts')}, so headers and the refs nested`);
  console.error('  under them (on ANY surface — Branches tree or Git tool window');
  console.error('  branch filter) cannot order by different rules. A sort that');
  console.error('  genuinely wants code-unit order (a fingerprint, a hash) may carry');
  console.error("  '// ref-sort-exempt: <reason>'.");
  process.exit(1);
}
NODE_EOF

if ! node "$SCAN_CHECKER" "$SCAN_ROOT" "$EXEMPT_WINDOW_LIB" "$COMPARATOR" "$MIN_ROUTED_SITES"; then
  exit 1
fi

echo "ref-name-sort structural guard OK (ref names sort through one comparator)."

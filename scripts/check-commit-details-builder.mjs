#!/usr/bin/env node
/**
 * Structural CI guard — every ICommitDetails value is composed from the shared
 * base builder, never hand-typed field by field.
 *
 * Maintenance contract (per ADR-007 section "Guard maintenance contract"):
 *
 * 1. Bug class
 *    ICommitDetails carries fields the details panel reads but that are easy to
 *    forget when a literal is typed out: `committer` and `commitDate` drive the
 *    dimmed "Committed by X / on <date>" line, which buildCommittedLine returns
 *    undefined for when either is missing. A hand-built literal therefore
 *    compiles, renders, and silently drops that line for exactly the rebased /
 *    cherry-picked / amended commits it exists to describe. The uniform fix is
 *    `commitNodeToBaseDetails` (graph node) or `commitToBaseDetails` (bare
 *    commit), spread into the literal so every conversion site shares one field
 *    set and a new field reaches all of them at once.
 *
 * 2. Heuristic + how it scales
 *    Scope: every `.ts` under the scan root (argv[2], default src/). Six shapes
 *    are checked:
 *      (a) any object literal in the INITIALISER of a declaration annotated
 *          ICommitDetails / ICommitDetails[] / Array<ICommitDetails>. The
 *          initialiser is walked rather than shape-matched, so a direct
 *          literal, a ternary's arms, an array literal's elements and the
 *          literal a `.map(…)` returns are one rule instead of four patterns,
 *      (b) a literal assigned to a variable DECLARED as ICommitDetails, which
 *          is the shape a deferred `let x: ICommitDetails | undefined` takes,
 *      (c) a literal asserted (`} as ICommitDetails`, `} satisfies ICommitDetails`),
 *      (d) an inline object literal passed straight to a details-panel model
 *          builder (getDetailsPanelModel / buildDetailsPanelModel /
 *          _getDetailsPanelModel),
 *      (e) a literal RETURNED from a function whose return type is
 *          ICommitDetails — the shape of `getExpandedCommitDetails`, the very
 *          site this guard exists to protect, and
 *      (f) a literal pushed into an ICommitDetails array.
 *    Each must contain `...commitNodeToBaseDetails(` or `...commitToBaseDetails(`
 *    within its braces. A site that legitimately cannot use the builder marks
 *    itself `commit-details-builder-exempt: <reason>` inside the literal.
 *
 * 3. Known false-positive cases
 *    A test fixture or a partial literal cast through `as never` is out of
 *    scope (src only, annotated or builder-fed shapes only). A future builder
 *    with a different name must be added to BUILDERS below, not exempted.
 *
 *    The RETURNS arm scans a matched signature's whole body, so a nested helper
 *    inside an ICommitDetails-returning function has its `return {` checked too;
 *    that over-scans rather than under-scans, and a genuine case takes the
 *    exempt annotation.
 *
 *    Arm (a) walks the whole initialiser, so a literal passed as an ARGUMENT
 *    there is flagged too — `const d: ICommitDetails = makeDetails({ raw: 1 })`
 *    reports the argument. Over-scanning is the safe direction and the exempt
 *    annotation clears it; the alternative is teaching the walk which calls
 *    produce the value, which is the type-checker's job.
 *
 *    Three views, three questions. STRUCTURE and COMPLIANCE read the shared
 *    scanner's code view: a brace steers nothing from inside a string, and
 *    naming the builder in a comment or a string does not compose with it, so
 *    neither can silence this fence. EXEMPT reads the COMMENT view, because the
 *    hatch is a claim and a claim has to be a comment — spelled inside a string
 *    it is just a string. Route a new test to whichever view answers its
 *    question; against raw text, a compliance test is a bypass and a hatch test
 *    accepts a string.
 *
 *    The hatch is scoped to the literal it exempts and must sit INSIDE it:
 *      const d: ICommitDetails = {
 *        // commit-details-builder-exempt: <reason>
 *        hash, message,
 *      };
 *    A comment on the line above the statement does NOT exempt, deliberately:
 *    one statement can hold several literals — a ternary's two arms are
 *    reported separately — and a line above would blanket all of them. The same
 *    principle governs the focus fence, where the hatch sits inside the
 *    function body it exempts.
 *
 * 4. Known false-negative cases, stated in full. A fence's declared coverage
 *    must equal its ACTUAL coverage: what it fails to catch is fine once
 *    stated, but a silent failure is worse than no fence, because the next
 *    author reads this list and trusts it.
 *      (a) a literal reaching ICommitDetails purely by inference — passed to a
 *          function whose parameter is typed but whose name is not in
 *          PANEL_BUILDER, or returned from an un-annotated arrow whose type
 *          comes from context — is not detected. Closing it needs the
 *          type-checker.
 *      (b) the RETURNS arm anchors on `: ICommitDetails` directly, so a WRAPPED
 *          return type (`Promise<ICommitDetails>`, `ResultAsync<…>`) is out of
 *          scope entirely, braced body or not.
 *    (b) is latent: src/ has no async/wrapped producer today. It is stated so a
 *    future author adding the first one is not misled. Do NOT close it with
 *    another per-shape regex — the shapes always lag, which is why arm (a)
 *    walks an initialiser instead of matching spellings; reach for the
 *    type-checker if this list stops being adequate.
 *
 *    A concise-arrow ternary body was listed here until arm (a) began walking
 *    initialisers: `(): ICommitDetails => b ? {…} : {…}` carries the annotation
 *    that arm matches, so both arms are now reported. Widening one arm can
 *    close a gap declared against another — re-verify this list whenever the
 *    matching changes, not only the entry being edited.
 *    NOT gaps — all covered and pinned in
 *    test/unit/scripts/checkCommitDetailsBuilder.test.ts: every one of the six
 *    arms, the ternary / array-literal / `.map` / logical-fallback initialiser
 *    shapes, `satisfies`, a hand-built arm sitting beside a builder arm, a
 *    reassignment to an initialised declaration, a builder named only in a
 *    comment or a string, a brace inside a string, the nested-literal skip, the
 *    initialiser's statement boundary, the exempt annotation inside a cast, and
 *    a missing scan root.
 *
 * 5. Retirement criteria: retire when ICommitDetails is constructed through a
 *    single factory whose parameter type makes a partial literal fail to
 *    compile — a branded or required-field-complete type — so a hand-built
 *    value cannot type-check in the first place.
 *
 *    Re-proving this guard: target the commit BEFORE "Let the selection own the
 *    log window's details panel, focus, and file rows", which is the revision
 *    that actually contains the bug. The builders themselves are OLDER than
 *    that, so "before the builder existed" points somewhere else entirely and
 *    yields a red that proves nothing. Extract with `git show <rev>:<path>`
 *    into a fixture root; never reach for the working tree or the stash.
 *
 *    A re-proof must be DISCRIMINATING, not merely red: run the real fence and
 *    a mechanism-blind copy (BUILDERS neutered) against the same revision and
 *    require their verdicts to DIFFER — fewer sites flagged by the real fence
 *    at the buggy revision, and silent-versus-flagging at the fixed one. At the
 *    wrong ancestor the two agree and the red is vacuous. Counts are not
 *    recorded here because they move whenever an arm is added; the property is
 *    what must hold. A red that a mechanism-blind fence also produces is not
 *    evidence.
 *
 *    Read the guard's own violation banner, not just the exit code: a crashing
 *    or mis-edited copy also exits non-zero, and reads as a verdict.
 *
 *    Arm (b) is the sole catcher of the originating defect: disable it against
 *    that revision and the bug escapes, while disabling any other arm leaves it
 *    red. Treat arm (b) as load-bearing when refactoring, and re-run the
 *    isolation before trusting a green suite.
 *
 * Usage:
 *   node scripts/check-commit-details-builder.mjs
 *     — real mode: scans src/.
 *   node scripts/check-commit-details-builder.mjs <srcRoot>
 *     — fixture mode (companion spec): scans an arbitrary root.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scanSource } from './lib/source-scan.mjs';

const srcDir = process.argv[2] ?? 'src';

const BUILDERS = /\.\.\.commitNodeToBaseDetails\(|\.\.\.commitToBaseDetails\(/;
const EXEMPT = /commit-details-builder-exempt:/;
/**
 * Any declaration annotated with the details type, matched up to its `=`. The
 * initialiser is then WALKED for object literals rather than matched shape by
 * shape, so a direct literal, a ternary, an array literal and a `.map(…)` are
 * all one rule. Adding a regex per spelling is what lets the next spelling
 * through.
 */
const ANNOTATED_DECL =
  /:\s*(?:ICommitDetails\s*\[\]|Array<\s*ICommitDetails\s*>|ICommitDetails)\s*=/g;
const PANEL_BUILDER =
  /(?:_getDetailsPanelModel|getDetailsPanelModel|buildDetailsPanelModel)\(\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{/g;
/**
 * A variable declared as ICommitDetails, whose LATER assignments are checked.
 * The declaration is matched whether or not it carries an initialiser: arm (a)
 * covers the initialiser, but only this arm sees `d = { … }` further down, so
 * excluding initialised declarations would drop every reassignment to them.
 */
const DECLARED = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*ICommitDetails\b/g;
/** `as` and `satisfies` are the same assertion for this fence's purposes. */
const CAST = /\}(?:\s*|\s*\)\s*)(?:as|satisfies)\s+ICommitDetails\b/g;
/**
 * A signature returning ICommitDetails with a BRACED body, whose every
 * `return {` builds one.
 *
 * A concise arrow (`): ICommitDetails => ({…})`) is deliberately NOT matched
 * here: its `: ICommitDetails =` is the same text ANNOTATED_DECL anchors on, so
 * arm (a) walks that initialiser and reports the literal. An alternative for it
 * was unreachable on every input — do not re-add one.
 */
const RETURNS = /\)\s*:\s*ICommitDetails\b[^{;=]*(\{)/g;
/**
 * `list.push({` where `list` is annotated as an ICommitDetails array. Matches
 * the annotation wherever it appears — a declaration, a class field, or a
 * PARAMETER, which is the common shape for a function that fills a list.
 */
const ARRAY_DECL = /([A-Za-z_$][\w$]*)\s*:\s*(?:ICommitDetails\[\]|Array<ICommitDetails>)/g;

/** Every `.ts` file under `dir`, recursively. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The source of the object literal whose opening `{` is at `open`, brace-
 * matched so nested literals stay inside. Returns '' when unbalanced.
 *
 * The parameter is the CODE VIEW, in which string and comment bodies are
 * blanked, so a `}` inside a string cannot end the literal early. Every brace
 * matcher here takes that view and none takes raw text — naming the parameter
 * `code` keeps that readable at the call site, since the raw source is in scope
 * under `src` and passing it would silently reintroduce the bug.
 */
function literalAt(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') {
      depth++;
    } else if (code[i] === '}') {
      depth--;
      if (depth === 0) {
        return code.slice(open, i + 1);
      }
    }
  }
  return '';
}

/**
 * The initialiser that starts just after `eq`, ending at the `;` that closes
 * the statement at nesting depth 0 (or end of source). Returns [start, end).
 */
function initialiserRange(code, eq) {
  let depth = 0;
  for (let i = eq + 1; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
    } else if (ch === ';' && depth === 0) {
      return [eq + 1, i];
    }
  }
  return [eq + 1, code.length];
}

/**
 * Absolute offsets of the object literals directly inside [start, end) — a
 * literal nested inside another is skipped, since the outer one is reported and
 * carries it. A `{` counts as a literal only in value position; `=> {` opens a
 * function body, not an object.
 */
function literalsIn(code, start, end) {
  const found = [];
  for (let i = start; i < end; i++) {
    if (code[i] !== '{') {
      continue;
    }
    let j = i - 1;
    while (j >= start && /\s/.test(code[j])) {
      j--;
    }
    const prev = j >= start ? code[j] : '=';
    // `|` and `&` cover the logical-fallback shapes (`cached || { … }`), which
    // produce the annotated value on the miss path exactly as a ternary arm does.
    if ('=([,?:|&'.includes(prev)) {
      found.push(i);
      const literal = literalAt(code, i);
      if (literal === '') {
        break;
      }
      i += literal.length - 1;
    }
  }
  return found;
}

/** The literal whose closing `}` sits at `close`, brace-matched backwards. */
function literalEndingAt(code, close) {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (code[i] === '}') {
      depth++;
    } else if (code[i] === '{') {
      depth--;
      if (depth === 0) {
        return code.slice(i, close + 1);
      }
    }
  }
  return '';
}

// A missing root means the fence is aimed at nothing. Skipping quietly would
// read as a pass, so say so and fail.
if (!existsSync(srcDir)) {
  console.error(`check:commit-details-builder: ${srcDir} does not exist — nothing scanned.`);
  process.exit(1);
}

const offenders = [];
for (const file of walk(srcDir)) {
  const src = readFileSync(file, 'utf8');
  // Structure is read off the code view so a brace or an `ICommitDetails`
  // mention inside a string or comment cannot steer the scan; the reported
  // body is sliced from the original at the same offsets, because the exempt
  // annotation is a comment.
  const { code, comments } = scanSource(src);
  // Three views, three questions. BUILDERS asks whether the literal really
  // spreads the builder, so it reads CODE — naming the builder in a comment or
  // a string composes nothing. EXEMPT asks whether an author claimed an
  // exception, and that claim must be a real COMMENT, so it reads the comment
  // view — a hatch spelled inside a string is not a claim, it is a string.
  const report = (index, bodyCode, bodyComments) => {
    if (bodyCode === '' || BUILDERS.test(bodyCode) || EXEMPT.test(bodyComments)) {
      return;
    }
    offenders.push(`${file}:${src.slice(0, index).split('\n').length}`);
  };
  /** The literal opening at `open`, as [code, comments]. */
  const bodyAt = (open) => {
    const span = literalAt(code, open);
    return span === '' ? ['', ''] : [span, comments.slice(open, open + span.length)];
  };

  PANEL_BUILDER.lastIndex = 0;
  let panel;
  while ((panel = PANEL_BUILDER.exec(code)) !== null) {
    report(panel.index, ...bodyAt(panel.index + panel[0].length - 1));
  }

  // Every object literal in an annotated declaration's initialiser, whatever
  // shape the initialiser takes.
  ANNOTATED_DECL.lastIndex = 0;
  let annotated;
  while ((annotated = ANNOTATED_DECL.exec(code)) !== null) {
    const eq = annotated.index + annotated[0].length - 1;
    const [start, end] = initialiserRange(code, eq);
    for (const open of literalsIn(code, start, end)) {
      report(open, ...bodyAt(open));
    }
  }

  CAST.lastIndex = 0;
  let cast;
  while ((cast = CAST.exec(code)) !== null) {
    const span = literalEndingAt(code, cast.index);
    const start = cast.index - span.length + 1;
    report(cast.index, span, span === '' ? '' : comments.slice(start, cast.index + 1));
  }

  // A function whose return type is ICommitDetails: every `return {` in its
  // body builds one. Scanning to the next signature keeps nested helpers out.
  RETURNS.lastIndex = 0;
  let sig;
  while ((sig = RETURNS.exec(code)) !== null) {
    const open = sig.index + sig[0].length - 1;
    // A concise arrow body IS the returned literal; a braced body is scanned
    // for its `return {` statements.
    if (sig[1] !== '{') {
      report(sig.index, ...bodyAt(open));
      continue;
    }
    const bodySpan = literalAt(code, open);
    const RETURN_LITERAL = /return\s*\{/g;
    let ret;
    while ((ret = RETURN_LITERAL.exec(bodySpan)) !== null) {
      report(open + ret.index, ...bodyAt(open + ret.index + ret[0].length - 1));
    }
  }

  // A literal pushed into an ICommitDetails array.
  ARRAY_DECL.lastIndex = 0;
  let arr;
  while ((arr = ARRAY_DECL.exec(code)) !== null) {
    const push = new RegExp(`\\b${arr[1]}\\.push\\(\\s*\\{`, 'g');
    let hit;
    while ((hit = push.exec(code)) !== null) {
      report(hit.index, ...bodyAt(hit.index + hit[0].length - 1));
    }
  }

  // A variable declared as ICommitDetails and assigned a literal later.
  DECLARED.lastIndex = 0;
  let decl;
  while ((decl = DECLARED.exec(code)) !== null) {
    const assign = new RegExp(`\\b${decl[1]}\\s*=\\s*\\{`, 'g');
    let hit;
    while ((hit = assign.exec(code)) !== null) {
      report(hit.index, ...bodyAt(hit.index + hit[0].length - 1));
    }
  }
}

if (offenders.length > 0) {
  console.error('Hand-built ICommitDetails literal(s) — spread the shared builder instead:');
  for (const o of offenders) {
    console.error(`  ${o}`);
  }
  console.error(
    '\nUse `...commitNodeToBaseDetails(node)` (graph node) or `...commitToBaseDetails(commit)`,\n' +
      'or annotate the literal `commit-details-builder-exempt: <reason>`.'
  );
  process.exit(1);
}

console.log('check:commit-details-builder OK');

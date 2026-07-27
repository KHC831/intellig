#!/usr/bin/env node
/**
 * Structural CI guard — a public entry point that rebuilds the tool window's
 * document either proves it only does so on a real change, or says why it
 * cannot.
 *
 * Maintenance contract (per ADR-007 section "Guard maintenance contract"):
 *
 * 1. Bug class
 *    Every render reassigns `webview.html`, and the document builder puts a
 *    fresh CSP nonce in each document, so a reassignment is always a real
 *    iframe reload — scroll, focus and the log filter's uncommitted draft die
 *    with the old document. The draft is the sharp case: the host renders only
 *    the COMMITTED filter text, so what the user has typed exists nowhere but
 *    the DOM being discarded.
 *
 *    Three public setters were reached by a watcher tick, a finished command or
 *    a console clear and repainted regardless of whether anything they show had
 *    changed. Because output comparison cannot help (the nonce differs every
 *    time), the guard has to be on STATE, and nothing made that a requirement.
 *    This fence makes "renders unguarded" unwritable without a stated reason.
 *
 * 2. Heuristic + how it scales + which spec case pins which arm
 *    Scan the class body of GitToolWindowProvider.ts (or <file> in fixture
 *    mode) through scripts/lib/source-scan.mjs. Four steps:
 *
 *    (a) SITES — matches of the render entry-point set in the CODE view:
 *        `_render`, `_renderForGesture`, `_renderOnResolve`,
 *        `_renderSidebarPlaceholder`, `updateWebview`. Two of these assign
 *        `webview.html` directly and three route into `_render`; all five are
 *        matched because a caller of any of them rebuilds the document. The set
 *        is matched by alternation, never by a `this._render` prefix, which
 *        would swallow `_renderSidebarPlaceholder` under the wrong name.
 *
 *    (b) OWNERS — nearest preceding declaration at class-body indent (two
 *        spaces), anchored on the OPENING PAREN of the declaration line only.
 *        Requiring `)` or `{` on that line mis-attributes every multi-line
 *        header, and three such headers are live in this file: `updateLogState`,
 *        `updateConsoleEntry` and `_onResolve` all take parameters across
 *        lines. `updateLogState` is the setter this whole effort is built
 *        around, so that mis-attribution would drop it from the inventory
 *        entirely while blaming its neighbour. Pinned by the multi-line,
 *        inline-object and `protected override` fixture headers in the
 *        companion spec, which assert the mapping's OUTPUT rather than that the
 *        script merely passes.
 *
 *    (c) PUBLIC — `public` or no modifier at all. Most of this class's public
 *        surface carries no keyword, including `updateWebview`, the most
 *        render-heavy entry point in the file, so a fence keyed on the literal
 *        word would silently drop it. `private`/`protected` are excluded, and
 *        so is `constructor`: it cannot be called twice on one instance, so an
 *        idempotence claim about it is meaningless and an annotation on it
 *        would permanently inflate the count section 3 promises will only fall.
 *
 *    (d) VERDICT — each public owner must either be a KEY of the idempotence
 *        spec's exported table, or carry `render-unconditional: <reason>` in
 *        the COMMENT view within its own span. A site sitting inside a NESTED
 *        function body requires the annotation regardless: the enclosing
 *        method's idempotence entry says nothing about a render that happens
 *        on a callback rather than on the call, and accepting it there is the
 *        fail-open shape (`attachGitService`'s three renders live in tab
 *        `onStateChange` lambdas and would otherwise be pre-blessed by a spec
 *        entry that never reaches them).
 *
 *    O(lines); scales with the file for free.
 *
 * 3. Known false-positive cases — and the honest starting position
 *    THIS FENCE BEGINS LIFE AS A RATCHET, NOT A GATE. Five of its ten owners
 *    start annotated, so a green run does NOT mean every public setter is
 *    guarded. It means every unguarded one has stated why.
 *
 *    Starting line, measured: 10 public owners, 5 in the idempotence table,
 *    5 annotated. The annotations are NOT five equivalent debts, and reading
 *    them as one number is misleading — they split two ways:
 *
 *    DESIGN-PERMANENT (4) — these are facts about what the method is, and no
 *    future work retires them. Deleting one of these annotations would be a
 *    defect, not progress:
 *      - `attachGitService`: renders sit in tab `onStateChange` callbacks; a
 *        second call re-subscribes rather than rendering, so an idempotence
 *        entry would pass while asserting nothing about them.
 *      - `updateWebview`: the deliberate unconditional gesture-render seam.
 *        Rendering on every call IS its contract.
 *      - `addConsoleEntry`: appends, so two identical calls are two different
 *        states and two renders is correct.
 *      - `setFocusedBranch`: renders unconditionally on all three of its paths.
 *        Arguably fixable — a guard on the focused branch would be real work,
 *        not a relabelling — but nothing about the method makes it inevitable.
 *        Also `async`, so any future count must await it.
 *
 *    DEFECT-DEFERRED (1) — the actual outstanding debt:
 *      - `updateConsoleEntry`: re-renders when written identical values. A real
 *        defect, out of the scope that introduced this fence, and the
 *        annotation is where it stays visible.
 *
 *    So THE FLOOR IS 4, not 0, and the count may only ever decrease toward it.
 *    Adding an annotation is a review event, not a routine escape — the rule
 *    the god-file ratchet applies to budgets, applied to hatches. A run that
 *    reports 5 has one debt outstanding; a run that reports 6 has grown one.
 *
 * 4. Known false-negative cases, stated in full:
 *      (a) SCOPE. Only the provider class file is scanned. Handlers extracted
 *          to `provider/` reach the document through `ctx.updateWebview()` and
 *          are invisible here; `check-focus-restore-on-render` arm (a) covers
 *          that directory instead. A named boundary, not an oversight — but it
 *          means moving a rendering setter OUT of this file removes it from
 *          this inventory silently, which is why the companion spec asserts an
 *          owner floor rather than trusting a green run.
 *      (b) ALIASING AND INDIRECTION. `const r = this._render.bind(this)`, or a
 *          private helper that renders and is called from a public setter,
 *          evade a literal-text scan. The helper case is partly covered: the
 *          helper is itself an owner, so it is either in the table or
 *          annotated — but the PUBLIC caller is not flagged.
 *      (c) A render reached through a conditional that is always true, or
 *          guarded on something that is not actually document-observable, is
 *          structurally indistinguishable from a real guard. Only the
 *          idempotence spec can tell, and only for the methods it covers.
 *      (d) Per-owner, not per-path: an owner whose one branch renders guarded
 *          and another unguarded reads as guarded.
 *      (e) NAMED DIVERGENCE FROM THE DESIGN. The fence design asks for the
 *          per-method idempotence positive control — break one method's guard,
 *          assert that method's spec goes red — as a PERMANENT spec. It is not
 *          one. Half of it is: `renderIdempotence.test.ts` carries the vacuity
 *          probe, which asserts each case's arranged scenario really renders,
 *          so a case cannot pass by never rendering at all. The other half,
 *          breaking the guard itself, stays a MANUAL harness:
 *          `npm run mutate:render-idempotence`
 *          (`test/harnesses/renderIdempotenceGuards.mutate.mjs`). Its sibling
 *          `npm run mutate:render-guard-arms` does the same to THIS script's
 *          own arms. Both restore the file and assert the restore. Neither
 *          carries a `check:` prefix on purpose: `check-all-complete` requires
 *          every `check:` script to run inside the gate, and a harness that
 *          mutates production source must never do that.
 *
 *          Why it is not in the suite: permanence would mean mutating
 *          production source from inside a test, which leaves a dirty tree and
 *          makes the run order-dependent, or patching a compiled guard at
 *          runtime, which is a different and weaker test. A weaker test wearing
 *          the stronger one's name is the hollow-entry defect this table exists
 *          to prevent, one level up. So the mutation half is run by hand, and
 *          this entry is here so nobody reads the suite as covering it.
 *
 *          Anyone running that harness, or writing another: a mutation that
 *          does not COMPILE proves nothing. A tsc failure makes mocha bail with
 *          "Cannot find module test/setup", and a harness reading exit codes
 *          scores that as a kill. Require positive evidence the suite ran, and
 *          neuter values rather than deleting them, so a mutation cannot
 *          orphan a local and fail to build.
 *
 * 5. Retirement criteria: retire when the render entry points take a
 *    change-reason argument that the type checker requires, so an unguarded
 *    repaint fails to compile rather than needing a fence to notice it.
 *
 * Usage:
 *   node scripts/check-render-guards.mjs
 *     — real mode: the provider class + the idempotence table's keys.
 *   node scripts/check-render-guards.mjs <file> <key,key,...>
 *     — fixture mode (companion spec): scan <file>, treat the comma-separated
 *       list as the idempotence table's keys. Prints the same summary line.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanSource } from './lib/source-scan.mjs';

const [argFile, argKeys] = process.argv.slice(2);
const fixtureMode = argFile !== undefined;

const target = fixtureMode
  ? argFile
  : join('src', 'git-core', 'gitToolWindow', 'GitToolWindowProvider.ts');

// A missing target means the fence is aimed at nothing. Skipping quietly reads
// as a pass, which is the fail-open this project keeps rediscovering.
if (!existsSync(target)) {
  console.error(`check:render-guards: ${target} does not exist — nothing scanned.`);
  process.exit(1);
}

/** Statement keywords that take `(` — never a declaration being made. */
const NOT_A_NAME = /^(?:if|for|while|switch|catch|return|else|do|with)$/;

/**
 * A class-body member declaration: two-space indent, optional modifiers, a
 * name, then the opening paren. Anchored on `(` ALONE — no closing paren, no
 * body brace — so a header whose parameters span lines still maps to itself.
 */
const DECL =
  /^ {2}(?:(public|private|protected)\s+)?(?:(?:static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;

/** Every entry point that ends in a `webview.html` reassignment. */
const RENDER_SITE =
  /this\.(?:_render|_renderForGesture|_renderOnResolve|_renderSidebarPlaceholder|updateWebview)\s*\(/;

const ANNOTATION = /render-unconditional:/;

const source = readFileSync(target, 'utf8');
const { code, comments } = scanSource(source);
const rawLines = source.split('\n');
const codeLines = code.split('\n');
const commentLines = comments.split('\n');

// Bound the scan to the class body so a two-space-indented object-literal key
// at module level cannot be read as a member declaration.
const classStart = codeLines.findIndex((l) => /^export (?:default )?(?:abstract )?class\s/.test(l));
if (classStart === -1) {
  console.error(`check:render-guards: no class declaration found in ${target} — nothing scanned.`);
  process.exit(1);
}

/** Declarations, in file order. */
const owners = [];
for (let i = classStart + 1; i < codeLines.length; i++) {
  const match = DECL.exec(codeLines[i]);
  if (match && !NOT_A_NAME.test(match[2])) {
    owners.push({ name: match[2], modifier: match[1], line: i });
  }
}

/**
 * Is the site at `lineIndex` inside a nested function body rather than directly
 * in its owner's body?
 *
 * Callbacks are what matter: only they introduce a new call boundary, so a
 * render inside one does not happen on the owner's call and the owner's
 * idempotence entry can never reach it. Blocks (`if`/`for`) indent too but
 * introduce no boundary, so they do not count.
 *
 * Three spellings, because the first version knew only two and the third is
 * ordinary TypeScript: an arrow, a `function` expression, and OBJECT-LITERAL
 * METHOD SHORTHAND (`{ onChange() { … } }`), including `get`/`set` accessors.
 * The shorthand carries neither `=>` nor `function`, so a render inside it was
 * credited to the enclosing method — the exact pre-blessing this check exists
 * to prevent, in the one shape it could not see. This class already wires hooks
 * through object literals (`createConsoleTabHandler({ clearConsole: … })`);
 * those happen to be arrows today, and nothing makes the next one an arrow.
 *
 * The shorthand arm keys on a callable header indented DEEPER than the owner:
 * the scan is bounded to the class body and the owner is known, and a class
 * member cannot nest inside another member, so anything deeper is necessarily
 * inside something.
 */
function insideNestedFunction(ownerLine, lineIndex) {
  const NESTED_METHOD_SHORTHAND =
    /^\s{4,}(?:(?:get|set|async|static)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{;]+)?\{\s*$/;
  for (let i = ownerLine + 1; i < lineIndex; i++) {
    const shorthand = NESTED_METHOD_SHORTHAND.exec(codeLines[i]);
    // `if (…) {` has the shape of a method shorthand and is not one. Without
    // this the arm reads every guarded setter as nested, which turns the whole
    // fence into a demand for annotations on the methods that got it right.
    if (shorthand && !NOT_A_NAME.test(shorthand[1])) {
      return true;
    }
    if (/(?:=>|\bfunction\b)\s*(?:\{|\()/.test(codeLines[i])) {
      const opens = (codeLines[i].match(/\{/g) ?? []).length;
      const closes = (codeLines[i].match(/\}/g) ?? []).length;
      if (opens > closes) {
        return true;
      }
    }
  }
  return false;
}

const sites = [];
for (let i = classStart + 1; i < codeLines.length; i++) {
  if (!RENDER_SITE.test(codeLines[i])) {
    continue;
  }
  let owner;
  for (let k = owners.length - 1; k >= 0; k--) {
    if (owners[k].line < i) {
      owner = owners[k];
      break;
    }
  }
  // A site nobody owns means the mapping could not parse the file. Continuing
  // silently is how a mapping fence reports OK on a file it did not understand.
  if (!owner) {
    console.error(
      `check:render-guards: render at ${target}:${i + 1} has no enclosing declaration — mapping failed.`
    );
    process.exit(1);
  }
  sites.push({ line: i, owner, nested: insideNestedFunction(owner.line, i) });
}

const tableKeys = new Set(
  fixtureMode
    ? (argKeys ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : readIdempotenceKeys()
);

/**
 * The idempotence spec's exported table, read from source. The spec generates
 * one `it()` per key, so a name cannot be listed here without being exercised —
 * "listed" and "called twice" are the same fact by construction.
 */
function readIdempotenceKeys() {
  const specPath = join('test', 'unit', 'services', 'gitToolWindow', 'renderIdempotence.test.ts');
  if (!existsSync(specPath)) {
    console.error(`check:render-guards: ${specPath} does not exist — the table is unreadable.`);
    process.exit(1);
  }
  const spec = scanSource(readFileSync(specPath, 'utf8')).code;
  // The declaration's TYPE contains `=>`, so "up to the first `=`" stops in the
  // wrong place. Anchor on the first `=` that is not an arrow, then brace-match
  // the literal rather than guessing where it ends. Read off the code view, so
  // a brace inside a string cannot steer the match.
  const open = /RENDER_IDEMPOTENCE_CASES[\s\S]*?=(?!>)\s*\{/.exec(spec);
  if (!open) {
    console.error(`check:render-guards: could not find RENDER_IDEMPOTENCE_CASES in ${specPath}.`);
    process.exit(1);
  }
  const start = open.index + open[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = start; i < spec.length; i++) {
    if (spec[i] === '{') {
      depth++;
    } else if (spec[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    console.error(`check:render-guards: RENDER_IDEMPOTENCE_CASES in ${specPath} is unterminated.`);
    process.exit(1);
  }
  const keys = [...spec.slice(start, end).matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)].map(
    (m) => m[1]
  );
  if (keys.length === 0) {
    console.error(`check:render-guards: RENDER_IDEMPOTENCE_CASES in ${specPath} has no entries.`);
    process.exit(1);
  }
  return keys;
}

/** The owner's span, for reading its annotation out of the comment view. */
function spanOf(owner) {
  const next = owners.find((o) => o.line > owner.line);
  return { from: owner.line, to: next ? next.line : commentLines.length };
}

const offenders = [];
const annotated = new Set();
const covered = new Set();
const publicOwners = new Set();

for (const site of sites) {
  const { owner } = site;
  const isPublic = owner.modifier === undefined || owner.modifier === 'public';
  // Idempotence is meaningless for a constructor; see section 2(c).
  if (!isPublic || owner.name === 'constructor') {
    continue;
  }
  publicOwners.add(owner.name);

  const span = spanOf(owner);
  const hasAnnotation = ANNOTATION.test(commentLines.slice(span.from, span.to).join('\n'));
  if (hasAnnotation) {
    annotated.add(owner.name);
    continue;
  }
  if (site.nested) {
    offenders.push(
      `${target}:${site.line + 1} ${owner.name} — render sits in a nested callback, so an ` +
        `idempotence entry cannot reach it; annotate the method instead`
    );
    continue;
  }
  if (tableKeys.has(owner.name)) {
    covered.add(owner.name);
    continue;
  }
  offenders.push(
    `${target}:${site.line + 1} ${owner.name} — public and renders, but is neither a key of ` +
      `RENDER_IDEMPOTENCE_CASES nor annotated`
  );
}

console.log(
  `check:render-guards: sites=${sites.length} owners=${publicOwners.size} ` +
    `covered=${covered.size} annotated=${annotated.size}`
);

// A file that exists but yields no sites means the regex rotted or the code
// moved. Same fail-open as a missing file, wearing a different hat.
if (sites.length === 0) {
  console.error(`check:render-guards: no render sites found in ${target} — the scan found nothing.`);
  process.exit(1);
}

if (offenders.length > 0) {
  console.error('Unconditional-render contract violation(s):');
  for (const o of offenders) {
    console.error(`  ${o}`);
  }
  console.error(
    '\nGuard the render on state the document actually shows and add the method to\n' +
      'RENDER_IDEMPOTENCE_CASES, or annotate it `// render-unconditional: <reason>`.\n' +
      'The annotation count may only ever decrease.'
  );
  process.exit(1);
}

console.log('check:render-guards OK');

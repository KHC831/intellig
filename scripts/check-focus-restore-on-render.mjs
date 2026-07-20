#!/usr/bin/env node
/**
 * Structural CI guard — a webview handler that triggers a full render says
 * whether it answers a user gesture, and gesture-ness never becomes sticky
 * state.
 *
 * Maintenance contract (per ADR-007 section "Guard maintenance contract"):
 *
 * 1. Bug class
 *    `updateWebview()` reassigns `webview.html`, so every focusable element in
 *    the document is destroyed. The tool window's keyboard surfaces are
 *    delegated — the commit-row handler keys off
 *    `e.target.closest('.commit-row[data-hash]')`, the tab strip off its roving
 *    tabindex — so after a render with focus on `<body>` the next arrow press
 *    finds no target and the keyboard loop is silently dead.
 *
 *    The fix is `updateWebview(true)`, which lets the webview honour its
 *    persisted focus claim for that one document. It is an ARGUMENT rather than
 *    a "mark the next render" latch on purpose: a latch could be armed by a
 *    gesture that then produced no render (clicking the already-active tab,
 *    which `setActiveTab` early-returns on) and the next ambient render — a
 *    `.git` watcher tick — would spend it, stealing focus from wherever the
 *    user had moved on to. This guard keeps both halves true.
 *
 * 2. Heuristic + how it scales
 *    Two arms.
 *
 *    (a) Handler modules, every `.ts` under
 *        <scanRoot>/git-core/gitToolWindow/provider/ RECURSIVELY: any function
 *        calling `updateWebview(` must pass `true` or declare
 *        `focus-restore-exempt: <reason>` INSIDE its body — the annotation is
 *        matched against the function it sits in, and a line above the header
 *        belongs to the preceding function. Headers recognised: `export
 *        function f(` and `export default function f(`, plain `function f(`
 *        (including helpers above the first export), `export const f = …` /
 *        `const f = …` for an arrow whose parameters are parenthesised or not,
 *        a class method and an object-literal method, each optionally generic
 *        (`f<T>(`). The file is scanned from byte 0, so a helper hiding above
 *        the first export is checked like any other — which is also what closes
 *        the indirect case: a wrapper delegating to a local helper is caught AT
 *        the helper.
 *
 *    (b) GitToolWindowProvider.ts: `_restoreFocusOnNextRender` may only be
 *        WRITTEN inside `_renderForGesture`, which raises and drops it around
 *        one synchronous `_render()`. That is what makes the leak in the bug
 *        class above unwritable rather than merely avoided. A write counts
 *        whether it is spelled `=`, `||=`, `&&=`, `??=`, or an object-literal
 *        key handed to `Object.assign`; the field's own declaration does not.
 *
 * 3. Known false-positive cases
 *    A programmatic (non-gesture) entry point renders with no focus to hand
 *    back — `selectCommits` is the current example and is exempt-annotated.
 *    Restoring focus there would pull it out of whatever the user is using.
 *
 *    Three views, three questions. Whether a function RENDERS, and whether it
 *    renders for a gesture, read the shared scanner's code view, so a
 *    commented-out or quoted `updateWebview(true)` neither counts as a render
 *    nor silences the fence. EXEMPT reads the COMMENT view, because the hatch
 *    is a claim and a claim has to be a comment — spelled inside a string it is
 *    just a string. Route a new test to whichever view answers its question;
 *    against raw text, a compliance test is a bypass and a hatch test accepts a
 *    string.
 *
 *    The hatch is scoped to the function it exempts and must sit inside that
 *    function's body — a line above the header belongs to the function before
 *    it. The details-builder fence follows the same principle one level down,
 *    where the hatch sits inside the literal.
 *
 * 4. Known false-negative cases, stated in full:
 *      (a) arm (a) checks each function where its own render call sits, so a
 *          handler that renders by calling into a module OUTSIDE provider/ is
 *          only caught if that module is scanned too.
 *      (b) arm (a) matches the literal `updateWebview(true)`. Aliasing the
 *          method (`const r = ctx.updateWebview.bind(ctx)`) evades it, as does
 *          a handler whose one branch passes `true` while another does not —
 *          the check is per-function, not per-path. Both are contrived; review
 *          covers them.
 *      (c) a METHOD header split across lines is not recognised, so its body is
 *          read as part of the preceding function — the method arm requires the
 *          body brace on the header line. A split `function` or arrow header IS
 *          recognised, because its arm anchors on the name and `(`. Prettier
 *          keeps these on one line at the widths this repo uses.
 *      (d) arm (b) does not classify the provider's own ~17 `_render()` call
 *          sites as gesture or ambient — no regex tells a click handler from a
 *          watcher tick. It fences the STATE that turned a misclassification
 *          into a leak, which is the part that can be made unwritable.
 *      (e) arm (b) fences `_restoreFocusOnNextRender` BY NAME. A future
 *          gesture-stickiness latch introduced under a different field name is
 *          not covered; add it to ASSIGN when one appears.
 *    NOT gaps — all covered and pinned in
 *    test/unit/scripts/checkFocusRestoreOnRender.test.ts: both arms, the class
 *    and object-literal method shapes, a generic `function` and a generic
 *    arrow, an unparenthesised arrow parameter, a default-exported function, a
 *    handler in a SUBDIRECTORY, an unexported const arrow, a generic method, a
 *    statement keyword that must not read as a function name, a gesture render
 *    that is only commented out or quoted, the logical-assignment and
 *    Object.assign writes, the field declaration that is not a write, the
 *    exempt annotation, and a missing scan root.
 *
 * 5. Retirement criteria: retire when `updateWebview` takes a required
 *    gesture/ambient argument rather than an optional boolean, so a handler
 *    that forgets to say which it is fails to compile.
 *
 *    Re-proving ARM (a): target the commit BEFORE "Let the selection own the
 *    log window's details panel, focus, and file rows". Extract with
 *    `git show <rev>:<path>` into a fixture root; never reach for the working
 *    tree or the stash.
 *
 *    The tree-wide red there is NOT evidence on its own: nothing in that tree
 *    passed `true`, so a gesture-blind copy that flags every rendering handler
 *    scores the same. Two things discriminate — the FIXED tree, where the real
 *    fence is silent and a blind copy still flags one handler, and a
 *    single-site reversion on the fixed tree, which must flip that site alone.
 *    Require the real fence and a mechanism-blind copy to DIFFER; a red a
 *    gutted fence also produces is not evidence.
 *
 *    ARM (b) has no historical red and is not re-provable that way.
 *    `_restoreFocusOnNextRender` arrived in the same commit as this guard, so
 *    no ancestor contains a violating write. It is a forward-only
 *    unwritability fence: its evidence is the companion spec's constructed
 *    writes, not history.
 *
 * Usage:
 *   node scripts/check-focus-restore-on-render.mjs
 *     — real mode: scans src/.
 *   node scripts/check-focus-restore-on-render.mjs <srcRoot>
 *     — fixture mode (companion spec): scans an arbitrary root.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scanSource } from './lib/source-scan.mjs';

const srcRoot = process.argv[2] ?? 'src';
const toolWindowDir = join(srcRoot, 'git-core', 'gitToolWindow');
const providerDir = join(toolWindowDir, 'provider');
const providerClass = join(toolWindowDir, 'GitToolWindowProvider.ts');

/** Statement keywords that take `(` — never a function being declared. */
const NOT_A_NAME = /^(?:if|for|while|switch|catch|return|else|do|with)$/;

const HEADERS = [
  /^(?:export )?(?:export default )?(?:async )?function ([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/,
  // An arrow may be generic (`<T,>(…)`) and may take a single unparenthesised
  // parameter, both of which sit between the `=` and the body.
  /^export const ([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:<[^>]*>\s*)?[([A-Za-z_$]/,
  /^const ([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:<[^>]*>\s*)?[([A-Za-z_$]/,
  // A class method or an object-literal method: indented, optional modifiers,
  // and a body brace on the same line. Both shapes hold render handlers.
  /^\s+(?:(?:public|private|protected|static|async|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::[^{;]+)?\{\s*$/,
];
const RENDERS_WITH_GESTURE = /updateWebview\(\s*true\s*\)/;
const RENDERS = /updateWebview\(/;
const EXEMPT = /focus-restore-exempt:/;

/**
 * Split a file into top-level functions: { name, line, bodyCode, bodyComments }.
 *
 * Each body is the same line span of one of the scanner's views. Whether a
 * handler RENDERS, and whether it renders for a gesture, are questions about
 * code — a commented-out or quoted `updateWebview(true)` composes nothing — so
 * they read `bodyCode`. Whether it is exempt is a question about a COMMENT, so
 * it reads `bodyComments`: the hatch spelled inside a string is a string, not a
 * claim. The raw text answers neither question and is deliberately not kept.
 */
function functionsOf(src) {
  const lines = src.split('\n');
  const { code, comments } = scanSource(src);
  const codeLines = code.split('\n');
  const commentLines = comments.split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    for (const header of HEADERS) {
      const match = header.exec(lines[i]);
      if (match && !NOT_A_NAME.test(match[1])) {
        marks.push({ index: i, name: match[1] });
        break;
      }
    }
  }
  return marks.map((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : lines.length;
    return {
      name: mark.name,
      line: mark.index + 1,
      bodyComments: commentLines.slice(mark.index, end).join('\n'),
      bodyCode: codeLines.slice(mark.index, end).join('\n'),
    };
  });
}

// A missing target means the fence is aimed at nothing. Skipping quietly would
// read as a pass, so say so and fail.
for (const target of [providerDir, providerClass]) {
  if (!existsSync(target)) {
    console.error(`check:focus-restore-on-render: ${target} does not exist — nothing scanned.`);
    process.exit(1);
  }
}

/** Every `.ts` file under `dir`, recursively — a handler in a subdirectory is
 * a handler. `statSync` decides, so a DIRECTORY named `*.ts` is descended into
 * rather than read as a file. */
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

const offenders = [];

// Arm (a): handler modules.
for (const rel of walk(providerDir)) {
  const fns = functionsOf(readFileSync(rel, 'utf8'));

  // Every function that renders is checked where the render actually lives.
  // A wrapper that only delegates is not flagged twice: the callee it reaches
  // is itself scanned, so an indirect render cannot escape — which is why
  // scanning from byte 0 (helpers above the first export included) matters.
  for (const fn of fns) {
    if (
      !RENDERS.test(fn.bodyCode) ||
      RENDERS_WITH_GESTURE.test(fn.bodyCode) ||
      EXEMPT.test(fn.bodyComments)
    ) {
      continue;
    }
    offenders.push(`${rel}:${fn.line} ${fn.name}`);
  }
}

// Arm (b): the gesture flag is writable in exactly one place.
{
  const src = readFileSync(providerClass, 'utf8');
  const owner = /_renderForGesture\(\)\s*:\s*void\s*\{/.exec(src);
  const ownerStart = owner ? owner.index : -1;
  let ownerEnd = -1;
  if (ownerStart !== -1) {
    let depth = 0;
    for (let i = src.indexOf('{', ownerStart); i < src.length; i++) {
      if (src[i] === '{') {
        depth++;
      } else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          ownerEnd = i;
          break;
        }
      }
    }
  }
  // Plain `=` plus the logical-assignment forms, which set the flag just as
  // effectively. `==` / `===` are comparisons and must not match.
  // A write can also arrive as an object-literal key, which is how
  // `Object.assign(this, {…})` sets the flag without an `=` on it.
  const ASSIGN = /_restoreFocusOnNextRender\s*(?:(?:\|\||&&|\?\?)?=(?!=)|:)/g;
  let hit;
  while ((hit = ASSIGN.exec(src)) !== null) {
    const insideOwner = hit.index > ownerStart && hit.index < ownerEnd;
    // The field's own initializer is a declaration, not a write. Judged on the
    // WHOLE LINE the match sits on: a proximity search for `private` instead
    // mistook a short-named private method whose body assigns the field for the
    // declaration itself.
    const lineStart = src.lastIndexOf('\n', hit.index) + 1;
    const lineEnd = src.indexOf('\n', hit.index);
    const line = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd);
    const isFieldInit =
      /^\s*(?:private|protected|public|readonly|\s)+_restoreFocusOnNextRender\s*(?::[^=]+)?=/.test(
        line
      );
    if (insideOwner || isFieldInit) {
      continue;
    }
    offenders.push(
      `${providerClass}:${
        src.slice(0, hit.index).split('\n').length
      } _restoreFocusOnNextRender assigned outside _renderForGesture`
    );
  }
}

if (offenders.length > 0) {
  console.error('Focus-restore contract violation(s):');
  for (const o of offenders) {
    console.error(`  ${o}`);
  }
  console.error(
    '\nPass `ctx.updateWebview(true)` from a gesture handler, or annotate it\n' +
      '`focus-restore-exempt: <reason>`. The gesture flag is writable only in\n' +
      '`_renderForGesture`, which drops it around one synchronous render.'
  );
  process.exit(1);
}

console.log('check:focus-restore-on-render OK');

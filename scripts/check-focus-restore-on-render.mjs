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
 *    (a) Handler modules, src/git-core/gitToolWindow/provider/*.ts: any
 *        function calling `updateWebview(` must pass `true` or declare
 *        `focus-restore-exempt: <reason>`. Headers recognised: `export function
 *        f(`, plain `function f(` (including helpers above the first export),
 *        and `export const f = (…) =>` / `const f = (…) =>`. The file is
 *        scanned from byte 0, so a helper hiding above the first export is
 *        checked like any other — which is also what closes the indirect case:
 *        a wrapper delegating to a local helper is caught AT the helper.
 *
 *    (b) GitToolWindowProvider.ts: `_restoreFocusOnNextRender` may only be
 *        ASSIGNED inside `_renderForGesture`, which raises and drops it around
 *        one synchronous `_render()`. That is what makes the leak in the bug
 *        class above unwritable rather than merely avoided.
 *
 * 3. Known false-positive cases
 *    A programmatic (non-gesture) entry point renders with no focus to hand
 *    back — `selectCommits` is the current example and is exempt-annotated.
 *    Restoring focus there would pull it out of whatever the user is using.
 *
 *    Known GAPS, recorded rather than left silent:
 *      - Arm (a) checks each function where its own render call sits, so a
 *        handler that renders by calling into a module OUTSIDE provider/ is
 *        only caught if that module is scanned too.
 *      - Arm (a) matches the literal `updateWebview(true)`. Aliasing the method
 *        (`const r = ctx.updateWebview.bind(ctx)`) evades it, as does a handler
 *        whose one branch passes `true` while another does not — the check is
 *        per-function, not per-path. Both are contrived; review covers them.
 *      - Arm (b) does not classify the provider's own ~17 `_render()` call
 *        sites as gesture or ambient — no regex tells a click handler from a
 *        watcher tick. It fences the STATE that turned a misclassification into
 *        a leak, which is the part that can be made unwritable.
 *      - Arm (b) fences `_restoreFocusOnNextRender` BY NAME. A future
 *        gesture-stickiness latch introduced under a different field name is
 *        not covered; add it to ASSIGN when one appears.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const providerDir = join(root, 'src', 'git-core', 'gitToolWindow', 'provider');
const providerClass = join(root, 'src', 'git-core', 'gitToolWindow', 'GitToolWindowProvider.ts');

const HEADERS = [
  /^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/,
  /^export const ([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/,
  /^const ([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/,
];
const RENDERS_WITH_GESTURE = /updateWebview\(\s*true\s*\)/;
const RENDERS = /updateWebview\(/;
const EXEMPT = /focus-restore-exempt:/;

/** Split a file into top-level functions: { name, line, body }. */
function functionsOf(src) {
  const lines = src.split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    for (const header of HEADERS) {
      const match = header.exec(lines[i]);
      if (match) {
        marks.push({ index: i, name: match[1] });
        break;
      }
    }
  }
  return marks.map((mark, i) => ({
    name: mark.name,
    line: mark.index + 1,
    body: lines.slice(mark.index, i + 1 < marks.length ? marks[i + 1].index : lines.length).join('\n'),
  }));
}

const offenders = [];

// Arm (a): handler modules.
for (const name of readdirSync(providerDir)) {
  if (!name.endsWith('.ts')) {
    continue;
  }
  const rel = `src/git-core/gitToolWindow/provider/${name}`;
  const fns = functionsOf(readFileSync(join(providerDir, name), 'utf8'));

  // Every function that renders is checked where the render actually lives.
  // A wrapper that only delegates is not flagged twice: the callee it reaches
  // is itself scanned, so an indirect render cannot escape — which is why
  // scanning from byte 0 (helpers above the first export included) matters.
  for (const fn of fns) {
    if (!RENDERS.test(fn.body) || RENDERS_WITH_GESTURE.test(fn.body) || EXEMPT.test(fn.body)) {
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
  const ASSIGN = /_restoreFocusOnNextRender\s*=/g;
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
    const isFieldInit = /^\s*private\s+_restoreFocusOnNextRender\s*=/.test(line);
    if (insideOwner || isFieldInit) {
      continue;
    }
    offenders.push(
      `src/git-core/gitToolWindow/GitToolWindowProvider.ts:${
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

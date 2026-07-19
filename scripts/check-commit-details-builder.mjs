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
 *    Scope: every `.ts` under src/. Six shapes are checked:
 *      (a) a literal annotated as ICommitDetails (`: ICommitDetails = {`),
 *      (b) a literal assigned to a variable DECLARED as ICommitDetails, which
 *          is the shape a deferred `let x: ICommitDetails | undefined` takes,
 *      (c) a literal cast (`} as ICommitDetails`),
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
 *    Known GAPS. A fence's declared coverage must equal its ACTUAL coverage:
 *    what it fails to catch is fine once stated, but a silent failure is worse
 *    than no fence, because the next author reads this list and trusts it.
 *      - A literal reaching ICommitDetails purely by inference — passed to a
 *        function whose parameter is typed but whose name is not in
 *        PANEL_BUILDER, or returned from an un-annotated arrow whose type comes
 *        from context — is not detected. Closing it needs the type-checker.
 *      - BRACED bodies: the builder test is per-body, not per-return, so a
 *        function with several return paths passes if ANY of them spreads a
 *        builder. A hand-built arm alongside a builder arm is not caught.
 *      - CONCISE-ARROW bodies: only a literal-shaped body (`=> ({…})`) is
 *        scanned. A concise body that is a ternary, a call, or an await is not
 *        scanned AT ALL — so `(): ICommitDetails => b ? {…} : {…}` passes even
 *        when no arm spreads a builder.
 *      - The arm anchors on `: ICommitDetails` directly, so a WRAPPED return
 *        type (`Promise<ICommitDetails>`, `ResultAsync<ICommitDetails, …>`) is
 *        out of scope entirely, braced body or not.
 *    The last two are latent: src/ currently has no concise-arrow and no
 *    async/wrapped ICommitDetails producer. They are stated so that a future
 *    author adding the first one is not misled into thinking it is covered.
 *    Do NOT close them with more per-shape regex — the shapes always lag; reach
 *    for the type-checker if this list stops being adequate.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');

const BUILDERS = /\.\.\.commitNodeToBaseDetails\(|\.\.\.commitToBaseDetails\(/;
const EXEMPT = /commit-details-builder-exempt:/;
const ANNOTATED = /:\s*ICommitDetails\s*=\s*\{/g;
const PANEL_BUILDER = /(?:_getDetailsPanelModel|getDetailsPanelModel|buildDetailsPanelModel)\(\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{/g;
/** `let x: ICommitDetails | undefined;` — the deferred-assignment shape. */
const DECLARED = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*ICommitDetails\b(?!\s*=\s*\{)/g;
const CAST = /\}(?:\s*|\s*\)\s*)as\s+ICommitDetails\b/g;
/**
 * Any signature returning ICommitDetails, whichever way its body opens:
 * `): ICommitDetails {` (function / method) or `): ICommitDetails => ` (arrow,
 * whose concise body `=> ({…})` returns a literal with no `return` keyword).
 */
const RETURNS = /\)\s*:\s*ICommitDetails\b[^{;=]*(\{|=>\s*\(?\s*\{)/g;
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
 */
function literalAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') {
      depth++;
    } else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(open, i + 1);
      }
    }
  }
  return '';
}

/** The literal whose closing `}` sits at `close`, brace-matched backwards. */
function literalEndingAt(src, close) {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (src[i] === '}') {
      depth++;
    } else if (src[i] === '{') {
      depth--;
      if (depth === 0) {
        return src.slice(i, close + 1);
      }
    }
  }
  return '';
}

const offenders = [];
for (const file of walk(srcDir)) {
  const src = readFileSync(file, 'utf8');
  const report = (index, body) => {
    if (!body || BUILDERS.test(body) || EXEMPT.test(body)) {
      return;
    }
    offenders.push(`${file.slice(root.length + 1)}:${src.slice(0, index).split('\n').length}`);
  };

  for (const pattern of [ANNOTATED, PANEL_BUILDER]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(src)) !== null) {
      report(match.index, literalAt(src, match.index + match[0].length - 1));
    }
  }

  CAST.lastIndex = 0;
  let cast;
  while ((cast = CAST.exec(src)) !== null) {
    report(cast.index, literalEndingAt(src, cast.index));
  }

  // A function whose return type is ICommitDetails: every `return {` in its
  // body builds one. Scanning to the next signature keeps nested helpers out.
  RETURNS.lastIndex = 0;
  let sig;
  while ((sig = RETURNS.exec(src)) !== null) {
    const open = sig.index + sig[0].length - 1;
    // A concise arrow body IS the returned literal; a braced body is scanned
    // for its `return {` statements.
    if (sig[1] !== '{') {
      report(sig.index, literalAt(src, open));
      continue;
    }
    const body = literalAt(src, open);
    const RETURN_LITERAL = /return\s*\{/g;
    let ret;
    while ((ret = RETURN_LITERAL.exec(body)) !== null) {
      report(open + ret.index, literalAt(body, ret.index + ret[0].length - 1));
    }
  }

  // A literal pushed into an ICommitDetails array.
  ARRAY_DECL.lastIndex = 0;
  let arr;
  while ((arr = ARRAY_DECL.exec(src)) !== null) {
    const push = new RegExp(`\\b${arr[1]}\\.push\\(\\s*\\{`, 'g');
    let hit;
    while ((hit = push.exec(src)) !== null) {
      report(hit.index, literalAt(src, hit.index + hit[0].length - 1));
    }
  }

  // A variable declared as ICommitDetails and assigned a literal later.
  DECLARED.lastIndex = 0;
  let decl;
  while ((decl = DECLARED.exec(src)) !== null) {
    const assign = new RegExp(`\\b${decl[1]}\\s*=\\s*\\{`, 'g');
    let hit;
    while ((hit = assign.exec(src)) !== null) {
      report(hit.index, literalAt(src, hit.index + hit[0].length - 1));
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

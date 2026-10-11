#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// check-visual-coverage.mjs — every stylesheet producer is
// computed-style tested or classified.
//
// Bug class: a CSS rule can be present in the emitted text, tokenised
// correctly, and still never reach the element — it can fail to match, lose on
// specificity, or be overpainted. jsdom has no cascade and no layout engine and
// the e2e lane never reads rendered output, so the only lane that can see this
// is test/visual. A stylesheet nobody points that lane at is unguarded against
// the entire defect class, and the lane looks green regardless. This guard
// makes the decision explicit at PR time instead of letting coverage silently
// approach zero as stylesheets are added and split.
//
// Heuristic: a stylesheet producer is a function, arrow-const or method whose
// name CONTAINS `Styles` and is annotated to return `string` or
// `Promise<string>` — exported builders (`export function fooStyles(): string`,
// `export const fooStyles = (): string =>`), module-local ones, and the
// `_getStyles()` overrides every dialog uses. Keying only on EXPORTED builders
// is what this guard did first, and it saw 9 of 26 producers: every dialog in
// the repo declares its stylesheet as a private method, so a new dialog written
// the ordinary way added a stylesheet the guard never asked about. Each
// producing FILE must appear in visual-coverage.json.
//
// Classification is per PRODUCER, not per file. A file-level status lets a
// partly-covered file claim full coverage: stylesBuilder.ts exports both
// buildInlineStyles (rendered by two specs) and buildThreePanelStyles (rendered
// by none), and as one entry it read as 'tested'.
//
// 'tested' = a spec under test/visual renders that producer's CSS: an exported
// builder named in a spec, a builder a rendered one interpolates, or a method
// whose body delegates to one. 'backlog' = renderable by the harness, not yet —
// printed every run as visible debt. Fails on an unclassified producer, a stale
// entry, an unknown status, or a 'tested' entry no spec backs.
//
// False positives: a helper named `...Styles(): string` that returns something
// other than CSS is classified anyway. Mark the declaration line, or the line
// above it, `// visual-coverage-exempt: <reason>` — used for the
// BaseWebviewPanel hook, the empty default every dialog overrides.
//
// False negatives: a producer whose body calls a rendered builder AND adds
// rules of its own counts as tested, so the added rules are unguarded. Being
// more conservative is always allowed — the guard rejects an unbacked 'tested',
// it never forces one.
//
// Detection is BY NAME, so anything emitting CSS without `Styles` in its name is
// invisible rather than unclassified — the worse of the two failures, because
// nothing reports it. Two shapes are known to escape and neither is
// hypothetical. `buildCodiconFontFaceStyles` was `...Css` and escaped until it
// was renamed, which is the only reason it is classified at all; a future
// `buildFooCss` would escape the same way. And CSS reaches a document by
// in-place `<style>` assembly from a template as well as through a named
// builder — see provider/htmlBuilders.ts, where the styles are interpolated
// into the document string directly. Neither is caught by widening the name
// pattern further; closing them needs a different mechanism.
//
// Retire when every producer is 'tested' AND a narrower mechanism (for example
// co-located component styles that cannot ship without their spec) makes an
// unrendered stylesheet unwritable rather than merely reported.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { posixRelative } from './lib/posix-path.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Optional overrides so the companion spec can point the guard at a synthetic
// tree. Defaults are the real ones; CI and check:all pass no arguments.
const [srcArg, manifestArg, visualArg] = process.argv.slice(2);
const SRC = srcArg ? path.resolve(srcArg) : path.join(root, 'src');
const MANIFEST = manifestArg ? path.resolve(manifestArg) : path.join(root, 'scripts', 'visual-coverage.json');
const VISUAL_TEST_DIR = visualArg ? path.resolve(visualArg) : path.join(root, 'test', 'visual');
// Manifest keys are paths relative to the tree being scanned, so an overridden
// src still produces `src/...` keys instead of a walk back up to the repo.
const REL_BASE = srcArg ? path.dirname(path.resolve(srcArg)) : root;

// `Styles` may sit anywhere in the name, not only at the end: `_getStylesContinued`
// was a real producer that an ends-with match could not see at all — invisible
// rather than unclassified, which is the failure this guard exists to prevent.
// Plural is deliberate; singular `Style` would claim `unquoteCStylePath`.
const PRODUCER_NAME = '[A-Za-z0-9_]*Styles[A-Za-z0-9_]*';
// `Promise<string>` counts. The method pattern already tolerated the `async`
// modifier while gating on a literal `: string`, so an async builder emitted CSS
// no fence could see. Widened rather than pinned as an exclusion: pinning would
// have blessed the hole.
const PRODUCER_RETURN = ':\\s*(?:string|Promise<\\s*string\\s*>)';

// A module-level builder, exported or not.
const FUNCTION_PRODUCER = new RegExp(
  `^(export )?(?:async )?function (${PRODUCER_NAME})\\s*\\([^)]*\\)\\s*${PRODUCER_RETURN}`,
  'gm'
);
// An arrow-const builder. An arrow emits CSS exactly as a declaration does,
// so leaving the form out was a blind spot, not a design decision — the same
// reasoning that widened the return gate to Promise<string>.
const ARROW_PRODUCER = new RegExp(
  `^(export )?const (${PRODUCER_NAME})\\s*=\\s*(?:async )?\\([^)]*\\)\\s*${PRODUCER_RETURN}\\s*=>`,
  'gm'
);
// A class member: `_getStyles(): string`, `getInlineStyles(): string`, and the
// `protected override` forms every dialog uses. The trailing `{` is required so
// an interface DECLARING the method is not counted as producing a stylesheet.
const METHOD_PRODUCER = new RegExp(
  `^\\s+(?:private |protected |public )?(?:override )?(?:async )?(${PRODUCER_NAME})` +
    `\\s*\\([^)]*\\)\\s*${PRODUCER_RETURN}\\s*\\{`,
  'gm'
);
const EXEMPT = 'visual-coverage-exempt:';

function fail(lines) {
  console.error('[check:visual-coverage] FAIL');
  for (const l of lines) console.error('  ' + l);
  process.exit(1);
}

function walk(dir, filter) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out;
}

const rel = (abs) => posixRelative(REL_BASE, abs);

/**
 * The declaration's line plus the one above it, where the exemption marker may
 * sit. A method declaration ends in `{`, so a trailing marker would be stranded
 * after the brace; above the signature is where such a note is readable.
 */
function exemptionScope(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  const previousStart = text.lastIndexOf('\n', start - 2) + 1;
  return text.slice(previousStart, end === -1 ? text.length : end);
}

/**
 * The producer's body, brace-matched from its opening `{`.
 *
 * A concise-body arrow (`=> \`.a { ... }\``) has no block, so the first `{`
 * found is inside its CSS template and the "body" is a rule fragment. That
 * fails conservative: forwarding detection finds no `otherStyles()` call in
 * the fragment, so such a producer can never claim `tested` by forwarding and
 * must be rendered directly by a spec. Block-bodied arrows match correctly.
 */
function bodyFrom(text, declarationIndex) {
  const open = text.indexOf('{', declarationIndex);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

// Ground truth: every stylesheet producer in src, with its file, whether it is
// exported (only an exported one can be named by a spec or interpolated by
// another module) and its body (which is how a delegating method is matched to
// the builder it forwards to). Both .ts and .tsx, so a future component
// migration cannot walk out from under this guard.
const producers = [];
for (const abs of walk(SRC, (p) => p.endsWith('.ts') || p.endsWith('.tsx'))) {
  const text = fs.readFileSync(abs, 'utf8');
  for (const re of [FUNCTION_PRODUCER, ARROW_PRODUCER, METHOD_PRODUCER]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (exemptionScope(text, m.index).includes(EXEMPT)) continue;
      // The function and arrow patterns capture (export?, name); the method
      // pattern captures (name) and a class member is never module-exported.
      const isMember = re === METHOD_PRODUCER;
      producers.push({
        file: rel(abs),
        name: isMember ? m[1] : m[2],
        exported: !isMember && m[1] !== undefined,
        body: bodyFrom(text, m.index),
      });
    }
  }
}

if (producers.length === 0) {
  fail([
    'found no stylesheet producers at all — the detection patterns have drifted',
    'from how stylesheets are declared. Fix them; a guard aimed at nothing',
    'reports green forever.',
  ]);
}
if (!producers.some((p) => p.exported)) {
  fail([
    'found no EXPORTED stylesheet builders — specs can only render exported ones,',
    'so nothing could be marked tested. The export pattern has drifted.',
  ]);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const statuses = new Set(manifest.statuses);
const files = manifest.files ?? {};

// Comments are stripped before anything is called "rendered". Specs describe
// what they cover in prose, naming the builder they render and often the ones
// they do not — so a bare name match credits a builder for being MENTIONED.
// Residual: a comment trailing live code on the same line survives. Whole-line
// comments are where the prose actually is.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

const visualTestBlob = fs.existsSync(VISUAL_TEST_DIR)
  ? walk(VISUAL_TEST_DIR, (p) => p.endsWith('.ts'))
      .map((p) => stripComments(fs.readFileSync(p, 'utf8')))
      .join('\n')
  : '';

// A stylesheet reaches the browser either because a spec calls its builder or
// because a rendered builder interpolates it. Specs render the full production
// stylesheet on purpose — that is what makes an overpaint by a later rule
// visible — so a module included by a rendered one is genuinely covered, and
// requiring specs to name it directly would push them toward rendering
// fragments that do not match what ships.
const renderedBuilders = new Set();
for (const p of producers) {
  // Call syntax, not a bare name: an import line or a type reference names a
  // builder without rendering it.
  if (p.exported && visualTestBlob.includes(`${p.name}(`)) renderedBuilders.add(p.name);
}
for (let changed = true; changed; ) {
  changed = false;
  for (const p of producers) {
    if (!renderedBuilders.has(p.name)) continue;
    for (const candidate of producers) {
      if (
        candidate.exported &&
        !renderedBuilders.has(candidate.name) &&
        p.body.includes(`${candidate.name}()`)
      ) {
        renderedBuilders.add(candidate.name);
        changed = true;
      }
    }
  }
}

const key = (p) => `${p.file}::${p.name}`;

// A producer's CSS reaches a spec when it is rendered outright, or when it
// forwards to one that is. Forwarding is resolved by NAME WITHIN ITS OWN FILE
// for unexported producers and by exported name across files: `_getStyles` is
// declared in a dozen dialogs, so a global name match would let one dialog's
// coverage vouch for another's.
const backed = new Set();
for (const p of producers) {
  if (p.exported && renderedBuilders.has(p.name)) backed.add(key(p));
}
for (let changed = true; changed; ) {
  changed = false;
  for (const p of producers) {
    if (backed.has(key(p))) continue;
    const forwards =
      [...renderedBuilders].some((b) => p.body.includes(`${b}()`)) ||
      producers.some(
        (other) =>
          other.file === p.file && other !== p && backed.has(key(other)) && p.body.includes(`${other.name}()`)
      );
    if (forwards) {
      backed.add(key(p));
      changed = true;
    }
  }
}
const problems = [];

for (const p of [...producers].sort((a, b) => key(a).localeCompare(key(b)))) {
  const entry = files[key(p)];
  if (!entry) {
    problems.push(
      `${key(p)} is a stylesheet producer but is not classified in ` +
        `scripts/visual-coverage.json — add "tested" (a spec under test/visual renders its ` +
        `CSS) or "backlog".`
    );
    continue;
  }
  if (!statuses.has(entry.status)) {
    problems.push(`${key(p)} has unknown status '${entry.status}'`);
    continue;
  }
  if (entry.status === 'tested' && !backed.has(key(p))) {
    problems.push(
      `${key(p)} is marked 'tested' but no spec under test/visual renders it — ` +
        `either point a spec at it or mark it 'backlog'.`
    );
  }
}

const live = new Set(producers.map(key));
for (const entry of Object.keys(files)) {
  if (!live.has(entry)) {
    problems.push(`${entry} is in the manifest but is no longer a stylesheet producer — stale.`);
  }
}

if (problems.length > 0) fail(problems);

const backlog = Object.entries(files)
  .filter(([, e]) => e.status === 'backlog')
  .map(([f]) => f)
  .sort();
// Counted from the manifest rather than subtracted from the total, so adding a
// third status later cannot silently inflate the tested number.
const tested = Object.values(files).filter((e) => e.status === 'tested').length;

console.log(
  `[check:visual-coverage] OK (${producers.length} stylesheet producers; ` +
    `${tested} computed-style tested, ${backlog.length} backlog)`
);
for (const f of backlog) console.log(`  backlog: ${f} — ${files[f].note ?? 'no note'}`);

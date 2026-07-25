#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// check-visual-coverage.mjs — every stylesheet module is
// computed-style tested or classified.
//
// Bug class: a CSS rule can be present in the emitted text, tokenised
// correctly, and still never reach the element — it can fail to match, lose on
// specificity, or be overpainted. jsdom has no cascade and no layout engine and
// the e2e lane never reads rendered output, so the only lane that can see this
// is test/visual. A stylesheet module nobody points that lane at is unguarded
// against the entire defect class, and the lane looks green regardless. This
// guard makes the decision explicit at PR time instead of letting coverage
// silently approach zero as stylesheets are added and split.
//
// Heuristic: every src file exporting a `*Styles()` builder emits a stylesheet
// and must appear in visual-coverage.json. 'tested' = a spec under test/visual
// references the exported builder by name; 'backlog' = renderable by the
// harness, not yet (printed every run as visible debt). Fails on an
// unclassified new stylesheet module, a stale entry, an unknown status, or a
// 'tested' entry whose builder no spec actually calls.
//
// Retire when every stylesheet module is 'tested' AND a narrower mechanism
// (for example co-located component styles that cannot ship without their
// spec) makes an unrendered stylesheet unwritable rather than merely reported.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src');
const MANIFEST = path.join(root, 'scripts', 'visual-coverage.json');
const VISUAL_TEST_DIR = path.join(root, 'test', 'visual');

const STYLE_EXPORT = /^export function ([A-Za-z0-9_]*Styles)\(/gm;

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

const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');

// Ground truth: src files exporting a stylesheet builder, with the builder
// names they export. Both .ts and .tsx, so a future component migration cannot
// walk out from under this guard.
const styleModules = new Map();
for (const abs of walk(SRC, (p) => p.endsWith('.ts') || p.endsWith('.tsx'))) {
  const text = fs.readFileSync(abs, 'utf8');
  const names = [...text.matchAll(STYLE_EXPORT)].map((m) => m[1]);
  if (names.length > 0) styleModules.set(rel(abs), names);
}

if (styleModules.size === 0) {
  fail([
    'found no stylesheet modules at all — the STYLE_EXPORT heuristic has drifted',
    'from how stylesheets are declared. Fix the pattern; a guard aimed at nothing',
    'reports green forever.',
  ]);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const statuses = new Set(manifest.statuses);
const files = manifest.files ?? {};

const visualTestBlob = fs.existsSync(VISUAL_TEST_DIR)
  ? walk(VISUAL_TEST_DIR, (p) => p.endsWith('.ts'))
      .map((p) => fs.readFileSync(p, 'utf8'))
      .join('\n')
  : '';

// A stylesheet reaches the browser either because a spec calls its builder or
// because a rendered builder interpolates it. Specs render the full production
// stylesheet on purpose — that is what makes an overpaint by a later rule
// visible — so a module included by a rendered one is genuinely covered, and
// requiring specs to name it directly would push them toward rendering
// fragments that do not match what ships.
const renderedBuilders = new Set();
for (const [, builders] of styleModules) {
  for (const b of builders) {
    if (visualTestBlob.includes(b)) renderedBuilders.add(b);
  }
}
for (let changed = true; changed; ) {
  changed = false;
  for (const [file, builders] of styleModules) {
    if (!builders.some((b) => renderedBuilders.has(b))) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [, candidates] of styleModules) {
      for (const c of candidates) {
        if (!renderedBuilders.has(c) && text.includes(`${c}()`)) {
          renderedBuilders.add(c);
          changed = true;
        }
      }
    }
  }
}

const problems = [];

for (const [file, builders] of [...styleModules].sort()) {
  const entry = files[file];
  if (!entry) {
    problems.push(
      `${file} exports ${builders.join('/')} but is not classified in scripts/visual-coverage.json ` +
        `— add "tested" (a spec under test/visual renders the builder, directly or via one it ` +
        `interpolates) or "backlog".`
    );
    continue;
  }
  if (!statuses.has(entry.status)) {
    problems.push(`${file} has unknown status '${entry.status}'`);
    continue;
  }
  if (entry.status === 'tested' && !builders.some((b) => renderedBuilders.has(b))) {
    problems.push(
      `${file} is marked 'tested' but no spec under test/visual renders any of ` +
        `${builders.join('/')} — either point a spec at it or mark it 'backlog'.`
    );
  }
}

for (const file of Object.keys(files)) {
  if (!styleModules.has(file)) {
    problems.push(`${file} is in the manifest but exports no *Styles() builder — stale, remove it.`);
  }
}

if (problems.length > 0) fail(problems);

const backlog = Object.entries(files)
  .filter(([, e]) => e.status === 'backlog')
  .map(([f]) => f)
  .sort();

console.log(
  `[check:visual-coverage] OK (${styleModules.size} stylesheet modules; ` +
    `${styleModules.size - backlog.length} computed-style tested, ${backlog.length} backlog)`
);
for (const f of backlog) console.log(`  backlog: ${f} — ${files[f].note ?? 'no note'}`);

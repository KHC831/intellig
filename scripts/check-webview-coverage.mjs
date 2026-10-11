#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// check-webview-coverage.mjs — every webview client script is
// jsdom-tested or classified.
//
// Bug class: a webview's browser-side script (acquireVsCodeApi + createElement
// DOM) runs in the renderer, so a thrown error there is invisible to the
// extension-host smoke, e2e, and output-channel lanes — it only shows when a
// human opens the panel. This guard makes that decision explicit at PR time.
//
// Heuristic: every src file containing `acquireVsCodeApi(` ships a client
// script and must be in webview-coverage.json. 'tested' = a jsdom client-script
// test under test/unit/webview/ references the file (basename appears there);
// 'backlog' = harness-testable, not yet (printed every run). Fails on an
// unclassified new file, a stale entry, an unknown status, or a 'tested' entry
// with no referencing webview test.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { posixRelative } from './lib/posix-path.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src');
const MANIFEST = path.join(root, 'scripts', 'webview-coverage.json');
const WEBVIEW_TEST_DIR = path.join(root, 'test', 'unit', 'webview');

function fail(lines) {
  console.error('[check:webview-coverage] FAIL');
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

const rel = (abs) => posixRelative(root, abs);

// Ground truth: src files that acquire the webview client API.
const clientScriptFiles = walk(SRC, (p) => p.endsWith('.ts'))
  .filter((p) => fs.readFileSync(p, 'utf8').includes('acquireVsCodeApi('))
  .map(rel)
  .sort();

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const statuses = new Set(manifest.statuses);
const files = manifest.files ?? {};

// Concatenated webview test text for 'tested' verification.
const webviewTestBlob = fs.existsSync(WEBVIEW_TEST_DIR)
  ? walk(WEBVIEW_TEST_DIR, (p) => p.endsWith('.ts'))
      .map((p) => fs.readFileSync(p, 'utf8'))
      .join('\n')
  : '';

const errors = [];

for (const file of clientScriptFiles) {
  const entry = files[file];
  if (!entry) {
    errors.push(`${file}: has a webview client script but is not in webview-coverage.json — add a jsdom test (test/unit/webview/) or classify it.`);
    continue;
  }
  if (!statuses.has(entry.status)) {
    errors.push(`${file}: unknown status '${entry.status}' (allowed: ${[...statuses].join(', ')}).`);
    continue;
  }
  if (entry.status === 'tested') {
    const base = path.basename(file, '.ts');
    if (!webviewTestBlob.includes(base)) {
      errors.push(`${file}: marked 'tested' but no test under test/unit/webview/ references '${base}'.`);
    }
  }
}

const truth = new Set(clientScriptFiles);
for (const file of Object.keys(files)) {
  if (!truth.has(file)) {
    errors.push(`${file}: in webview-coverage.json but no longer has a client script (stale — remove it).`);
  }
}

if (errors.length > 0) {
  fail(errors);
}

const tested = Object.entries(files).filter(([, v]) => v.status === 'tested');
const backlog = Object.entries(files)
  .filter(([, v]) => v.status === 'backlog')
  .map(([k]) => k)
  .sort();
console.log(
  `[check:webview-coverage] OK — ${clientScriptFiles.length} client-script webview(s): tested=${tested.length}, backlog=${backlog.length}.`
);
if (backlog.length > 0) {
  console.log(`[check:webview-coverage] backlog (harness-testable, not yet) — ${backlog.length}:`);
  for (const f of backlog) console.log(`    - ${f}`);
}

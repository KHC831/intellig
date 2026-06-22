#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// check-command-coverage.mjs — every command is test-classified.
//
// Maintenance contract:
//
// 1. Bug class
//    A command ships with neither a command-level e2e test nor an explicit
//    "why it has none" classification — so a behavioural regression in it
//    (silent no-op, wrong repo/path, broken wiring) slips through CI. The
//    blame "Annotate enabled but nothing renders" bug was exactly this: the
//    command had no e2e and nobody had decided it should. This guard makes
//    that decision mandatory at PR time.
//
// 2. Heuristic
//    - e2e-covered = the command id literal appears anywhere under
//      test/e2e/ (robust to multi-line executeCommand calls).
//    - Every package.json `contributes.commands[].command` must be EITHER
//      e2e-covered OR listed in scripts/command-coverage.json with a valid
//      category. A command that is neither fails the guard.
//    - 'backlog' entries pass but are printed every run so direct-git
//      coverage debt stays visible (and shrinks as e2e tests are added).
//
// 3. Keeping it honest
//    - An e2e-covered command listed in the manifest fails (stale: remove
//      it — its e2e test is the source of truth).
//    - A manifest entry not in package.json fails (stale).
//    - An unknown category fails.
//    Adding an e2e test for a backlog command and deleting its manifest
//    entry is the intended way to burn down the backlog.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(root, 'package.json');
const MANIFEST = path.join(root, 'scripts', 'command-coverage.json');
const E2E_DIR = path.join(root, 'test', 'e2e');

function fail(lines) {
  console.error('[check:command-coverage] FAIL');
  for (const l of lines) console.error('  ' + l);
  process.exit(1);
}

function listTsFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listTsFiles(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
const commands = (pkg.contributes?.commands ?? []).map((c) => c.command);

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const allowed = new Set(manifest.categories);
const classified = manifest.commands ?? {};

const e2eBlob = listTsFiles(E2E_DIR)
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');
const isE2eCovered = (id) => e2eBlob.includes(`'${id}'`) || e2eBlob.includes(`"${id}"`);

const errors = [];

// Forward: every package command must be e2e-covered or classified.
for (const id of commands) {
  const covered = isE2eCovered(id);
  const entry = classified[id];
  if (covered && entry) {
    errors.push(`${id}: e2e-covered AND in manifest — remove the manifest entry (the e2e test is the source of truth).`);
  } else if (!covered && !entry) {
    errors.push(`${id}: no command-level e2e test and not classified. Add an e2e test under test/e2e/, or classify it in scripts/command-coverage.json.`);
  } else if (entry && !allowed.has(entry.category)) {
    errors.push(`${id}: unknown category '${entry.category}' (allowed: ${[...allowed].join(', ')}).`);
  }
}

// Reverse: no stale manifest entries.
const pkgSet = new Set(commands);
for (const id of Object.keys(classified)) {
  if (!pkgSet.has(id)) {
    errors.push(`${id}: in command-coverage.json but not declared in package.json (stale — remove it).`);
  }
}

if (errors.length > 0) {
  fail(errors);
}

const e2eCount = commands.filter(isE2eCovered).length;
const byCat = {};
for (const id of Object.keys(classified)) {
  const c = classified[id].category;
  (byCat[c] ??= []).push(id);
}
const catSummary = manifest.categories.map((c) => `${c}=${(byCat[c] ?? []).length}`).join(', ');
console.log(
  `[check:command-coverage] OK — ${commands.length} command(s): e2e=${e2eCount}, ${catSummary}.`
);
const backlog = byCat['backlog'] ?? [];
if (backlog.length > 0) {
  console.log(`[check:command-coverage] backlog (direct-git, e2e-able, not yet covered) — ${backlog.length}:`);
  for (const id of backlog.sort()) console.log(`    - ${id}`);
}

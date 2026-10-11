#!/usr/bin/env node
/*
 * check-dead-exports.mjs — structural guard against orphaned src modules.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: a src/ module that no runtime entry point can reach —
 *    dead infrastructure that still compiles, still ships type surface, and
 *    rots (a parallel error-classification system, an unused cache/lazy-loader,
 *    a service whose instance is constructed but never called). ~1,400 LOC of
 *    exactly this was removed; this guard stops the next cluster from
 *    accreting silently.
 *
 * 2. Heuristic + how it scales: build a MODULE-level reachability set over the
 *    src/ import graph starting from the real bundle entry points
 *    (src/extension.ts, src/git-core/rebaseTodoEditor.ts, and every webview
 *    entry esbuild bundles — the merge window + the media/webview/*.js panel
 *    entries; see package.json + scripts/build-webview.mjs). Follow every static
 *    `import … from`, side-effect `import`,
 *    re-export `export … from`, and dynamic `import(...)` edge that resolves to
 *    a file under src/. Any src `.ts` (non-`.d.ts`) with ZERO path from an
 *    entry point is dead and fails the gate. Scales linearly with the module
 *    count.
 *
 *    DELIBERATELY module-level, not symbol-level. Symbol-level dead-export
 *    detection (knip / ts-prune) is noisy — barrels, test-only exports, and
 *    branded-type re-exports all trip it — and its config debt is not worth it
 *    here. A whole orphaned FILE is the high-signal case this guard owns.
 *
 * 3. Known false-positive cases: a module reached ONLY dynamically through a
 *    computed specifier the regex can't see, or one loaded by a non-import
 *    mechanism. Add it to scripts/dead-exports-allowlist.txt with a one-line
 *    justification (INVESTIGATE first — a live-but-dynamic module is rare;
 *    a genuinely dead one should be deleted, not allowlisted). None today.
 *
 * 4. Known false-negative cases: a dead module still IMPORTED by another dead
 *    module that is itself only referenced from a comment/string the scanner
 *    mis-reads as an edge. Coarse by design; the deletion review is the real
 *    backstop. A dead EXPORT inside a live file is out of scope (symbol-level).
 *
 * 5. Retirement criteria: retire when the bundler itself fails the build on an
 *    unreferenced module, or a knip config is adopted repo-wide.
 *
 * Usage:
 *   node scripts/check-dead-exports.mjs
 *     — real mode: root=src, the three entry points, allowlist applied.
 *   node scripts/check-dead-exports.mjs <srcRoot> <entry1> [entry2 …]
 *     — fixture mode (companion spec): entries are relative to srcRoot,
 *       allowlist is NOT applied.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { posixRelative } from './lib/posix-path.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_ROOT = path.join(repoRoot, 'src');
const DEFAULT_ENTRIES = [
  'extension.ts',
  'git-core/rebaseTodoEditor.ts',
  'conflicts/merge-window/webview/main.ts',
  // Bundled webview panel entries (esbuild multi-entry → media/webview/*.js;
  // referenced by their host via asWebviewUri, not an import). Keep in sync with
  // scripts/build-webview.mjs PANEL_ENTRIES.
  'shelf/webview/main.ts',
  'branches/webview/main.ts',
  'conflicts/webview/main.ts',
  'commits/webview/commitMessageDialog.ts',
  'ui-shell/webview/resetDialog.ts',
  'rebase/webview/rebaseDialog.ts',
  'patches/webview/applyPatchDialog.ts',
  'conflicts/webview/resolveConflictsDialog.ts',
  'sync/webview/pushDialog.ts',
  'sync/webview/defineRemoteDialog.ts',
  'rebase/webview/rebaseProgressView.ts',
  'rebase/webview/rebaseEditor.ts',
  'commits/webview/commitDialog.ts',
  'commits/webview/commitToolWindow.ts',
  'git-core/gitToolWindow/webview/gitToolWindow.ts',
];
const ALLOWLIST_FILE = path.join(repoRoot, 'scripts', 'dead-exports-allowlist.txt');

const args = process.argv.slice(2);
const fixtureMode = args.length > 0;
const srcRoot = fixtureMode ? path.resolve(args[0]) : DEFAULT_ROOT;
const entryRel = fixtureMode ? args.slice(1) : DEFAULT_ENTRIES;

/** Every non-`.d.ts` TypeScript file under `srcRoot`, as absolute paths. */
function listTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) {
      out.push(...listTsFiles(abs));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(abs);
    }
  }
  return out;
}

/** Resolve an import specifier to a file under `srcRoot`, or null if external/unresolved. */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) {
    return null; // external package (vscode, neverthrow, node builtins, …)
  }
  const base = path.dirname(fromFile);
  const target = path.resolve(base, spec);
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    path.join(target, 'index.ts'),
    path.join(target, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile() && c.endsWith('.ts')) {
      return c;
    }
  }
  return null;
}

const EDGE_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Import specifiers referenced by `file`. */
function edgesOf(file) {
  const text = readFileSync(file, 'utf8');
  const specs = [];
  let m;
  EDGE_RE.lastIndex = 0;
  while ((m = EDGE_RE.exec(text)) !== null) {
    specs.push(m[1] ?? m[2] ?? m[3]);
  }
  return specs;
}

const allFiles = listTsFiles(srcRoot);
const entries = entryRel.map((r) => path.join(srcRoot, r));
for (const e of entries) {
  if (!existsSync(e)) {
    console.error(`check-dead-exports: entry point not found: ${e}`);
    process.exit(2);
  }
}

// BFS the module graph from the entry points.
const reachable = new Set();
const queue = [...entries];
while (queue.length > 0) {
  const file = queue.pop();
  if (reachable.has(file)) {
    continue;
  }
  reachable.add(file);
  for (const spec of edgesOf(file)) {
    const resolved = resolveSpec(file, spec);
    if (resolved && !reachable.has(resolved)) {
      queue.push(resolved);
    }
  }
}

let allow = new Set();
if (!fixtureMode && existsSync(ALLOWLIST_FILE)) {
  allow = new Set(
    readFileSync(ALLOWLIST_FILE, 'utf8')
      .split('\n')
      .map((l) => l.replace(/#.*$/, '').trim())
      .filter((l) => l.length > 0)
      .map((rel) => path.join(srcRoot, rel))
  );
}

const dead = allFiles
  .filter((f) => !reachable.has(f) && !allow.has(f))
  .map((f) => posixRelative(repoRoot, f))
  .sort();

if (dead.length > 0) {
  console.error(
    'check-dead-exports: src module(s) unreachable from any runtime entry point.\n' +
      '  These files are dead — no import path from src/extension.ts,\n' +
      '  src/git-core/rebaseTodoEditor.ts, or the merge-window webview reaches them.\n' +
      '  Delete them (and their tests), or — if reached only dynamically — add the\n' +
      '  path to scripts/dead-exports-allowlist.txt with a justification.\n'
  );
  for (const f of dead) {
    console.error(`  ${f}`);
  }
  process.exit(1);
}

console.log(`check-dead-exports: OK (${reachable.size} reachable, ${allFiles.length} total).`);

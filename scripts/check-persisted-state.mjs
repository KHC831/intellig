#!/usr/bin/env node
/**
 * Structural CI guard — host Memento state (`workspaceState` / `globalState`)
 * is read and written through the versioned validate-on-load seam, never raw.
 *
 * Maintenance contract (per ADR-007 section "Guard maintenance contract"):
 *
 * 1. Bug class
 *    A persisted value is read with `someMemento.get<T>(key)` — an unchecked
 *    cast asserting a shape the stored blob is merely trusted to have. When the
 *    value's shape changes across a release (yesterday's writer vs today's
 *    reader), or a hand-edited/corrupt blob arrives, the cast feeds garbage
 *    straight into feature code. `src/utils/persistedState.ts` closes this with
 *    `PersistedSlot` (mandatory validator + version tag) driving
 *    `loadPersisted`/`savePersisted`. This guard keeps every Memento access on
 *    that seam.
 *
 * 2. Heuristic + how it scales
 *    Every `.ts` under srcDir (except *.test.ts and the seam module itself) is
 *    read as one string (content-based, so a receiver/`.get` split across lines
 *    is caught) and scanned for
 *      \b_?(workspaceState|globalState|memento|store)\s*\.\s*(get|update)\s*\(
 *    keying on the four conventional Memento identifiers this codebase uses
 *    (optional leading underscore / `this.`; `store` is the common Memento-alias
 *    param name). A match fails unless a
 *    `// persisted-state-exempt: <reason>` comment sits within the four lines
 *    above. New persisted state added via a slot + loadPersisted/savePersisted
 *    is covered automatically; no per-key edit here.
 *
 * 3. Known false-positive cases
 *    None: `.getState()` (in-memory view accessors), `context.workspaceState`
 *    passed as a constructor arg (no trailing `.get`/`.update` call), and the
 *    webview `vscode.getState()` handle all fail the `<memento>.get(`/`.update(`
 *    shape and are naturally excluded.
 *
 * 4. Known false-negative cases
 *    A Memento aliased to a novel identifier (or the generic name `state`)
 *    outside the seam would escape — a grep cannot type-check "is this receiver
 *    a vscode.Memento". Mitigations, all real: (a) the seam's own param is named
 *    `state` and folding logFilterStorage/panelLayout/columnLayout into the seam
 *    removes every legitimate Memento `.get` from the rest of the tree; (b) a
 *    Memento is only ever acquired via `context.workspaceState` /
 *    `context.globalState`, trivial to eyeball in review; (c) the teeth test
 *    pins the four conventional names — incl. `store`, the common Memento-alias
 *    param name a slot-helper caller reaches for. Banning `state.get(` broadly would
 *    collide with `Map.get` and non-Memento `.get` — noise, deliberately not done.
 *
 * 5. Retirement criteria
 *    Retire when persisted access is expressible only through the typed slot API
 *    at the type level (e.g. Memento handles are never exposed raw to features).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SEAM_REL = join('utils', 'persistedState.ts');
const BAN_RE = /\b_?(?:workspaceState|globalState|memento|store)\s*\.\s*(?:get|update)\s*\(/g;

function collectTsFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectTsFiles(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function main() {
  const srcDir = process.argv[2] ?? join(root, 'src');
  const violations = [];

  for (const file of collectTsFiles(srcDir)) {
    if (file.endsWith('.test.ts')) continue;
    if (relative(srcDir, file) === SEAM_REL) continue;
    const content = readFileSync(file, 'utf8');
    let m;
    while ((m = BAN_RE.exec(content)) !== null) {
      const line = content.slice(0, m.index).split('\n').length;
      const lines = content.split('\n');
      const windowAbove = lines.slice(Math.max(0, line - 1 - 4), line - 1).join('\n');
      if (!windowAbove.includes('persisted-state-exempt:')) {
        violations.push({ file: relative(root, file), line });
      }
    }
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(
        `check-persisted-state: raw Memento get/update outside the helper at ${v.file}:${v.line}.\n` +
          'Persist via loadPersisted()/savePersisted() with a PersistedSlot from\n' +
          'src/utils/persistedState.ts, or justify with `// persisted-state-exempt: <reason>`.'
      );
    }
    process.exit(1);
  }

  console.log('check-persisted-state: OK (Memento get/update funneled through the persistedState seam)');
}

main();

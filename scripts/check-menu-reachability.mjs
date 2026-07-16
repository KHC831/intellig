#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// check-menu-reachability.mjs — palette-hidden command ↔ UI-sender guard.
//
// Maintenance contract (per ADR-007 section "Guard maintenance contract"):
//
// 1. Bug class
//    A command that is registered AND declared, but hidden from the palette
//    (`commandPalette` entry with `when: "false"`) with NO other way to
//    invoke it: no menu contribution, no keybinding, and no in-source sender
//    (webview context-menu relay / `executeCommand` call). The command is
//    implemented and tested yet a user can never reach it — a silent parity
//    gap (the J-surface review found five such commands with full
//    implementations behind a dead surface). check-command-reachability
//    covers declared ⇒ registered; this guard covers the other honesty
//    direction for hidden commands: registered ⇒ reachable.
//
// 2. Heuristic + how it scales
//    Collect every commandPalette entry with `when === "false"`. Each such id
//    must satisfy at least one of:
//      (a) appear in a `contributes.menus` section other than commandPalette;
//      (b) appear in `contributes.keybindings`;
//      (c) appear in production source (src/, excluding test subtrees) on a
//          line that is neither the registration literal (`id: '<cmd>'`) nor
//          a comment — i.e. a real sender such as
//          `executeCommand('<cmd>', …)` from a webview message handler.
//    Adding a new hidden command with a sender is automatically covered; a
//    new hidden command with no sender fails here at introduction time.
//
// 3. Known false-positive cases
//    A sender assembled from fragments (`'intellig.' + name`) would not be
//    seen and could false-fail. House convention registers and invokes every
//    id as a whole literal; keep doing that rather than relaxing the guard.
//
// 4. Known false-negative cases
//    An id mentioned on a non-comment line that is not actually a live
//    sender (e.g. a string in dead code) passes. Acceptable: the runtime
//    lanes exercise real menus, and the guard's job is stopping the
//    class-level regression (hidden command with zero referencing sites).
//
// 5. Retirement criteria
//    Retire when menu/keybinding/webview senders are generated from a single
//    typed command table, making "registered but unreachable" unrepresentable.
// ============================================================
//
// EXEMPT: ids whose unreachability is an accepted, recorded divergence.
// RATCHET: ids unreachable at guard adoption, each owned by a queued parity
// task. The list may only SHRINK: wiring one without removing it here fails
// (stale entry), and adding a new id fails (new debt). Do not add entries.

import * as fs from 'fs';
import * as path from 'path';

/** Accepted debt — recorded divergences, not wiring backlog. */
const EXEMPT = new Map([
  [
    'intellig.commit.openOnHost',
    'prior-audit ruling: unreachable-as-command is accepted debt; blame-hover exposes the direct https link',
  ],
]);

/** Unreachable at adoption; owned by queued parity-fix tasks. Shrink-only. */
const RATCHET = new Set([
  'intellig.commit.applyFilesToBranch',
  'intellig.commit.applySelectedChanges',
  'intellig.commit.checkoutRevision',
  'intellig.commit.cherryPick',
  'intellig.commit.cherryPickWithoutCommit',
  'intellig.commit.copyHash',
  'intellig.commit.createPatch',
  'intellig.commit.dropSelectedChanges',
  'intellig.commit.resetToHere',
  'intellig.commit.revert',
  'intellig.remoteBranch.pullIntoCurrent',
  'intellig.remoteBranch.trackBranch',
]);

function loadPkg(pkgPath) {
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
}

function hiddenCommands(pkg) {
  const palette = pkg?.contributes?.menus?.commandPalette ?? [];
  return palette
    .filter((e) => e?.when === 'false' && typeof e?.command === 'string')
    .map((e) => e.command);
}

function menuAndKeybindingIds(pkg) {
  const ids = new Set();
  const menus = pkg?.contributes?.menus ?? {};
  for (const [section, entries] of Object.entries(menus)) {
    if (section === 'commandPalette') continue;
    for (const e of entries ?? []) {
      if (typeof e?.command === 'string') ids.add(e.command);
    }
  }
  for (const k of pkg?.contributes?.keybindings ?? []) {
    if (typeof k?.command === 'string') ids.add(k.command);
  }
  return ids;
}

/**
 * Does `id` appear in production source on a line that is neither its
 * registration (`id: '<cmd>'`) nor a comment? That line is a sender.
 */
function hasSourceSender(srcDir, id) {
  const escaped = id.replace(/\./g, '\\.');
  // Exact-id boundary: `intellig.commit.compareWith` must not match a
  // `intellig.commit.compareWithHead` line.
  const idRe = new RegExp(`${escaped}(?![a-zA-Z0-9.])`);
  const regRe = new RegExp(`id:\\s*['"]${escaped}['"]`);
  const commentRe = /^\s*(\/\/|\*|\/\*)/;
  const stack = [srcDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === 'test' || e.name === 'node_modules') continue;
        stack.push(path.join(dir, e.name));
      } else if (/\.(ts|mjs|cjs|js)$/.test(e.name)) {
        const text = fs.readFileSync(path.join(dir, e.name), 'utf8');
        if (!idRe.test(text)) continue;
        for (const line of text.split('\n')) {
          if (!idRe.test(line)) continue;
          if (regRe.test(line)) continue;
          if (commentRe.test(line)) continue;
          return true;
        }
      }
    }
  }
  return false;
}

function main() {
  const pkgPath = process.argv[2] ?? 'package.json';
  const srcDir = process.argv[3] ?? 'src';

  const pkg = loadPkg(pkgPath);
  const hidden = hiddenCommands(pkg);
  const uiIds = menuAndKeybindingIds(pkg);

  const failures = [];
  const staleRatchet = [];

  for (const id of hidden) {
    const reachable = uiIds.has(id) || hasSourceSender(srcDir, id);
    if (reachable) {
      if (RATCHET.has(id)) staleRatchet.push(id);
      continue;
    }
    if (EXEMPT.has(id)) continue;
    if (RATCHET.has(id)) continue;
    failures.push(id);
  }

  let failed = false;
  if (failures.length > 0) {
    failed = true;
    console.error(
      `menu-reachability guard FAILED — ${failures.length} palette-hidden command(s) have no menu entry, keybinding, or in-source sender:`
    );
    for (const id of failures) console.error(`  ${id}`);
    console.error(
      'Wire each into its reference menu placement (or record an accepted divergence in EXEMPT with the ruling).'
    );
  }
  if (staleRatchet.length > 0) {
    failed = true;
    console.error(
      `menu-reachability guard FAILED — ${staleRatchet.length} RATCHET entr(ies) are now reachable; delete them from the list so it only shrinks:`
    );
    for (const id of staleRatchet) console.error(`  ${id}`);
  }
  if (failed) process.exit(1);

  console.log(
    `menu-reachability guard OK — ${hidden.length} palette-hidden command(s) checked (${RATCHET.size} ratcheted, ${EXEMPT.size} exempt).`
  );
}

main();

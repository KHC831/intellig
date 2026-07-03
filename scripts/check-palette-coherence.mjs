#!/usr/bin/env node
/**
 * Structural CI guard — every palette-visible command is a deliberate,
 * reviewed decision.
 *
 * Maintenance contract (per ADR-007 section "Guard maintenance contract"):
 *
 * 1. Bug class
 *    Cmd+Shift+P invokes a command with NO arguments. A handler written for
 *    a tree row / webview row that is left palette-visible either crashes
 *    on the missing item (raw TypeError toast) or silently returns —
 *    seventeen commands shipped in one of those two states (two crashers,
 *    fifteen silent no-ops) because package.json visibility and the
 *    handler's argument contract live in different files with nothing
 *    tying them together. The R8 remediation fixed all of them (hide, or
 *    degrade to a picker/informative toast); this guard makes the DECISION
 *    mandatory for every new command.
 *
 * 2. Heuristic + how it scales
 *    A command is palette-visible unless it has a commandPalette entry with
 *    `"when": "false"`. Every palette-visible command must be listed in
 *    scripts/palette-commands.json — the reviewed manifest of commands
 *    verified to self-serve from a no-argument invocation (repo/target
 *    picker fallback, active-editor scope, or an informative toast; never
 *    silence, never a crash). Adding a command therefore forces one of two
 *    explicit moves in the same PR: hide it (`"when": "false"`) or verify
 *    its no-arg path and add it to the manifest. Stale manifest entries
 *    (no longer contributed, or now hidden) fail too, so the list cannot
 *    rot into an allowlist of everything.
 *
 * 3. Known false-positive cases
 *    None structural: the manifest IS the escape hatch, and each addition
 *    is visible in review next to the handler change.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'scripts', 'palette-commands.json'), 'utf8'));

const contributed = new Set((pkg.contributes?.commands ?? []).map((c) => c.command));
const hidden = new Set(
  (pkg.contributes?.menus?.commandPalette ?? [])
    .filter((m) => m.when === 'false')
    .map((m) => m.command)
);
const visible = [...contributed].filter((id) => !hidden.has(id)).sort();
const listed = new Set(manifest.commands);

const unlisted = visible.filter((id) => !listed.has(id));
const stale = manifest.commands.filter((id) => !contributed.has(id) || hidden.has(id));

let failed = false;
if (unlisted.length > 0) {
  failed = true;
  console.error(
    'check-palette-coherence: palette-visible commands not in the reviewed manifest.\n' +
      'Each must either be hidden from the palette (commandPalette "when": "false" —\n' +
      'right for pure tree/webview context actions) or verified to self-serve a\n' +
      'no-argument invocation (picker fallback / active-editor scope / informative\n' +
      'toast — never silence, never a crash) and added to scripts/palette-commands.json:\n'
  );
  for (const id of unlisted) console.error(`  ${id}`);
}
if (stale.length > 0) {
  failed = true;
  console.error(
    '\ncheck-palette-coherence: stale manifest entries (not contributed, or now hidden) —\n' +
      'remove them from scripts/palette-commands.json:\n'
  );
  for (const id of stale) console.error(`  ${id}`);
}

if (failed) process.exit(1);
console.log(`check-palette-coherence: OK (${visible.length} palette-visible commands, all reviewed)`);

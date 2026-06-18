#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// check-command-reachability.mjs — package.json command ↔ source
// reachability guard.
//
// Maintenance contract (per ADR-007 section "Guard maintenance contract"):
//
// 1. Bug class
//    A command declared in `contributes.commands` whose id is never
//    registered in the extension. VS Code shows it in the palette and in
//    any menu that references it, but invoking it throws
//    "command 'intellig.X' not found" — a broken affordance the user
//    discovers only at click time. This is the manifest-honesty failure:
//    the package.json promises a command the code does not deliver.
//
//    The dual lesson (see workspace-notes / feedback_command_reachability_
//    includes_e2e): a command can be REGISTERED and exercised only by the
//    e2e suite + the palette, with no menu or keybinding. That command is
//    "UI-orphaned" — a PARITY signal (it wants a menu entry), NOT dead
//    code. A prior dead-code sweep grepped production-only, missed the e2e
//    callers, and nearly deleted 11 live commands. So this guard treats the
//    forward direction (declared ⇒ must exist in code) as the hard failure,
//    and never infers "dead" from the absence of a static caller.
//
// 2. Heuristic + how it scales
//    Collect every `contributes.commands[].command` id. Scan production
//    source (the srcDir, excluding any `test` subtree — registration lives
//    in shipped code, not tests) for each id as a literal. A declared id
//    that appears nowhere in production source is a phantom and fails the
//    guard. Adding a command is automatically covered; no per-command
//    edit to this guard is needed.
//
// 3. Known false-positive cases
//    A command whose id is assembled at runtime from fragments
//    (`'intellig.' + verb`) would not appear as a whole literal and could
//    false-fail. The codebase registers every intellig.* id as a whole
//    literal (verified: 0 phantoms at adoption), so none exist today; if
//    one is introduced, register it as a whole-string literal (the
//    house convention) rather than relaxing this guard.
//
// 4. Known false-negative cases
//    The guard checks literal presence, not that the id is passed to a
//    `registerCommand` call specifically — an id mentioned only in a
//    comment would pass. That weaker bound is acceptable: the runtime
//    extension-host smoke test exercises real activation, and an id
//    sitting only in a comment with no registration would surface there.
//    The reverse direction (ids registered in code but not declared in
//    package.json, hence palette-invisible) is a separate check, not yet
//    automated.
//
// 5. Retirement criteria
//    Retire when command registration is generated from a single typed
//    table shared with package.json, making declaration and registration
//    the same source of truth by construction.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

const ID_RE = /intellig\.[a-zA-Z][a-zA-Z0-9.]+/g;

function declaredCommands(pkgPath) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const commands = pkg?.contributes?.commands ?? [];
  return commands.map((c) => c.command).filter((id) => typeof id === 'string');
}

function collectIdsInSource(srcDir) {
  const present = new Set();
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
        for (const m of text.matchAll(ID_RE)) present.add(m[0]);
      }
    }
  }
  return present;
}

function main() {
  const pkgPath = process.argv[2] ?? 'package.json';
  const srcDir = process.argv[3] ?? 'src';

  const declared = declaredCommands(pkgPath);
  const present = collectIdsInSource(srcDir);
  const phantom = declared.filter((id) => !present.has(id));

  if (phantom.length > 0) {
    console.error(
      `command-reachability guard FAILED — ${phantom.length} declared command(s) are not registered in production source:`
    );
    for (const id of phantom) console.error(`  ${id}`);
    console.error(
      'Each declared contributes.commands entry must be registered in shipped code, or invoking it throws "command not found".'
    );
    process.exit(1);
  }

  console.log(
    `command-reachability guard OK — all ${declared.length} declared command(s) appear in production source.`
  );
}

main();

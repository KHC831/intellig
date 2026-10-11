#!/usr/bin/env node
/*
 * check-src-greppable.mjs — keeps every src/ file readable by the grep-based guards.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: a source file containing a literal NUL byte. grep
 *    classifies such a file as BINARY and suppresses its matching lines — it
 *    still exits 0, so a guard that greps for a forbidden pattern and reads the
 *    printed lines sees NOTHING and reports the file clean. Every grep-based
 *    script in scripts/ (the majority of check:all) silently skips the file.
 *    src/git-core/commitGraph.ts was in exactly this state, hiding itself from
 *    the anti-pattern sweeps for as long as it carried literal delimiters.
 *
 *    This is a guard-integrity bug, not a style nit: the failure is SILENT and
 *    it disables other guards rather than the file itself.
 *
 * 2. Heuristic + how it scales: read every TRACKED file under src/ as bytes and
 *    reject any containing 0x00. Escape sequences (`\0`, `\x00`) produce the
 *    same runtime string while keeping the file plain text, so this never costs
 *    a behaviour change — it is purely how the character is SPELLED in source.
 *    Linear in repo size, no parsing.
 *
 *    Enumeration is `git ls-files`, not a directory walk, because the contract
 *    is about SHIPPED source. Finder drops a binary `.DS_Store` into every
 *    directory it visits; a walk fails the whole gate on OS junk that was never
 *    going to ship. Tracked-only makes untracked junk structurally incapable of
 *    tripping this guard rather than relying on a name blocklist.
 *
 *    Scope is src/ AND scripts/. scripts/ is where grep-invisibility does the
 *    most damage — a guard script that grep cannot read is silently skipped by
 *    every meta-analysis over the guards themselves, which is exactly how
 *    check-patch-coverage hid its own NUL sentinel. Neither directory holds a
 *    legitimate binary, so no allowlist policy is needed for them. test/ is
 *    deliberately OUT: binary fixtures are legitimate there.
 *
 * 3. Known false-positive cases: a genuine binary asset that must be TRACKED
 *    under src/ (none today — assets belong in media/, fixtures in test/). Add
 *    it to scripts/src-greppable-allowlist.txt with a one-line justification.
 *
 * 4. Known false-negative cases: other things that make grep treat a file as
 *    binary (invalid UTF-8 sequences, some encodings). NUL is by far the common
 *    case and the one actually hit; broadening this to a full encoding check
 *    would trade a sharp rule for a fuzzy one. A NUL introduced but not yet
 *    `git add`ed also passes — it fails the moment it is staged, which is
 *    before it can reach anyone else.
 *
 * 5. Retirement criteria: retire when every guard in scripts/ is rewritten off
 *    grep (e.g. onto a TS AST pass), at which point binary-ness stops mattering.
 *
 * Usage:
 *   node scripts/check-src-greppable.mjs
 *     — real mode: scans SCANNED_DIRS, allowlist applied.
 *   node scripts/check-src-greppable.mjs <repoRoot> [dir…]
 *     — fixture mode (companion spec): scans the named dirs, or everything
 *       tracked when none are given. Allowlist is NOT applied.
 */

import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { posixRelative } from './lib/posix-path.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directories whose TRACKED files must stay plain text. */
const SCANNED_DIRS = ['src', 'scripts'];
const ALLOWLIST = path.join(repoRoot, 'scripts/src-greppable-allowlist.txt');

const [argRoot, ...argDirs] = process.argv.slice(2);
const fixtureMode = argRoot !== undefined;
const root = fixtureMode ? path.resolve(argRoot) : repoRoot;
const scanDirs = fixtureMode ? argDirs : SCANNED_DIRS;

function readAllowlist() {
  if (fixtureMode || !existsSync(ALLOWLIST)) {
    return new Set();
  }
  return new Set(
    readFileSync(ALLOWLIST, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => line.split(/\s+/)[0])
  );
}

const allowlist = readAllowlist();

/**
 * Tracked files to inspect, as absolute paths, scoped to `scanDirs` (all
 * tracked files when that list is empty — the bare fixture case).
 * NUL-delimited so paths with spaces or newlines survive.
 */
function trackedFiles() {
  const args = ['ls-files', '-z'];
  if (scanDirs.length > 0) {
    args.push('--', ...scanDirs);
  }
  const stdout = execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return stdout
    .split('\0')
    .filter((entry) => entry.length > 0)
    .map((entry) => path.join(root, entry));
}

const offenders = [];
const skipped = [];

for (const file of trackedFiles()) {
  const relative = posixRelative(root, file);
  if (allowlist.has(relative)) {
    continue;
  }
  // A tracked path can be absent from the working tree (a plain `rm`, a paused
  // rebase). The guard's subject is working-tree content, and content that is
  // not there cannot be grep-invisible, so skip it rather than die on ENOENT.
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      skipped.push(relative);
      continue;
    }
    throw err;
  }
  const index = bytes.indexOf(0);
  if (index !== -1) {
    // Report the line so the fix site is obvious.
    const line = bytes.subarray(0, index).toString('utf8').split('\n').length;
    offenders.push(`${relative}:${line} contains a literal NUL byte`);
  }
}

for (const relative of skipped) {
  console.log(`check-src-greppable: skipped ${relative} — tracked but not in the working tree`);
}

if (offenders.length > 0) {
  console.error('check-src-greppable: source files that grep treats as binary\n');
  for (const offender of offenders) {
    console.error(`  - ${offender}`);
  }
  console.error(
    '\n  grep suppresses matching lines in a binary file (while still exiting 0), so every\n' +
      '  grep-based guard silently skips it. Spell the character as an escape (\\0) instead —\n' +
      '  the runtime string is identical and the file stays plain text.\n'
  );
  process.exit(1);
}

console.log('check-src-greppable: OK');

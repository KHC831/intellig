#!/usr/bin/env node
/*
 * check-all-complete.mjs — every defined fence must actually run.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: a `check:*` script is written, given a companion spec,
 *    and then never appended to the `check:all` chain. It passes review (the
 *    script exists, its spec is green) but guards nothing — the gate never
 *    invokes it, so the bug class it was written for walks straight back in.
 *    Two fences shipped in exactly that state.
 *
 * 2. Heuristic + how it scales: read package.json, collect every `check:*`
 *    script name, and require each to appear as `npm run <name>` inside the
 *    `check:all` chain. O(number of scripts), one string scan; scales with the
 *    fence count for free.
 *
 * 3. Known false-positive cases: a fence that legitimately cannot run inside
 *    the headless gate — it needs a prior artifact (a coverage report) or an
 *    Electron host. Those go in scripts/check-all-allowlist.txt with a
 *    one-line justification naming what supplies the missing input.
 *
 * 4. Known false-negative cases: a fence wired into the chain but whose own
 *    logic is a no-op, and a chain entry whose `&&` sequencing is broken so a
 *    later fence never executes. Fence logic is the job of each fence's own
 *    companion spec; sequencing is pinned by the gate running green.
 *
 * 5. Retirement criteria: retire when the fences move to a manifest the gate
 *    enumerates directly, so "defined" and "wired" become the same fact.
 *
 * Usage:
 *   node scripts/check-all-complete.mjs
 *     — real mode: reads ./package.json, allowlist applied.
 *   node scripts/check-all-complete.mjs <packageJsonPath>
 *     — fixture mode (companion spec): allowlist is NOT applied.
 */

import { readFileSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const [argPackageJson] = process.argv.slice(2);
const fixtureMode = argPackageJson !== undefined;
const packageJsonFile = fixtureMode
  ? path.resolve(argPackageJson)
  : path.join(repoRoot, 'package.json');
const ALLOWLIST = path.join(repoRoot, 'scripts/check-all-allowlist.txt');

/** Fences exempt from the chain, with justification. */
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

const scripts = JSON.parse(readFileSync(packageJsonFile, 'utf8')).scripts ?? {};
const chain = scripts['check:all'];

if (typeof chain !== 'string') {
  console.error('check-all-complete: package.json defines no `check:all` script');
  process.exit(1);
}

const allowlist = readAllowlist();
const missing = [];

for (const name of Object.keys(scripts)) {
  if (!name.startsWith('check:') || name === 'check:all' || allowlist.has(name)) {
    continue;
  }
  // Match the invocation, not a bare substring: `check:config` must not be
  // satisfied by `npm run check:config-coherence`.
  const invoked = new RegExp(`npm run ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  if (!invoked.test(chain)) {
    missing.push(name);
  }
}

if (missing.length > 0) {
  console.error('check-all-complete: fences defined but never run by check:all\n');
  for (const name of missing) {
    console.error(
      `  - ${name}: append \`&& npm run ${name}\` to the check:all chain ` +
        `(or allowlist it in scripts/check-all-allowlist.txt with a justification).`
    );
  }
  console.error('');
  process.exit(1);
}

console.log('check-all-complete: OK');

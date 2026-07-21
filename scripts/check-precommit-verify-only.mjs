#!/usr/bin/env node
/*
 * check-precommit-verify-only.mjs — structural guard for the commit path.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: the pre-commit hook MUTATES staged content. `git commit`
 *    runs husky -> lint-staged, and a `prettier --write` / `eslint --fix` entry
 *    rewrites the staged files DURING the commit — AFTER the gate has already
 *    run. So the content that lands is not the content the gate verified. The
 *    silent direction is the one that bites: a reflow can JOIN two lines and
 *    move a violation onto a line a LINE-LOCAL fence (git-path-unquoted,
 *    panel-dispose-seam, focus-restore-on-render) no longer inspects, and a
 *    re-run of the gate after the fact passes too. Making the hook verify-only
 *    means the committed bytes equal the gated bytes, so the gate cannot be
 *    bypassed by a post-gate rewrite. The fix pass moves BEFORE the gate
 *    (`npm run fix`); the hook can only refuse, never rewrite.
 *
 * 2. Heuristic + how it scales: parse the `lint-staged` command list from
 *    package.json AND the `.husky/pre-commit` hook body, and fail if either
 *    carries a mutating formatter flag (`--write`, `--fix`). Verify-only
 *    commands (`prettier --check`, `eslint --max-warnings 0`) cannot alter a
 *    staged file. Two files, a token scan — cost is constant.
 *
 * 3. Known false-positive cases: a lint-staged entry that legitimately needs
 *    `--write` for a GENERATED artifact the gate does not read. There is no
 *    in-hook escape hatch on purpose — such a step belongs in the pre-gate
 *    `fix` pass, not the commit hook, so the remedy is to MOVE it, not mark it.
 *
 * 4. Known false-negative cases: a mutating flag spelled differently (`-w`,
 *    `--write=true`), a formatter other than prettier/eslint invoked with a
 *    non-matching flag, or a hook that shells out to a script which itself
 *    rewrites files. The token scan is line-local; review is the backstop.
 *
 * 5. Retirement criteria: retire when the commit path can no longer run a
 *    formatter at all (formatting enforced solely in CI over immutable
 *    content), so no hook can rewrite what lands.
 *
 * Usage:
 *   node scripts/check-precommit-verify-only.mjs
 *     — real mode: the repo's own package.json + .husky/pre-commit.
 *   node scripts/check-precommit-verify-only.mjs <packageJsonPath> [preCommitPath]
 *     — fixture mode (companion spec).
 */

import { readFileSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const [argPackageJson, argPreCommit] = process.argv.slice(2);
const fixtureMode = argPackageJson !== undefined;
const packageJsonPath = fixtureMode ? path.resolve(argPackageJson) : path.join(repoRoot, 'package.json');
const preCommitPath = fixtureMode
  ? argPreCommit !== undefined
    ? path.resolve(argPreCommit)
    : undefined
  : path.join(repoRoot, '.husky/pre-commit');

// A mutating flag, not followed by another flag-word char so `--fix-dry-run`
// (which does not write) and `--write`-prefixed longer flags do not match.
const MUTATING = /--(write|fix)(?![\w-])/;

/** Flatten a lint-staged config to the list of command strings it runs. */
function lintStagedCommands(config) {
  if (!config || typeof config !== 'object') {
    return [];
  }
  const commands = [];
  for (const value of Object.values(config)) {
    if (typeof value === 'string') {
      commands.push(value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string') {
          commands.push(entry);
        }
      }
    }
  }
  return commands;
}

const failures = [];

if (!existsSync(packageJsonPath)) {
  console.error(`check-precommit-verify-only: package.json not found at ${packageJsonPath}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
for (const command of lintStagedCommands(pkg['lint-staged'])) {
  if (MUTATING.test(command)) {
    failures.push(`lint-staged command mutates staged content: \`${command}\``);
  }
}

if (preCommitPath !== undefined && existsSync(preCommitPath)) {
  const hook = readFileSync(preCommitPath, 'utf8');
  for (const line of hook.split('\n')) {
    if (MUTATING.test(line)) {
      failures.push(`.husky/pre-commit rewrites staged content: \`${line.trim()}\``);
    }
  }
}

if (failures.length > 0) {
  console.error('check-precommit-verify-only: the commit hook can rewrite what lands\n');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error(
    '\nMake the hook verify-only (prettier --check, eslint --max-warnings 0) and\n' +
      'run the fix pass BEFORE the gate (`npm run fix`), so the gate sees final content.'
  );
  process.exit(1);
}

console.log('check-precommit-verify-only: OK');

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
 *    staged file. Also fail if a lint-staged config lives OUTSIDE package.json
 *    (`.lintstagedrc*` / `lint-staged.config.*`), which `npx lint-staged`
 *    auto-discovers first: this guard reads only package.json, so a relocated
 *    config would let it pass vacuously. Two files plus a filename scan — cost
 *    is constant.
 *    Pinning cases per arm (companion spec): the lint-staged arm flips on
 *    "fails when a lint-staged command carries prettier --write"; the hook arm
 *    on "fails when the pre-commit hook body rewrites staged content"; the
 *    external-config arm on "fails when lint-staged config lives in an external
 *    file the guard cannot read".
 *
 * 3. Known false-positive cases: a lint-staged entry that legitimately needs
 *    `--write` for a GENERATED artifact the gate does not read. There is no
 *    in-hook escape hatch on purpose — such a step belongs in the pre-gate
 *    `fix` pass, not the commit hook, so the remedy is to MOVE it, not mark it.
 *    A verify-only external config (`.lintstagedrc` with only `--check`) also
 *    fails: a `.js`/`.ts` config is code this scan cannot statically clear, so
 *    the rule is one home, not a per-file read. Remedy: inline it in
 *    package.json.
 *
 * 4. Known false-negative cases: a mutating flag spelled differently (`-w`),
 *    a formatter other than prettier/eslint invoked with a non-matching flag,
 *    or a hook that shells out to a script which itself rewrites files. The
 *    token scan is line-local; review is the backstop.
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

import { readFileSync, existsSync, readdirSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const [argPackageJson, argPreCommit] = process.argv.slice(2);
const fixtureMode = argPackageJson !== undefined;
const packageJsonPath = fixtureMode
  ? path.resolve(argPackageJson)
  : path.join(repoRoot, 'package.json');
const preCommitPath = fixtureMode
  ? argPreCommit !== undefined
    ? path.resolve(argPreCommit)
    : undefined
  : path.join(repoRoot, '.husky/pre-commit');

// A mutating flag, not followed by another flag-word char so `--fix-dry-run`
// (which does not write) and `--write`-prefixed longer flags do not match.
const MUTATING = /--(write|fix)(?![\w-])/;

// `npx lint-staged` (lilconfig) auto-discovers a config from any of these
// BEFORE package.json's `lint-staged` key. A config relocated into one could
// carry `--write` while this guard, which reads only package.json, passed
// vacuously. package.json is the one sanctioned home, so any external config
// file fails — a `.js`/`.ts` config is code this scan cannot statically clear.
// Matched by shape, not a fixed extension list, so a future variant lint-staged
// adds (`.lintstagedrc.json5`, another loader) is covered without an edit; the
// authority is lint-staged/lib/configFiles.js CONFIG_FILE_NAMES.
function isExternalLintStagedConfig(name) {
  return (
    /^\.lintstagedrc(\.[A-Za-z0-9]+)?$/.test(name) ||
    /^lint-staged\.config\.[A-Za-z0-9]+$/.test(name) ||
    name === 'package.yaml' ||
    name === 'package.yml'
  );
}

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

const configDir = path.dirname(packageJsonPath);
for (const name of readdirSync(configDir)) {
  if (isExternalLintStagedConfig(name)) {
    failures.push(
      `lint-staged config lives outside package.json (\`${name}\`); the verify-only ` +
        `fence reads only package.json, so move it there`
    );
  }
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

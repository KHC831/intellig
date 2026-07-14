#!/usr/bin/env node
/**
 * Structural CI guard — intellig config keys stay a single typed source of
 * truth, and code-side keys agree with the package.json settings schema both
 * ways.
 *
 * Maintenance contract (per ADR-007 section "Guard maintenance contract"):
 *
 * 1. Bug class
 *    A setting is read with `getConfiguration('intellig').get('<key>')`, a bare
 *    string with no tie to `contributes.configuration`. A typo returns the
 *    inline fallback silently; an inline fallback duplicates (and drifts from)
 *    the schema default; an enum read as `get<string>` loses the type the
 *    schema promises. The typed `CONFIG_KEYS`/`ConfigValues` module in
 *    src/config/configKeys.ts is the intended single seam (readConfig /
 *    updateConfig / inspectConfig, no fallback param). This guard funnels every
 *    intellig config access through it and keeps the map coherent with the
 *    manifest.
 *
 * 2. Heuristic + how it scales
 *    Rule A (ban): every `.ts` under srcDir (except *.test.ts and the seam
 *    module itself) is read as one string and scanned for
 *    `getConfiguration(<ws>'intellig'` — content-based so a call split across
 *    lines is caught, and prefix-matching so the section-style reads
 *    (`'intellig.log'` etc.) and writes (`.update`) are covered by the same
 *    ban. A match fails unless a `// config-key-exempt: <reason>` comment sits
 *    within the four lines above. Rule B extracts the code-side key set from the
 *    `CONFIG_KEYS` object literal (prefixed with `intellig.`) and the schema key
 *    set from `contributes.configuration[].properties`, and fails on any drift
 *    either direction. Adding a setting + a CONFIG_KEYS entry is covered
 *    automatically; no per-key edit here.
 *
 * 3. Known false-positive cases
 *    None: the ban keys on the `'intellig'` literal, so `getConfiguration('editor'
 *    …)` and a method literally named `getConfiguration()` never match.
 *
 * 4. Known false-negative cases
 *    `affectsConfiguration('intellig.…')` key strings and any
 *    `WorkspaceConfiguration` handle stored in a variable then read later are
 *    NOT covered — the ban keys on the `getConfiguration('intellig'` call shape.
 *    Acceptable: the migration removes stored-handle reads, and change-event key
 *    strings are a separate, smaller surface.
 *
 * 5. Retirement criteria
 *    Retire when settings and their schema are generated from one typed table,
 *    making the key a shared literal with no second side to drift.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SEAM_REL = join('config', 'configKeys.ts');

function collectTsFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectTsFiles(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Rule A — raw getConfiguration('intellig'…) outside the seam (cross-line). */
function findRawGetConfiguration(srcDir) {
  const violations = [];
  const rawRe = /getConfiguration\(\s*['"]intellig/g;
  for (const file of collectTsFiles(srcDir)) {
    if (file.endsWith('.test.ts')) continue;
    if (relative(srcDir, file) === SEAM_REL) continue;
    const content = readFileSync(file, 'utf8');
    let m;
    while ((m = rawRe.exec(content)) !== null) {
      const line = content.slice(0, m.index).split('\n').length;
      const lines = content.split('\n');
      const windowAbove = lines.slice(Math.max(0, line - 1 - 4), line - 1).join('\n');
      if (!windowAbove.includes('config-key-exempt:')) {
        violations.push({ file: relative(root, file), line });
      }
    }
  }
  return violations;
}

/** Rule B (code side) — string-literal values inside CONFIG_KEYS, intellig.-prefixed. */
function readCodeKeys(srcDir) {
  const seamPath = join(srcDir, SEAM_REL);
  if (!existsSync(seamPath)) {
    console.error(`check-config-keys: seam module not found at ${seamPath}.`);
    process.exit(1);
  }
  const src = readFileSync(seamPath, 'utf8');
  const objMatch = src.match(/CONFIG_KEYS\s*=\s*\{([\s\S]*?)\}\s*as const/);
  const body = objMatch ? objMatch[1] : '';
  const keys = new Set();
  for (const m of body.matchAll(/:\s*'([^']+)'/g)) keys.add(`intellig.${m[1]}`);
  return keys;
}

/** Rule B (schema side) — every intellig.* key in contributes.configuration. */
function readSchemaKeys(pkgPath) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const cfg = pkg.contributes?.configuration;
  const sections = Array.isArray(cfg) ? cfg : cfg ? [cfg] : [];
  const keys = new Set();
  for (const section of sections) {
    for (const key of Object.keys(section.properties ?? {})) {
      if (key.startsWith('intellig.')) keys.add(key);
    }
  }
  return keys;
}

function main() {
  const pkgPath = process.argv[2] ?? join(root, 'package.json');
  const srcDir = process.argv[3] ?? join(root, 'src');

  const failures = [];

  for (const v of findRawGetConfiguration(srcDir)) {
    failures.push(
      `check-config-keys: raw getConfiguration('intellig'…) outside the seam at\n` +
        `${v.file}:${v.line}. Read via readConfig()/updateConfig() from src/config/configKeys.ts,\n` +
        'or justify with `// config-key-exempt: <reason>` within the four lines above.'
    );
  }

  const codeKeys = readCodeKeys(srcDir);
  const schemaKeys = readSchemaKeys(pkgPath);

  for (const key of codeKeys) {
    if (!schemaKeys.has(key)) {
      failures.push(`check-config-keys: '${key}' is in CONFIG_KEYS but not in package.json schema.`);
    }
  }
  for (const key of schemaKeys) {
    if (!codeKeys.has(key)) {
      failures.push(
        `check-config-keys: schema key '${key}' is not in CONFIG_KEYS (src/config/configKeys.ts).`
      );
    }
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(f);
    process.exit(1);
  }

  console.log(
    'check-config-keys: OK (getConfiguration(intellig) funneled through the seam; CONFIG_KEYS and schema agree both ways)'
  );
}

main();

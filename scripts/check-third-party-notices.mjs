#!/usr/bin/env node
/*
 * check-third-party-notices.mjs — every third-party package IntelliG ships has
 * a notice, at the version that ships.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: a bundled package updated (by hand or by Dependabot)
 *    while THIRD_PARTY_NOTICES.md still names the old version, a newly
 *    bundled package shipping with no notice, or a notice left behind for a
 *    package that no longer ships. MIT and CC-BY-4.0 both require the notice
 *    to travel with the copy that ships.
 *
 * 2. Heuristic + how it scales: the shipped set is every package a non-type
 *    import, re-export, require() or import() in src/ names (esbuild bundles
 *    them), plus ASSET_PACKAGES, whose files the build copies into media/.
 *    Each must have a `## <package> <version>` heading in
 *    THIRD_PARTY_NOTICES.md whose version equals package-lock.json's, and
 *    every heading must name a shipped package. One parse per src file.
 *    Pinning cases (companion spec): "fails a notice whose version differs
 *    from the installed one", "fails a bundled import with no notice".
 *
 * 3. Known false-positive cases: a value import of a package esbuild marks
 *    external (only `vscode`, skipped here). Add any new external alongside it.
 *
 * 4. Known false-negative cases: an asset copied from a package not in
 *    ASSET_PACKAGES, and code pasted into src/ from a package rather than
 *    imported. Review is the backstop.
 *
 * 5. Retirement criteria: none while IntelliG bundles third-party code.
 *
 * Usage:
 *   node scripts/check-third-party-notices.mjs          — checks this repository
 *   node scripts/check-third-party-notices.mjs <root>   — fixture mode (companion spec): <root> holds
 *                                                         package-lock.json, THIRD_PARTY_NOTICES.md and src/
 */

import { builtinModules } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { posixRelative } from './lib/posix-path.mjs';

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');

/** Packages whose files the build copies into the package, keyed to the copy. */
const ASSET_PACKAGES = {
  'monaco-editor': 'media/monaco/vs/loader.js',
  '@vscode/codicons': 'media/codicon.ttf',
};
const EXTERNAL = new Set(['vscode']);
const BUILTIN = new Set(builtinModules);

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) {
    return out;
  }
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** The package a bare specifier names, or undefined for relative, built-in and external ones. */
function packageOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return undefined;
  }
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return BUILTIN.has(name) || EXTERNAL.has(name) ? undefined : name;
}

/** True when an import or export declaration brings in types only, so esbuild drops it. */
function typeOnly(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) {
      return false;
    }
    if (clause.isTypeOnly) {
      return true;
    }
    const bindings = clause.namedBindings;
    return (
      !clause.name &&
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((e) => e.isTypeOnly)
    );
  }
  return node.isTypeOnly;
}

/** package → first src file that ships it */
const shipped = new Map();
const ship = (name, where) => {
  if (name && !shipped.has(name)) {
    shipped.set(name, where);
  }
};

for (const file of walk(join(root, 'src'))) {
  const rel = posixRelative(root, file);
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !typeOnly(node)
    ) {
      ship(packageOf(node.moduleSpecifier.text), rel);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      ship(packageOf(node.arguments[0].text), rel);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
for (const [name, asset] of Object.entries(ASSET_PACKAGES)) {
  if (existsSync(join(root, asset))) {
    ship(name, asset);
  }
}

if (shipped.size === 0) {
  console.error(
    'check-third-party-notices: found no shipped third-party package; the check is vacuous'
  );
  process.exit(1);
}

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const notices = new Map(
  [
    ...readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').matchAll(/^## (\S+) (\S+)\s*$/gm),
  ].map((m) => [m[1], m[2]])
);

const failures = [];
for (const [name, where] of shipped) {
  const installed = lock.packages?.[`node_modules/${name}`]?.version;
  if (!notices.has(name)) {
    failures.push(`${name}: ships (via ${where}) but has no notice in THIRD_PARTY_NOTICES.md`);
  } else if (notices.get(name) !== installed) {
    failures.push(
      `${name}: the notice names ${notices.get(name)} but ${installed ?? 'no version'} is installed; ` +
        'update the heading and check the license text still matches'
    );
  }
}
for (const name of notices.keys()) {
  if (!shipped.has(name)) {
    failures.push(`${name}: has a notice but nothing ships it; remove the section`);
  }
}

if (failures.length > 0) {
  console.error('[check:third-party-notices] FAIL:');
  for (const f of failures) {
    console.error(`  ${f}`);
  }
  process.exit(1);
}
console.log(
  `[check:third-party-notices] OK — ${shipped.size} shipped package(s), each with a current notice.`
);

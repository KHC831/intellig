#!/usr/bin/env node
/*
 * check-test-path-equality.mjs — tests compare paths from different sources through isSamePath.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: a test comparing two paths as strings when only one
 *    side was resolved. On Windows git prints `D:/a/x`, Node spells `D:\a\x`
 *    and temp dirs surface as 8.3 short names, so `e.path ===
 *    fs.realpathSync(target)` passes on macOS and Linux and fails only on
 *    the Windows CI runner, after a push. Three worktree specs shipped this
 *    way.
 *
 * 2. Heuristic + how it scales: parse every test file with the TypeScript
 *    compiler. For each `===` / `!==` and each `assert.strictEqual` /
 *    `notStrictEqual` / `deepStrictEqual` / `equal` / `notEqual` call, fail
 *    when exactly one of the two operands is resolved: a call to
 *    `realpathSync`, `realpathSync.native` or `canonicalizeFsPath`, or a
 *    `const` bound to one in the same file. Comparisons go through
 *    test/helpers/samePath.ts (`isSamePath`), which resolves both sides.
 *    One parse per test file. Pinning cases (companion spec): "fails a
 *    comparison with one resolved side" and "follows a const bound to a
 *    resolved path".
 *
 * 3. Known false-positive cases: a comparison where the unresolved side is
 *    already canonical by construction (another helper's return value).
 *    Mark it with `// path-equality-exempt: <reason>` on the line or the
 *    line above.
 *
 * 4. Known false-negative cases: a comparison where neither side is
 *    resolved (`entry.path === path.join(root, 'x')`), which this cannot
 *    tell from two Node-built paths; a resolved value passed through a
 *    function, a `let`, or another module; and a separator assumption in
 *    string operations (`endsWith('/x')`, `split('/')`). Windows CI is the
 *    backstop, and product code converts git-printed paths at the source
 *    (src/git-core/fromGitPath.ts).
 *
 * 5. Retirement criteria: retire when a lint rule or a typed path wrapper
 *    makes raw string comparison of paths impossible in tests.
 *
 * Usage:
 *   node scripts/check-test-path-equality.mjs        — scans ./test
 *   node scripts/check-test-path-equality.mjs <dir>  — fixture mode (companion spec)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { posixRelative } from './lib/posix-path.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.argv[2] ?? join(repoRoot, 'test');

const RESOLVERS = new Set(['realpathSync', 'canonicalizeFsPath']);
const ASSERTS = new Set(['strictEqual', 'notStrictEqual', 'deepStrictEqual', 'equal', 'notEqual']);
const EXEMPT = /path-equality-exempt:\s*\S/;

function walk(dir) {
  const out = [];
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

/** The name a call's callee ends in: `fs.realpathSync.native(x)` → `realpathSync`. */
function resolverName(call) {
  let callee = call.expression;
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'native') {
    callee = callee.expression;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  return ts.isIdentifier(callee) ? callee.text : undefined;
}

function isResolverCall(node) {
  return ts.isCallExpression(node) && RESOLVERS.has(resolverName(node) ?? '');
}

const files = walk(root);
if (files.length === 0) {
  console.error('check-test-path-equality: scanned zero files; the scan is vacuous');
  process.exit(1);
}

const failures = [];
let exempt = 0;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  if (!/realpathSync|canonicalizeFsPath/.test(source)) {
    continue;
  }
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split('\n');

  const resolvedConsts = new Set();
  const collect = (node) => {
    if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const) {
      for (const decl of node.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && isResolverCall(decl.initializer)) {
          resolvedConsts.add(decl.name.text);
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const isResolved = (node) => {
    let inner = node;
    while (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner)) {
      inner = inner.expression;
    }
    return isResolverCall(inner) || (ts.isIdentifier(inner) && resolvedConsts.has(inner.text));
  };

  const check = (node, a, b) => {
    if (isResolved(a) === isResolved(b)) {
      return;
    }
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    if (EXEMPT.test(lines[line - 1] ?? '') || EXEMPT.test(lines[line - 2] ?? '')) {
      exempt++;
      return;
    }
    failures.push(`${posixRelative(root, file)}:${line}: ${(lines[line - 1] ?? '').trim()}`);
  };

  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      check(node, node.left, node.right);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ASSERTS.has(node.expression.name.text) &&
      node.arguments.length >= 2
    ) {
      check(node, node.arguments[0], node.arguments[1]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (failures.length > 0) {
  console.error(
    'check-test-path-equality: a path compared as a string with only one side resolved.'
  );
  console.error(
    'Windows spells the same path differently per source (git D:/a/x, Node D:\\a\\x, 8.3 temp names).\n' +
      'Compare through isSamePath (test/helpers/samePath.ts), or justify with `// path-equality-exempt: <reason>`.'
  );
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}
console.log(`check-test-path-equality: OK (${files.length} files, ${exempt} exempt)`);

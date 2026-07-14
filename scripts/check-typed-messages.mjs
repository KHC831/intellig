#!/usr/bin/env node
/**
 * Structural CI guard — webview messages are dispatched through the typed spine,
 * not raw VS Code handles, and every migrated handler keeps its compile-time
 * exhaustiveness gate.
 *
 * Maintenance contract (per ADR-007 section "Guard maintenance contract"):
 *
 * 1. Bug class
 *    A webview message is a stringly-typed `{ type: '…' }` blob crossing the
 *    host↔webview boundary. Raw `webview.onDidReceiveMessage(unknown)` handlers
 *    and raw `webview.postMessage(anything)` sends carry no contract: a renamed
 *    field or a dropped case fails silently at runtime. The typed spine
 *    (BaseWebviewPanel/View generic `postMessage(TOutbound)` + per-panel
 *    `<panel>.protocol.ts` union + discriminant guard + `assertNever`) makes the
 *    host send on-contract and handle every variant. This guard keeps dispatch
 *    on the spine.
 *
 * 2. Heuristic + how it scales
 *    Every non-test `.ts` under srcDir is read as one string (content-based, so
 *    a call wrapping across lines is caught). Rule A bans `.onDidReceiveMessage(`
 *    outside the Base classes. Rule B bans the raw handle `webview.postMessage(`
 *    (receiver-keyed, so the typed `this.postMessage(` Base method is allowed).
 *    Rule C requires an `assertNever` in any file that imports a `*.protocol`
 *    module AND defines a message handler (so the exhaustiveness gate can't be
 *    silently deleted). A RATCHETING allowlist (NOT_YET_MIGRATED) tolerates raw
 *    sites in panels not yet migrated; each Phase-4 round removes its files, and
 *    the final round empties it — an empty allowlist with any remaining raw site
 *    FAILS, so the ratchet can't regrow. New raw sites in unlisted files fail
 *    from day one.
 *
 * 3. Known false-positive cases
 *    None: `.getState()` / `vscode.getState()` don't match either call shape;
 *    `vscode.postMessage(` (the webview-side handle) isn't receiver-`webview`;
 *    prose mentions of `onDidReceiveMessage`/`postMessage` without a trailing `(`
 *    don't match.
 *
 * 4. Known false-negative cases
 *    The string-emitted webview side (scriptBuilder.ts + inline dialog scripts)
 *    calls `postMessage`/`addEventListener('message')` as raw strings the fence
 *    cannot type-check; it is OUT OF SCOPE until Phase 5 turns those scripts into
 *    TS importing these protocol modules (Phase 5's check:no-string-scripts
 *    ratchet removes the hole). A handle aliased to a non-`webview` identifier
 *    would also evade Rule B; the house convention posts via `this.postMessage`
 *    or `<x>.webview.postMessage`.
 *
 * 5. Retirement criteria
 *    Retire when every panel is on the typed spine and the webview side is TS
 *    (Phase 5), making raw handles unreachable at the type level.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const BASE_FILES = new Set([join('utils', 'BaseWebviewPanel.ts'), join('utils', 'BaseWebviewView.ts')]);

/**
 * Ratcheting allowlist — panels not yet migrated to the typed spine still hold
 * raw sites. Each Phase-4 round deletes its files here; Round 4 empties it and
 * it must stay empty. Paths are relative to srcDir.
 */
const NOT_YET_MIGRATED_DEFAULT = [
  join('commits', 'CommitDialog.ts'),
  join('commits', 'CommitToolWindow.ts'),
  join('git-core', 'gitToolWindow', 'GitToolWindowProvider.ts'),
  join('rebase', 'RebaseEditor.ts'),
  join('rebase', 'RebaseProgressView.ts'),
];

const ON_DID_RECEIVE_RE = /\.onDidReceiveMessage\s*\(/g;
const RAW_POST_RE = /\bwebview\s*\.\s*postMessage\s*\(/g;
const PROTOCOL_IMPORT_RE = /from\s+['"][^'"]*\.protocol['"]/;
const HANDLER_DEF_RE = /_onMessage\s*\(|_handleMessage\s*\(|_handleWebviewMessage\s*\(/;

function collectTsFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectTsFiles(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

function hasExemptAbove(content, line) {
  const lines = content.split('\n');
  return lines
    .slice(Math.max(0, line - 1 - 4), line - 1)
    .join('\n')
    .includes('typed-messages-exempt:');
}

function main() {
  const srcDir = process.argv[2] ?? join(root, 'src');
  const allowlist = new Set(
    process.argv[3] !== undefined
      ? process.argv[3].split(',').filter((s) => s.length > 0)
      : NOT_YET_MIGRATED_DEFAULT
  );

  const failures = [];

  for (const file of collectTsFiles(srcDir)) {
    if (file.endsWith('.test.ts')) continue;
    const rel = relative(srcDir, file);
    if (BASE_FILES.has(rel)) continue;
    const content = readFileSync(file, 'utf8');
    const relRoot = relative(root, file);
    const allowlisted = allowlist.has(rel);

    // Rule A — raw onDidReceiveMessage outside the Base classes.
    let m;
    ON_DID_RECEIVE_RE.lastIndex = 0;
    while ((m = ON_DID_RECEIVE_RE.exec(content)) !== null) {
      const line = lineOf(content, m.index);
      if (allowlisted || hasExemptAbove(content, line)) continue;
      failures.push(
        `check-typed-messages: raw onDidReceiveMessage outside the Base classes at ${relRoot}:${line}.\n` +
          'Dispatch through BaseWebviewPanel/BaseWebviewView, or justify with a\n' +
          '`// typed-messages-exempt: <reason>` comment within the four lines above.'
      );
    }

    // Rule B — raw webview-handle postMessage (not the typed this.postMessage).
    RAW_POST_RE.lastIndex = 0;
    while ((m = RAW_POST_RE.exec(content)) !== null) {
      const line = lineOf(content, m.index);
      if (allowlisted || hasExemptAbove(content, line)) continue;
      failures.push(
        `check-typed-messages: raw webview.postMessage handle at ${relRoot}:${line}.\n` +
          'Send via the typed this.postMessage(TOutbound) Base method, or justify with a\n' +
          '`// typed-messages-exempt: <reason>` comment within the four lines above.'
      );
    }

    // Rule C — a protocol-importing handler must keep an assertNever gate.
    if (PROTOCOL_IMPORT_RE.test(content) && HANDLER_DEF_RE.test(content)) {
      if (!content.includes('assertNever')) {
        failures.push(
          `check-typed-messages: ${relRoot} imports a *.protocol union and defines a message\n` +
            'handler but has no assertNever exhaustiveness gate. Add `default: assertNever(msg)`.'
        );
      }
    }
  }

  // Ratchet integrity: an empty allowlist must stay empty (no remaining raw
  // site) — already enforced above since an empty allowlist marks nothing
  // allowlisted, so any raw site fails. Nothing extra needed here.

  if (failures.length > 0) {
    for (const f of failures) console.error(f);
    process.exit(1);
  }

  console.log('check-typed-messages: OK (webview dispatch on the typed spine; exhaustiveness gates present)');
}

main();

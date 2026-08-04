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
 *    silently deleted). Rule E requires every `*Outbound` union discriminant in
 *    a `<name>.protocol.ts` to appear in the webview entry source(s) that
 *    type-import that protocol (files under a `webview/` directory): a host arm
 *    the entry never mentions is a DEAD POST — the exact defect that left the
 *    commit tool window's live updates silently unwired. Exempt an arm consumed
 *    elsewhere (e.g. a follower window) with a `// fence-exempt: <reason>`
 *    comment on or directly above the union member. One-directional by design:
 *    an unused webview listener arm is dead code, not a silent product bug.
 *    A RATCHETING allowlist (NOT_YET_MIGRATED) tolerates raw
 *    sites in panels not yet migrated; each Phase-4 round removes its files, and
 *    the final round empties it — an empty allowlist with any remaining raw site
 *    FAILS, so the ratchet can't regrow. New raw sites in unlisted files fail
 *    from day one.
 *
 * 3. Known false-positive cases
 *    Rules A-D: none — `.getState()` / `vscode.getState()` don't match either
 *    call shape; `vscode.postMessage(` (the webview-side handle) isn't
 *    receiver-`webview`; prose mentions of `onDidReceiveMessage`/`postMessage`
 *    without a trailing `(` don't match. Rule E: an entry that dispatches on
 *    the discriminant through an indirection (a lookup table of type strings)
 *    rather than the quoted literal would flag — no such site exists; if one
 *    appears, justify it with `// fence-exempt: <reason>` on the union member.
 *
 * 4. Known false-negative cases
 *    The string-emitted webview side (scriptBuilder.ts + inline dialog scripts)
 *    calls `postMessage`/`addEventListener('message')` as raw strings the fence
 *    cannot type-check; it is OUT OF SCOPE until Phase 5 turns those scripts into
 *    TS importing these protocol modules (Phase 5's check:no-string-scripts
 *    ratchet removes the hole). Rule B's receiver pattern is `\w*[wW]ebview`
 *    followed by `(?:\?\.|\.)`, so identifier-suffixed handles AND optional-chained
 *    sends (`_followerWebview?.postMessage`, `panel.webview?.postMessage`) are
 *    caught, not just the literal `webview.` receiver — an aliased or `?.`-accessed
 *    raw handle can't silently bypass the fence. It deliberately does NOT match the
 *    string-emitted `vscode.postMessage(` webview-side text (the Phase-5 hole).
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
const NOT_YET_MIGRATED_DEFAULT = [];

const ON_DID_RECEIVE_RE = /\.onDidReceiveMessage\s*\(/g;
const RAW_POST_RE = /\b\w*[wW]ebview\s*(?:\?\.|\.)\s*postMessage\s*\(/g;
const PROTOCOL_IMPORT_RE = /from\s+['"][^'"]*\.protocol['"]/;
const HANDLER_DEF_RE = /_onMessage\s*\(|_handleMessage\s*\(|_handleWebviewMessage\s*\(/;
const INBOUND_TYPES_DEF_RE = /\b\w*_INBOUND_TYPES\s*=\s*\[/;
const OUTBOUND_UNION_RE = /export\s+type\s+\w*Outbound\s*=/g;
const OUTBOUND_ARM_RE = /type:\s*'([^']+)'/g;

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

function hasFenceExemptAt(content, line) {
  // The member's own line or the two lines above it (a leading comment).
  const lines = content.split('\n');
  return lines
    .slice(Math.max(0, line - 3), line)
    .join('\n')
    .includes('fence-exempt:');
}

/**
 * Slice a type-union body starting at `startIndex` up to its terminating
 * top-level `;` (semicolons inside member braces don't terminate it).
 */
function unionBlock(content, startIndex) {
  let depth = 0;
  for (let i = startIndex; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
    } else if (ch === ';' && depth === 0) {
      return content.slice(startIndex, i);
    }
  }
  return content.slice(startIndex);
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
    // The gate must be a CALL (a prose mention in a comment is not a gate).
    // A forwarding shell whose switch + gate moved to a module says so with a
    // file-scoped `// typed-messages-exempt-rule-c: <reason>` marker (distinct
    // from the line-scoped A/B marker, which such files may already carry).
    if (PROTOCOL_IMPORT_RE.test(content) && HANDLER_DEF_RE.test(content)) {
      const hasGateCall = /assertNever\s*\(/.test(content);
      const hasRuleCExempt = content.includes('typed-messages-exempt-rule-c:');
      if (!hasGateCall && !hasRuleCExempt) {
        failures.push(
          `check-typed-messages: ${relRoot} imports a *.protocol union and defines a message\n` +
            'handler but has no assertNever exhaustiveness gate. Add `default: assertNever(msg)`,\n' +
            'or — when the switch and its gate live in an extracted module — justify with a\n' +
            '`// typed-messages-exempt-rule-c: <reason>` comment.'
        );
      }
    }

    // Rule D — a runtime `*_INBOUND_TYPES` discriminant array must carry the
    // compile-time InboundArrayTie to its inbound union. Without it, a variant
    // added to the union + host switch but NOT the array is silently
    // guard-rejected at runtime (the effort's bug class, inside the guard).
    if (INBOUND_TYPES_DEF_RE.test(content) && !content.includes('InboundArrayTie<')) {
      failures.push(
        `check-typed-messages: ${relRoot} defines an *_INBOUND_TYPES array with no InboundArrayTie\n` +
          'compile tie to its inbound union. Add\n' +
          '`type _Tie = AssertInboundArrayTie<InboundArrayTie<XInbound, typeof X_INBOUND_TYPES>>;`\n' +
          'from src/utils/protocolTie.ts (a missing/extra discriminant then fails to compile).'
      );
    }
  }

  // Rule E — every host→webview outbound arm has a consumer in the panel's
  // bundled entry. Consumers are the files under a `webview/` directory that
  // import the arm's `<name>.protocol` module; the arm's quoted discriminant
  // must appear in at least one of them.
  const allFiles = collectTsFiles(srcDir).filter((f) => !f.endsWith('.test.ts'));
  const webviewFiles = allFiles.filter((f) =>
    relative(srcDir, f).split(/[\\/]/).includes('webview')
  );
  const webviewContents = new Map(webviewFiles.map((f) => [f, readFileSync(f, 'utf8')]));
  for (const protoFile of allFiles.filter((f) => f.endsWith('.protocol.ts'))) {
    const content = readFileSync(protoFile, 'utf8');
    const relRoot = relative(root, protoFile);
    const baseName = relative(srcDir, protoFile)
      .split(/[\\/]/)
      .pop()
      .slice(0, -'.protocol.ts'.length);
    const importRe = new RegExp(`from\\s+['"][^'"]*\\b${baseName}\\.protocol['"]`);
    const consumerText = [...webviewContents.values()].filter((c) => importRe.test(c)).join('\n');

    let unionMatch;
    OUTBOUND_UNION_RE.lastIndex = 0;
    while ((unionMatch = OUTBOUND_UNION_RE.exec(content)) !== null) {
      const union = unionBlock(content, unionMatch.index);
      let arm;
      OUTBOUND_ARM_RE.lastIndex = 0;
      while ((arm = OUTBOUND_ARM_RE.exec(union)) !== null) {
        const literal = arm[1];
        const line = lineOf(content, unionMatch.index + arm.index);
        if (hasFenceExemptAt(content, line)) continue;
        if (!consumerText.includes(`'${literal}'`) && !consumerText.includes(`"${literal}"`)) {
          failures.push(
            `check-typed-messages: outbound arm '${literal}' at ${relRoot}:${line} has no consumer\n` +
              `in any webview entry importing ${baseName}.protocol — a host post nobody handles is a\n` +
              'silent no-op. Handle the arm in the bundled entry, or justify with a\n' +
              '`// fence-exempt: <reason>` comment on the union member.'
          );
        }
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

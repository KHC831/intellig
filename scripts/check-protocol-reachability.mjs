#!/usr/bin/env node
/*
 * check-protocol-reachability.mjs — no declared webview message may be unreachable.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: a message type declared in a typed protocol union that
 *    nothing on the webview side ever mentions — an INBOUND type the webview
 *    never posts (so the host's handler is dead code that reads as a working
 *    feature) or an OUTBOUND type the webview never handles (so the host posts
 *    into the void). This is the single largest class in the parity audit:
 *    ~10 of 61 findings were "ported but never wired", including the Incoming
 *    tab's selection/jump handlers, which shipped complete and unreachable.
 *
 *    Both directions reduce to one rule: the type literal must appear in the
 *    webview sources for that protocol. A sender and a handler both spell it.
 *
 * 2. Heuristic + how it scales: for each `src/**\/*.protocol.ts`, collect every
 *    `type: '<name>'` literal, then require each to appear as a quoted literal
 *    somewhere under that protocol's webview directory (PROTOCOL_WEBVIEWS
 *    below, derived from the esbuild entry list in scripts/build-webview.mjs).
 *    Two file reads per protocol; scales with protocol count, which is small.
 *
 * 3. Known false-positive cases: a type genuinely driven from somewhere other
 *    than its own webview bundle — e.g. a host-to-host channel, or a message a
 *    DIFFERENT surface posts into this protocol. Add it to
 *    scripts/protocol-reachability-allowlist.txt as `<protocol> <type>` with a
 *    one-line justification. Investigate before allowlisting: an unreachable
 *    type is far more often a wiring bug than a legitimate exception.
 *
 * 4. Known false-negative cases: a type mentioned in the webview only inside a
 *    comment or a dead branch still counts as reachable — this proves the
 *    string is KNOWN to the webview, not that it is wired to a live control.
 *    Behavioural wiring is the unit/entry specs' job; this guard catches the
 *    total absence that no test would notice.
 *
 * 5. Retirement criteria: retire when host and webview share generated
 *    dispatch code, so an unhandled/unsent member cannot compile.
 *
 * Usage:
 *   node scripts/check-protocol-reachability.mjs
 *     — real mode: scans src/, allowlist applied.
 *   node scripts/check-protocol-reachability.mjs <srcRoot>
 *     — fixture mode (companion spec): expects <srcRoot>/x.protocol.ts next to
 *       <srcRoot>/webview/, allowlist NOT applied.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { posixRelative } from './lib/posix-path.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = path.join(repoRoot, 'scripts/protocol-reachability-allowlist.txt');

/**
 * protocol basename → the webview directory that implements it. Mirrors the
 * esbuild entry list in scripts/build-webview.mjs; the two tab protocols and
 * the merge window share their surface's directory.
 */
const PROTOCOL_WEBVIEWS = {
  shelveDialog: 'src/shelf/webview',
  newBranchDialog: 'src/branches/webview',
  mergeDialog: 'src/conflicts/webview',
  resolveConflictsDialog: 'src/conflicts/webview',
  mergeWindow: 'src/conflicts/merge-window/webview',
  commitDialog: 'src/commits/webview',
  commitMessageDialog: 'src/commits/webview',
  commitToolWindow: 'src/commits/webview',
  resetDialog: 'src/ui-shell/webview',
  rebaseDialog: 'src/rebase/webview',
  rebaseProgressView: 'src/rebase/webview',
  rebaseEditor: 'src/rebase/webview',
  applyPatchDialog: 'src/patches/webview',
  pushDialog: 'src/sync/webview',
  defineRemoteDialog: 'src/sync/webview',
  gitToolWindow: 'src/git-core/gitToolWindow/webview',
  gitToolWindowTabs: 'src/git-core/gitToolWindow/webview',
};

const argRoot = process.argv[2];
const fixtureMode = argRoot !== undefined;

function readAllowlist() {
  if (fixtureMode || !existsSync(ALLOWLIST)) {
    return new Set();
  }
  return new Set(
    readFileSync(ALLOWLIST, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => {
        const [protocol, type] = line.split(/\s+/);
        return `${protocol} ${type}`;
      })
  );
}

function walk(dir, ext = '.ts') {
  const out = [];
  if (!existsSync(dir)) {
    return out;
  }
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, ext));
    } else if (full.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

const allowlist = readAllowlist();
const failures = [];

/** Resolve the protocol files + their webview dirs for the mode we're in. */
function protocolTargets() {
  if (fixtureMode) {
    const root = path.resolve(argRoot);
    return walk(root)
      .filter((f) => f.endsWith('.protocol.ts'))
      .map((file) => ({
        name: path.basename(file, '.protocol.ts'),
        file,
        webviewDir: path.join(root, 'webview'),
      }));
  }
  return walk(path.join(repoRoot, 'src'))
    .filter((f) => f.endsWith('.protocol.ts'))
    .map((file) => {
      const name = path.basename(file, '.protocol.ts');
      const dir = PROTOCOL_WEBVIEWS[name];
      return { name, file, webviewDir: dir ? path.join(repoRoot, dir) : undefined };
    });
}

for (const { name, file, webviewDir } of protocolTargets()) {
  if (webviewDir === undefined) {
    failures.push(
      `${name}.protocol.ts has no webview directory mapped. Add it to PROTOCOL_WEBVIEWS ` +
        `in this script (mirroring scripts/build-webview.mjs) so its types can be checked.`
    );
    continue;
  }
  const declared = new Set(
    [...readFileSync(file, 'utf8').matchAll(/type:\s*'([^']+)'/g)].map((m) => m[1])
  );
  const webviewSource = walk(webviewDir)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  for (const type of [...declared].sort()) {
    if (allowlist.has(`${name} ${type}`)) {
      continue;
    }
    if (!webviewSource.includes(`'${type}'`)) {
      failures.push(
        `${name}: '${type}' is declared in the protocol but never appears in ` +
          `${posixRelative(repoRoot, webviewDir)} — nothing posts it and nothing handles it.`
      );
    }
  }
}

if (failures.length > 0) {
  console.error('check-protocol-reachability: unreachable webview message types\n');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error(
    '\n  Wire it to a real control/handler, delete it, or allowlist it with a\n' +
      '  justification in scripts/protocol-reachability-allowlist.txt.\n'
  );
  process.exit(1);
}

console.log('check-protocol-reachability: OK');

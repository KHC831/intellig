#!/usr/bin/env node
/**
 * Structural CI guard — one home for the webview Content-Security-Policy.
 *
 * Maintenance contract (per ADR-007 section "Guard maintenance contract"):
 *
 * 1. Bug class
 *    A hand-rolled inline `default-src` CSP string is a policy fork: it drifts
 *    from the shared builder and silently widens or narrows the sandbox (the
 *    static tool-window documents once carried img/font-src they never needed,
 *    dropped only when unified onto buildWebviewCsp). Every webview CSP must
 *    come from `src/utils/webviewCsp.ts` (full policy, or the minimal
 *    `{ images: false, fonts: false }` variant) so a change lands in one place.
 *
 * 2. Heuristic + how it scales
 *    Scope: every `src/**` .ts file except `src/utils/webviewCsp.ts` (the
 *    sanctioned home). Any line containing a `default-src` directive is a
 *    violation unless a `csp-exempt: <reason>` comment sits within the four
 *    lines above it. Exemptions are for genuinely different policies (the merge
 *    window loads Monaco worker scripts, so its script-src is not nonce-only).
 *
 * 3. Known false-positive cases
 *    Prose that literally writes `default-src` in a comment outside the home
 *    file would trip the guard; add a `csp-exempt:` note or route through the
 *    builder. None today.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { posixRelative } from './lib/posix-path.mjs';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const HOME = join(srcDir, 'utils', 'webviewCsp.ts');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];
for (const file of walk(srcDir)) {
  if (file === HOME) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('default-src')) continue;
    const windowAbove = lines.slice(Math.max(0, i - 4), i).join('\n');
    if (!windowAbove.includes('csp-exempt:')) {
      violations.push(`  ${posixRelative(root, file)}:${i + 1}`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    'check-webview-csp: inline `default-src` CSP string outside src/utils/webviewCsp.ts.\n' +
      'Build the policy with buildWebviewCsp (full, or the minimal\n' +
      '`{ images: false, fonts: false }` variant), or add a justified\n' +
      '`// csp-exempt: <reason>` comment within the four lines above:\n'
  );
  for (const v of violations) console.error(v);
  process.exit(1);
}
console.log('check-webview-csp: OK');

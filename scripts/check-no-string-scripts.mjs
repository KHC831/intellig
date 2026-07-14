#!/usr/bin/env node
/**
 * check-no-string-scripts — bans a host `.ts` from emitting an INLINE executable
 * `<script>…code…</script>` into webview HTML. The webview client code must ship
 * as a real bundled TS entry (esbuild → media/webview/<panel>.js) referenced by an
 * external `<script nonce src=…>` tag, so it compiles against the Phase-4
 * `*.protocol.ts` unions and a wire mismatch is a COMPILE error, not a silent
 * runtime break. This is the Phase-5 half of the webview-boundary fence.
 *
 * ADR-007 guard-maintenance contract:
 *
 * 1. What it enforces
 *    A non-test `.ts` may not contain `<script…>BODY</script>` with non-empty BODY
 *    unless the tag carries `src=` (external bundle — the GOAL) or the file is
 *    allowlisted / the site is exempted. The Base sentinel `<script nonce></script>`
 *    (empty body) and external `<script … src=…>` tags PASS.
 *
 * 2. Ratcheting allowlist
 *    STRING_SCRIPT_ALLOWLIST_DEFAULT lists panels whose script is still a host
 *    string, seeded Round 1 with every string-emitting panel. Each port round
 *    removes its file; the last round empties it. An empty allowlist with any
 *    remaining inline-script emitter FAILS, so the ratchet can't regrow.
 *
 * 3. Escape hatch (permanent exceptions, not ratchet slots)
 *    A `// no-string-script-exempt: <reason>` comment within the four lines above
 *    a `<script>` open tag exempts that one site. Reserved for irreducible inline
 *    boot blocks — the merge window's Monaco AMD `require(['vs/...'])` deferral,
 *    which cannot be a pure external bundle (Monaco-specific, --global-name).
 *
 * 4. Known false-negative cases
 *    A script assembled outside a single `<script>…</script>` literal (built by
 *    string concatenation across statements) would evade the content regex; the
 *    repo convention emits the tag as one template literal. CSS (`<style>`) is out
 *    of scope — it is authorized by `style-src` and is not the bug class.
 *
 * 5. Complementary half
 *    check:typed-messages (Phase 4) deliberately excluded the string-emitted
 *    webview side (raw `postMessage`/listeners inside script strings). That hole
 *    closes panel-by-panel HERE: once a panel's script is a TS entry, its
 *    webview-side post/receive is typed and compiled. When this allowlist empties,
 *    the Phase-4 hole is fully closed. The two fences are complementary halves.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Ratcheting allowlist — panels whose client code is still a host-emitted script
 * string. Each Phase-5 port round removes its file(s); the final round empties it
 * and it must stay empty. Paths are relative to srcDir.
 */
const STRING_SCRIPT_ALLOWLIST_DEFAULT = [
  join('commits', 'CommitDialog.ts'),
  join('commits', 'CommitMessageDialog.ts'),
  join('commits', 'CommitToolWindow.ts'),
  join('conflicts', 'ResolveConflictsDialog.ts'),
  join('git-core', 'gitToolWindow', 'GitToolWindowProvider.ts'),
  join('git-core', 'gitToolWindow', 'html', 'commonHtml.ts'),
  join('git-core', 'gitToolWindow', 'provider', 'htmlBuilders.ts'),
  join('patches', 'ApplyPatchDialog.ts'),
  join('rebase', 'RebaseDialog.ts'),
  join('rebase', 'RebaseEditor.ts'),
  join('rebase', 'RebaseProgressView.ts'),
  join('sync', 'PushDialog.ts'),
  join('ui-shell', 'ResetDialog.ts'),
  // The Base view wraps each subclass's `${script}` in an inline tag; it comes
  // off the ratchet when its last subclass is ported and it emits an external
  // bundle tag (Round 4 — the tool window).
  join('utils', 'BaseWebviewView.ts'),
];

const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/**
 * Blank comment content (block + line) with spaces, preserving every newline and
 * the character count, so scanning ignores prose `<script>` mentions in JSDoc
 * while reported line numbers still point at the real source position. The `:`
 * guard leaves `https://` in string literals intact.
 */
function maskComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/([^:]|^)\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

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
    .includes('no-string-script-exempt:');
}

function main() {
  const srcDir = process.argv[2] ?? join(root, 'src');
  const allowlist = new Set(
    process.argv[3] !== undefined
      ? process.argv[3].split(',').filter((s) => s.length > 0)
      : STRING_SCRIPT_ALLOWLIST_DEFAULT
  );

  const failures = [];

  for (const file of collectTsFiles(srcDir)) {
    if (file.endsWith('.test.ts')) continue;
    const rel = relative(srcDir, file);
    const rawContent = readFileSync(file, 'utf8');
    const content = maskComments(rawContent);
    const relRoot = relative(root, file);
    const allowlisted = allowlist.has(rel);

    let m;
    SCRIPT_BLOCK_RE.lastIndex = 0;
    while ((m = SCRIPT_BLOCK_RE.exec(content)) !== null) {
      const attrs = m[1];
      const body = m[2];
      if (/\bsrc\s*=/.test(attrs)) continue; // external bundle — the goal
      if (body.trim().length === 0) continue; // empty sentinel
      const line = lineOf(content, m.index);
      if (allowlisted || hasExemptAbove(rawContent, line)) continue;
      failures.push(
        `check-no-string-scripts: inline executable <script> with body at ${relRoot}:${line}.\n` +
          'Ship webview code as a bundled TS entry (media/webview/<panel>.js) referenced\n' +
          'by an external <script nonce src=…> tag, or justify an irreducible inline boot\n' +
          'with a `// no-string-script-exempt: <reason>` comment within the four lines above.'
      );
    }
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(f);
    process.exit(1);
  }

  console.log(
    'check-no-string-scripts: OK (webview client code ships as bundled TS entries; no inline script strings outside the ratchet)'
  );
}

main();

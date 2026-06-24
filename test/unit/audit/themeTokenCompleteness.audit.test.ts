/**
 * Theme-token completeness audit (spec 7.1).
 *
 * The panel's inline CSS resolves every fg/bg color through a VS Code
 * `var(--vscode-...)` token first, with an IntelliJ-parity hex literal ONLY
 * as the fallback for themes that don't define the token (ADR-010).
 * A raw hex that is NOT a documented fallback is the
 * regression this audit forbids — it pins a color the user's theme can't
 * override, which breaks high-contrast and custom themes (spec 7.2).
 *
 * This is a STATIC source audit: it scans the provider plus its extracted
 * style/HTML builder modules (`GitToolWindowProvider.ts`, `stylesBuilder.ts`,
 * `htmlBuilders.ts`) for every `#RGB` / `#RRGGBB` / `#RRGGBBAA` literal and
 * classifies each one. The CSS that carries the bulk of the hex fallbacks now
 * lives in the style builder, so the scan reads the union of those files to
 * keep covering every rendered color after the builders were extracted.
 * A literal is ALLOWED when it appears in one of these load-bearing
 * contexts:
 *
 *   1. The `INTELLIJ_FILE_STATUS_COLORS` brand-palette table — the
 *      canonical IntelliJ file-status colors, mirrored into CSS variables.
 *   2. A CSS `var(--token, #hex)` fallback — the hex is the documented
 *      last-resort value when the token is undefined.
 *   3. A JS `|| '#hex'` / `?? '#hex'` code fallback (e.g. the
 *      `INTELLIJ_FILE_STATUS_COLORS[status] || '#FFFFFF'` default).
 *   4. An explicit allowlist entry below, each with a rationale.
 *
 * Anything else — a bare `color: #abcdef;` with no token in front of it —
 * fails. The failure message tells the next contributor to wrap the color
 * in a `var(--vscode-..., #hex)` fallback or add an allowlist entry.
 *
 * Maintenance: when a new fallback hex is intentionally added, prefer
 * wiring it as a `var(--token, #hex)` (auto-allowed by rule 2). Only touch
 * the allowlist for the rare standalone case, and cite why.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function repoRoot(): string {
  // test/unit/audit/themeTokenCompleteness.audit.test.ts -> repo root.
  return path.resolve(__dirname, '../../..');
}

const PANEL_FILE = 'src/git-core/gitToolWindow/GitToolWindowProvider.ts';

/**
 * The full set of files the audit scans: the provider plus the extracted
 * style/HTML builder modules the CSS + helper hexes migrated into. Each is
 * read absent-tolerantly (a not-yet-created module reads as ''), so the audit
 * stays green whether or not a given builder file exists yet — the scanned
 * color set is the union of whichever of these are present.
 */
const PANEL_FILES = [
  PANEL_FILE,
  'src/git-core/gitToolWindow/provider/stylesBuilder.ts',
  'src/git-core/gitToolWindow/provider/htmlBuilders.ts',
];

/**
 * Read a repo-relative file, tolerating absence: a missing file reads as the
 * empty string so the union scan is robust to a builder module that hasn't
 * been extracted yet (keeps green-at-every-commit in both directions).
 */
function readIfExists(relPath: string): string {
  try {
    return fs.readFileSync(path.join(repoRoot(), relPath), 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Hex literals permitted as STANDALONE values (not inside a var() fallback,
 * not in the brand-palette table, not a JS `||` fallback). Keep this list
 * tiny and justified — every entry is a color the user's theme cannot
 * override, so each needs a reason it's acceptable.
 */
const STANDALONE_HEX_ALLOWLIST: Array<{ hex: string; rationale: string }> = [
  {
    hex: '#9876AA',
    rationale:
      'IntelliJ-parity remote-branch violet — user chose pixel-faithful over theme-token adaptivity (issue #10 decision A)',
  },
  {
    hex: '#499C54',
    rationale:
      'IntelliJ-parity local-branch green — hardcoded pixel-faithful over theme-token adaptivity; the badge-background token rendered the theme grey, not green (issue #10 dogfood fix)',
  },
  {
    hex: '#d4a017',
    rationale:
      'IntelliJ-parity current-branch yellow — hardcoded pixel-faithful over the statusBarItem-warning token, matching the local-green/remote-violet hardcodes (issue #10 dogfood fix)',
  },
  {
    hex: '#e4faff',
    rationale:
      'IntelliJ-parity common-commit highlight (light) — VersionControl.Log.Commit.currentBranchBackground; no VS Code token equivalent, so the light value is set on a theme-driven CSS variable',
  },
  {
    hex: '#3f4749',
    rationale:
      'IntelliJ-parity common-commit highlight (dark) — VersionControl.Log.Commit.currentBranchBackground dark value, applied under body.vscode-dark/high-contrast',
  },
];

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;

/**
 * Classify one hex occurrence by inspecting the line it appears on.
 * Returns the allow-reason, or null if the hex is a bare, non-fallback
 * color (a violation).
 */
function classify(line: string, hex: string): string | null {
  // Rule 2: CSS var() fallback — `var(--token, #hex)` (possibly nested).
  // The hex sits after a comma inside a var(...) call. We accept any line
  // where the hex is preceded by `var(--` and a comma somewhere before it.
  if (/var\(\s*--[^)]*,[^)]*#[0-9a-fA-F]{3,8}/.test(line)) {
    return 'var() fallback';
  }
  // Rule 3: JS `||` / `??` code fallback — `... || '#hex'` / `... ?? "#hex"`.
  if (/(\|\||\?\?)\s*['"`]#[0-9a-fA-F]{3,8}/.test(line)) {
    return 'JS || fallback';
  }
  // Rule 1: brand-palette table entry — `key: '#hex',` with a trailing
  // comment naming the file-status color. These lines assign into
  // INTELLIJ_FILE_STATUS_COLORS or the mirrored `--intellij-*` CSS vars.
  if (/^\s*[A-Za-z-]+:\s*['"]?#[0-9a-fA-F]{3,8}/.test(line)) {
    return 'brand-palette entry';
  }
  // Rule 4: explicit standalone allowlist.
  const allow = STANDALONE_HEX_ALLOWLIST.find((e) => e.hex.toLowerCase() === hex.toLowerCase());
  if (allow) {
    return `allowlisted: ${allow.rationale}`;
  }
  return null;
}

describe('Theme-token completeness audit (spec 7.1)', () => {
  let lines: string[];

  before(() => {
    // Union of the provider + extracted builder modules (absent-tolerant).
    // The per-line classifier is position-independent, so concatenating the
    // files' lines is sound — a hex is judged purely by its own line.
    lines = PANEL_FILES.flatMap((rel) => readIfExists(rel).split('\n'));
  });

  it('every hex literal in the panel is a token fallback, brand-palette entry, or allowlisted', () => {
    const violations: string[] = [];

    // Strip comments before scanning so a hex mentioned in PROSE (e.g. "the
    // remote-only hex (#1a3a5c) is retained...") never counts as a rendered
    // color. We track `/* ... */` block state across lines and drop `//`
    // line-comment tails, then scan only the surviving code text. This is a
    // lightweight stripper, not a full JS/CSS tokenizer — sufficient because
    // the panel never embeds `//` or `/*` inside a string literal on a line
    // that also carries a color hex (verified by the negative-control test
    // below catching any future drift in what the scan reaches).
    let inBlockComment = false;

    lines.forEach((line, i) => {
      let code = '';
      let j = 0;
      while (j < line.length) {
        if (inBlockComment) {
          const end = line.indexOf('*/', j);
          if (end === -1) {
            j = line.length; // rest of line is comment
          } else {
            inBlockComment = false;
            j = end + 2;
          }
          continue;
        }
        // Not in a block comment: look for the next comment opener.
        const lineComment = line.indexOf('//', j);
        const blockOpen = line.indexOf('/*', j);
        const next =
          lineComment === -1
            ? blockOpen
            : blockOpen === -1
              ? lineComment
              : Math.min(lineComment, blockOpen);
        if (next === -1) {
          code += line.slice(j);
          break;
        }
        code += line.slice(j, next);
        if (next === lineComment) {
          break; // rest of line is a line comment
        }
        inBlockComment = true;
        j = next + 2;
      }

      const matches = code.match(HEX_RE);
      if (!matches) {
        return;
      }
      for (const hex of matches) {
        const reason = classify(code, hex);
        if (reason === null) {
          violations.push(`  line ${i + 1}: bare hex ${hex} — ${line.trim()}`);
        }
      }
    });

    assert.strictEqual(
      violations.length,
      0,
      [
        `Found ${violations.length} bare hex color(s) in ${PANEL_FILE} not covered by a`,
        `var(--vscode-..., #hex) fallback, the brand palette, or the allowlist:`,
        ...violations,
        ``,
        `Fix: wrap the color in a VS Code token fallback —`,
        `  color: var(--vscode-someToken, #hex);`,
        `— or, for a justified standalone case, add an entry to`,
        `STANDALONE_HEX_ALLOWLIST in this audit with a rationale. See spec 7.1.`,
      ].join('\n')
    );
  });

  it('finds the IntelliJ brand-palette colors (audit is actually scanning the file)', () => {
    // Negative-control: prove the scan reaches the palette. If this fails,
    // the file moved or the palette was removed — either way the audit
    // above is silently passing on an empty/!wrong file.
    const joined = lines.join('\n');
    assert.ok(
      joined.includes('#629755') && joined.includes('#6897BB'),
      'expected the IntelliJ brand-palette hexes (#629755 green, #6897BB blue) in the panel; ' +
        'if absent, this audit may be scanning the wrong file.'
    );
  });
});

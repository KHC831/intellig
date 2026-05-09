/**
 * URI-scheme coherence audit — forbid the `git-show:` scheme in production code.
 *
 * Background: the IntelliG extension registers a single
 * `TextDocumentContentProvider` under the `intellig-git:` URI scheme (see
 * `registerGitContentProvider` in `src/extension.ts`). For a period, four
 * callsites constructed URIs with an unregistered `git-show:` scheme, which
 * caused VS Code to throw `Unable to resolve resource git-show:...` the
 * moment the user invoked "Compare with Local" / "Show File at Revision" /
 * "Compare Branches → file diff". Senior review R5 flagged this as L-3; it
 * was mis-triaged and shipped.
 *
 * To catch this class of bug at PR time, this audit scans the production
 * source tree (`src/**` minus tests and mocks) for any occurrence of the
 * `git-show:` scheme in a string literal. Any match fails the suite with
 * file:line so the reviewer can demand the callsite switch to the
 * registered `intellig-git:` scheme.
 *
 * Files intentionally excluded:
 *   - `src/test/**` — test fixtures may reference forbidden strings in
 *     assertions or historical context comments.
 *   - `src/__mocks__/**` — same reason.
 *   - This file itself — the pattern string literal lives here.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Patterns that flag a forbidden URI scheme embedded in a string literal.
 * We match the scheme prefix with a leading quote (single, double, or
 * backtick) so the audit only catches string-literal usage — not the string
 * appearing inside a comment that happens to type the scheme for
 * documentation purposes. (The standalone `isCommentLine` filter below
 * backstops this with a second pass.)
 */
const FORBIDDEN_SCHEME_PATTERNS: RegExp[] = [
  /['"`]git-show:/,
];

/** Source roots under the repo root that participate in the audit. */
const SCAN_ROOTS: string[] = ['src'];

/**
 * Path segments (matched as "contains" substrings on the POSIX-normalized
 * repo-relative path) that disqualify a file from the audit.
 */
const EXCLUDE_PATH_SEGMENTS: string[] = [
  'src/test/',
  'src/__mocks__/',
  // This test file references the forbidden scheme as a literal; exclude
  // it so the audit doesn't flag its own pattern list.
  'src/test/unit/audit/uriScheme.audit.test.ts',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function walk(root: string, out: string[]): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') {
        continue;
      }
      walk(full, out);
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
}

function isExcluded(relPath: string): boolean {
  const posix = toPosix(relPath);
  return EXCLUDE_PATH_SEGMENTS.some((seg) => posix.includes(seg));
}

interface Hit {
  file: string; // repo-relative POSIX path
  line: number; // 1-indexed
  snippet: string;
  pattern: string;
}

/**
 * Skip lines whose first non-whitespace characters are a JS/TS comment
 * marker. Comments may legitimately mention `git-show:` when describing
 * the migration or historical context; they don't execute at runtime.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('/*')) return true;
  if (trimmed.startsWith('*/')) return true;
  if (trimmed.startsWith('*')) return true;
  return false;
}

function scanFile(repoRoot: string, absPath: string): Hit[] {
  const rel = toPosix(path.relative(repoRoot, absPath));
  const raw = fs.readFileSync(absPath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const hits: Hit[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    for (const pattern of FORBIDDEN_SCHEME_PATTERNS) {
      if (pattern.test(line)) {
        hits.push({
          file: rel,
          line: i + 1,
          snippet: line.trim(),
          pattern: pattern.source,
        });
      }
    }
  }

  return hits;
}

function collectForbiddenHits(): Hit[] {
  const repoRoot = path.resolve(process.cwd());
  const unmarked: Hit[] = [];
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(repoRoot, root);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      walk(abs, files);
    }
  }
  for (const abs of files) {
    const rel = toPosix(path.relative(repoRoot, abs));
    if (isExcluded(rel)) {
      continue;
    }
    unmarked.push(...scanFile(repoRoot, abs));
  }
  return unmarked;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('URI-scheme coherence audit: forbid `git-show:` in production code', () => {
  it('production source contains no string literals using the unregistered `git-show:` scheme', () => {
    const hits = collectForbiddenHits();
    if (hits.length === 0) {
      return;
    }
    const message =
      `Found ${hits.length} production-code string literal(s) using the unregistered ` +
      `\`git-show:\` URI scheme. Only \`intellig-git:\` is registered as a ` +
      `TextDocumentContentProvider (see \`registerGitContentProvider\` in ` +
      `\`src/extension.ts\`). URIs built with \`git-show:\` cause VS Code to ` +
      `throw "Unable to resolve resource git-show:..." when the user invokes ` +
      `the command. Rename every occurrence to \`intellig-git:\` and make sure ` +
      `the URI query is a single URL-encoded ref (e.g. ` +
      `\`intellig-git:\${filePath}?\${encodeURIComponent(ref)}\`).\n\n` +
      hits.map((h) => `  ${h.file}:${h.line}\n    ${h.snippet}`).join('\n\n');
    assert.fail(message);
  });

  it('the audit scanner itself is functional (self-check: detects synthetic `git-show:` literals)', () => {
    // Sanity check the regex survives future edits. If someone refactors
    // the pattern and accidentally neuters the detector, this test fails
    // loudly rather than silently letting the drift back in.
    const synthetic = [
      `const uri = vscode.Uri.parse('git-show:foo.ts?ref=abc');`,
      `const uri = vscode.Uri.parse("git-show:foo.ts?ref=abc");`,
      'const uri = vscode.Uri.parse(`git-show:${path}?ref=${ref}`);',
    ];
    for (const line of synthetic) {
      const matched = FORBIDDEN_SCHEME_PATTERNS.some((p) => p.test(line));
      assert.strictEqual(
        matched,
        true,
        `Audit regex failed to match expected forbidden form: ${line}`
      );
    }
  });

  it('comment lines mentioning `git-show:` do not trip the audit', () => {
    // Migration notes / historical context comments should not be flagged.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uri-scheme-audit-'));
    const tmpFile = path.join(tmpDir, 'sample.ts');
    try {
      fs.writeFileSync(
        tmpFile,
        [
          "// The legacy `git-show:` scheme was renamed to `intellig-git:`.",
          "/* Previously: 'git-show:' — now replaced. */",
          " * Historical: `git-show:foo.ts` was never registered.",
          'const uri = "intellig-git:foo.ts?ref=abc";',
          '',
        ].join('\n'),
        'utf-8'
      );
      const hits = scanFile(tmpDir, tmpFile);
      assert.deepStrictEqual(
        hits,
        [],
        'Comment lines mentioning the legacy scheme must not be flagged'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('an executable line using the `git-show:` scheme IS flagged', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uri-scheme-audit-'));
    const tmpFile = path.join(tmpDir, 'sample.ts');
    try {
      fs.writeFileSync(
        tmpFile,
        'const uri = vscode.Uri.parse(`git-show:${path}?ref=${ref}`);\n',
        'utf-8'
      );
      const hits = scanFile(tmpDir, tmpFile);
      assert.strictEqual(hits.length, 1, `Expected 1 forbidden hit; got ${hits.length}`);
      assert.strictEqual(hits[0].line, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * R6-Gap-C allowlist enforcement — `repositories[0]` / `getRepositories()[0]`
 * audit test.
 *
 * Background: in a multi-root workspace `gitService.getRepositories()[0]` is
 * whichever repo the git service enumerated first — NOT necessarily the repo
 * that owns the file the user is acting on. Production code must go through
 * `resolveRepo(gitService, { preferActive: true, silent: true })` instead so
 * the active-editor preference is honored.
 *
 * This test scans the production source tree (`src/**` minus tests and
 * mocks) for any occurrence of the drift pattern. Every remaining hit MUST
 * carry an inline `// ALLOWED: <reason>` marker on the same line or the line
 * immediately above, so the invariant is self-documenting.
 *
 * If you add a new `repositories[0]` call site that is genuinely legitimate
 * (single-repo-guaranteed branch, cold-start last-resort fallback,
 * documentation/comment), annotate it with `// ALLOWED: <reason>` and the
 * test will stop failing. If you can't justify the site, migrate it to
 * `resolveRepo` instead.
 *
 * Scanned patterns (case-sensitive):
 *   - `repositories[0]`
 *   - `getRepositories()[0]`
 *   - `.repos[0]`
 *
 * Files intentionally excluded:
 *   - `src/test/**` (test fixtures often construct throw-away single-repo
 *     contexts where `repositories[0]` is the test scaffolding, not a real
 *     drift bug).
 *   - `src/__mocks__/**` (same reason).
 *   - This file itself (the pattern string literals live here).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** The regex patterns that flag the drift. */
const DRIFT_PATTERNS: RegExp[] = [
  /\brepositories\[0\]/,
  /\.getRepositories\(\)\[0\]/,
  /\.repos\[0\]/,
];

/** Source roots under the repo root that participate in the audit. */
const SCAN_ROOTS: string[] = ['src'];

/**
 * Absolute path segments that disqualify a file from the audit. Matched as
 * "contains" substrings against the file's relative path (normalized to /).
 */
const EXCLUDE_PATH_SEGMENTS: string[] = [
  'src/test/',
  'src/__mocks__/',
  // This test file references the drift strings as literals; exclude it so
  // the audit doesn't flag its own pattern list.
  'src/test/unit/audit/repositoriesZero.audit.test.ts',
];

/** The allowlist marker comment that exempts a hit. */
const ALLOWLIST_MARKER = '// ALLOWED:';

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
      // Skip node_modules / out / dist if present under src (shouldn't be,
      // but defensive).
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

// Heuristic: is this line a pure comment / doc-comment? If the first
// non-whitespace characters are a JS/TS comment marker (line comment, block
// open, block close, or block interior), the drift reference is
// documentation, not executable code, and we skip it. This keeps the audit
// tight without the annotator having to sprinkle `// ALLOWED:` markers on
// doc-comment blocks that describe the migration itself.
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('//')) {
    return true;
  }
  if (trimmed.startsWith('/*')) {
    return true;
  }
  if (trimmed.startsWith('*/')) {
    return true;
  }
  if (trimmed.startsWith('*')) {
    return true;
  }
  return false;
}

function scanFile(repoRoot: string, absPath: string): Hit[] {
  const rel = toPosix(path.relative(repoRoot, absPath));
  const raw = fs.readFileSync(absPath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const hits: Hit[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip pure comment lines — they document the migration; they don't
    // execute `repositories[0]` at runtime.
    if (isCommentLine(line)) {
      continue;
    }
    for (const pattern of DRIFT_PATTERNS) {
      if (pattern.test(line)) {
        // Check the allowlist marker on the same line OR on any of the
        // consecutive comment lines directly above the hit. This lets
        // annotators write a multi-line justification above the call
        // site rather than jamming it onto one line:
        //
        //   // ALLOWED: deterministic fallback on cold start because
        //   // the git service is still empty and no active editor
        //   // can narrow the choice.
        //   const repo = repositories[0];
        const thisLine = line;
        let allowed = thisLine.includes(ALLOWLIST_MARKER);
        if (!allowed) {
          for (let k = i - 1; k >= 0; k--) {
            const prev = lines[k];
            if (!isCommentLine(prev)) {
              break;
            }
            if (prev.includes(ALLOWLIST_MARKER)) {
              allowed = true;
              break;
            }
          }
        }
        if (allowed) {
          continue;
        }
        hits.push({
          file: rel,
          line: i + 1,
          snippet: thisLine.trim(),
          pattern: pattern.source,
        });
      }
    }
  }

  return hits;
}

function collectUnmarkedHits(): Hit[] {
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

describe('R6 Gap-C: `repositories[0]` audit', () => {
  it('every production-code occurrence of `repositories[0]` / `getRepositories()[0]` carries an `// ALLOWED:` marker', () => {
    const hits = collectUnmarkedHits();
    if (hits.length === 0) {
      return;
    }
    const message =
      `Found ${hits.length} unmarked \`repositories[0]\` / \`getRepositories()[0]\` site(s) in production code.\n` +
      `Every occurrence must either:\n` +
      `  (a) migrate to \`resolveRepo(gitService, { preferActive: true, silent: true })\`, OR\n` +
      `  (b) carry an inline \`// ALLOWED: <reason>\` marker on the same line or the line immediately above.\n\n` +
      hits.map((h) => `  ${h.file}:${h.line}\n    ${h.snippet}`).join('\n\n');
    assert.fail(message);
  });

  it('the audit scanner itself is functional (self-check: detects a synthetic drift line)', () => {
    // Sanity check that the regex patterns actually match the drift shapes
    // we care about. This guards against a future edit accidentally
    // neutering the detector (e.g. changing `repositories[0]` to `\brepositories\[0\]\b`
    // which would miss the `]` boundary case).
    const synthetic = [
      'const repo = repositories[0];',
      'const repo = gitService.getRepositories()[0];',
      'const repo = this.repos[0];',
    ];
    for (const line of synthetic) {
      const matched = DRIFT_PATTERNS.some((p) => p.test(line));
      assert.strictEqual(matched, true, `Audit regex failed to match expected drift form: ${line}`);
    }
  });

  it('the `// ALLOWED:` marker on the same line exempts a hit', () => {
    // Simulate a 1-line file containing the drift + the marker on the
    // same line. Write to a tmp path, scan, assert zero hits.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r6-gap-c-'));
    const tmpFile = path.join(tmpDir, 'sample.ts');
    try {
      fs.writeFileSync(
        tmpFile,
        'const repo = repositories[0]; // ALLOWED: test fixture\n',
        'utf-8'
      );
      const hits = scanFile(tmpDir, tmpFile);
      assert.deepStrictEqual(hits, [], 'Inline // ALLOWED: marker must exempt same-line drift');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('the `// ALLOWED:` marker on the immediately preceding line exempts a hit', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r6-gap-c-'));
    const tmpFile = path.join(tmpDir, 'sample.ts');
    try {
      fs.writeFileSync(
        tmpFile,
        '// ALLOWED: cold-start fallback when git service is empty\nconst repo = repositories[0];\n',
        'utf-8'
      );
      const hits = scanFile(tmpDir, tmpFile);
      assert.deepStrictEqual(
        hits,
        [],
        'Preceding-line // ALLOWED: marker must exempt next-line drift'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('a drift hit with NO `// ALLOWED:` marker is flagged', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r6-gap-c-'));
    const tmpFile = path.join(tmpDir, 'sample.ts');
    try {
      fs.writeFileSync(tmpFile, 'const repo = repositories[0];\n', 'utf-8');
      const hits = scanFile(tmpDir, tmpFile);
      assert.strictEqual(hits.length, 1, `Expected 1 unmarked hit; got ${hits.length}`);
      assert.strictEqual(hits[0].line, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

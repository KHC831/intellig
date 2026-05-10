/**
 * URI-scheme allowlist audit (invariant A-static, broader form).
 *
 * Complements `uriScheme.audit.test.ts` — that test blocks the specific
 * `git-show:` scheme that caused senior-R5 L-3 (user-observed crash). This
 * test takes the inverse tack: it enumerates EVERY URI scheme used in
 * production code and asserts each one is either a VS Code built-in or was
 * registered via `registerTextDocumentContentProvider(...)` in this repo.
 *
 * Why both:
 *   - The narrow blacklist (`uriScheme.audit.test.ts`) is self-documenting:
 *     its failure message names the exact renamed scheme and the migration
 *     path. Good for THIS specific bug.
 *   - The broad allowlist (this file) is future-proof: it catches ANY
 *     future `git-blame:`, `intellig-log:`, `smart-diff:` etc. without
 *     requiring someone to remember to add a new blacklist entry.
 *
 * The overlap is cheap: both tests run in <50ms, and they reinforce each
 * other. If either one is ever weakened by accident, the other still
 * catches the drift.
 *
 * Detection:
 *   Walks every `.ts` file under `src/` (minus test/mock folders) and
 *   extracts literal URI schemes from:
 *     - `vscode.Uri.parse('<SCHEME>:...')`
 *     - `vscode.Uri.parse(\`<SCHEME>:...\`)`  (including multi-line forms)
 *     - `new vscode.Uri('<SCHEME>', ...)`
 *     - `.with({ scheme: '<SCHEME>' })`
 *
 * Escape hatch: `// ALLOWED-SCHEME: <reason>` on the same line exempts a
 * use. Useful for platform-level schemes this audit doesn't pre-know about.
 *
 * Allowlist sources:
 *   1. Built-in VS Code schemes (see `BUILTIN_SCHEMES`).
 *   2. Schemes registered via `registerTextDocumentContentProvider('<scheme>',
 *      ...)` anywhere under `src/` (computed dynamically, so new providers
 *      automatically grow the allowlist).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Platform schemes VS Code handles itself — no provider registration needed.
 * Sourced from the VS Code URI docs + built-in extension manifest.
 */
const BUILTIN_SCHEMES: ReadonlySet<string> = new Set([
  'file',
  'untitled',
  'http',
  'https',
  'vscode-resource',
  'vscode-webview-resource',
  'vscode',
  'vscode-userdata',
  'command',
  'mailto',
  'data',
  // `git:` is contributed by VS Code's built-in Git extension. The ext-host
  // smoke run disables it via `--disable-extensions`, but production users
  // have it enabled — listed as built-in here because the audit's job is to
  // catch *unknown* schemes, not to re-audit VS Code's own ecosystem.
  'git',
]);

const SCAN_ROOT = 'src';

const EXCLUDE_PATH_SEGMENTS: readonly string[] = ['src/test/', 'src/__mocks__/'];

/** The allowlist marker comment that exempts a use site. */
const ALLOWLIST_MARKER = '// ALLOWED-SCHEME:';

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

/**
 * Detection regexes — each captures the SCHEME as group 1.
 *
 * Patterns use the `s` flag so they match across newlines — an argument
 * split across lines (e.g. `Uri.parse(\n  \`scheme:...\`)`) still matches.
 *
 * Only matches constant-literal schemes (single / double quote or
 * template-literal). Dynamic schemes (`Uri.parse(variable)`) are out of
 * scope for this static audit — the runtime probe
 * (`src/test/ext-host/suite/06.uri-schemes.test.ts`) catches those.
 */
const URI_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // vscode.Uri.parse('scheme:...')   (single or double-quoted string literal)
  { name: 'Uri.parse', re: /\bUri\.parse\s*\(\s*['"]([a-zA-Z][a-zA-Z0-9+.-]*):/gs },
  // vscode.Uri.parse(`scheme:...`)   (template literal, possibly multi-line)
  { name: 'Uri.parse (template)', re: /\bUri\.parse\s*\(\s*`([a-zA-Z][a-zA-Z0-9+.-]*):/gs },
  // new vscode.Uri('scheme', ...)
  { name: 'new Uri', re: /\bnew\s+(?:vscode\.)?Uri\s*\(\s*['"]([a-zA-Z][a-zA-Z0-9+.-]*)['"]/gs },
  // .with({ scheme: 'scheme' })
  {
    name: '.with scheme',
    re: /\.with\s*\(\s*\{[^}]*\bscheme\s*:\s*['"]([a-zA-Z][a-zA-Z0-9+.-]*)['"]/gs,
  },
];

/**
 * Regex that harvests every `registerTextDocumentContentProvider('<scheme>',
 * …)` site in the source tree, so newly-registered schemes auto-join the
 * allowlist. Group 1 is the scheme.
 */
const PROVIDER_REGISTER_RE =
  /\bregisterTextDocumentContentProvider\s*\(\s*['"]([a-zA-Z][a-zA-Z0-9+.-]*)['"]/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function walk(root: string, out: string[]): void {
  if (!fs.existsSync(root)) {
    return;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') {
        continue;
      }
      walk(full, out);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
}

function isExcluded(relPath: string): boolean {
  const posix = toPosix(relPath);
  return EXCLUDE_PATH_SEGMENTS.some((seg) => posix.includes(seg));
}

function repoRoot(): string {
  return path.resolve(process.cwd());
}

function collectSourceFiles(): string[] {
  const root = repoRoot();
  const out: string[] = [];
  walk(path.join(root, SCAN_ROOT), out);
  return out.filter((abs) => {
    const rel = toPosix(path.relative(root, abs));
    return !isExcluded(rel);
  });
}

/**
 * Build the dynamic allowlist by harvesting
 * `registerTextDocumentContentProvider('<scheme>', …)` call sites anywhere
 * under `src/` (including tests, because the audit's allowlist should
 * reflect every scheme the extension is aware of — not just the
 * production sites).
 */
function buildRegisteredSchemeSet(): Set<string> {
  const registered = new Set<string>();
  const root = repoRoot();
  const all: string[] = [];
  walk(path.join(root, SCAN_ROOT), all);
  for (const abs of all) {
    const src = fs.readFileSync(abs, 'utf-8');
    PROVIDER_REGISTER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PROVIDER_REGISTER_RE.exec(src)) !== null) {
      registered.add(m[1]);
    }
  }
  return registered;
}

interface Hit {
  file: string; // repo-relative POSIX path
  line: number;
  snippet: string;
  scheme: string;
  pattern: string;
}

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

/**
 * Cumulative line-offset array for O(log n) pos → line lookups. Needed
 * because the template-literal regex uses `s` flag and can match across
 * newlines, so we can't iterate line-by-line.
 */
function lineStartOffsets(raw: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) === 10 /* \n */) {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function offsetToLine(offsets: number[], pos: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (offsets[mid] <= pos) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1;
}

function scanFile(repoRootAbs: string, absPath: string): Hit[] {
  const rel = toPosix(path.relative(repoRootAbs, absPath));
  const raw = fs.readFileSync(absPath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const starts = lineStartOffsets(raw);
  const hits: Hit[] = [];

  for (const { name, re } of URI_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const scheme = m[1];
      const lineNo = offsetToLine(starts, m.index);
      const lineText = lines[lineNo - 1] ?? '';
      // Skip matches inside pure comment lines — comment-documented
      // examples of the drift should not trigger this audit.
      if (isCommentLine(lineText)) {
        continue;
      }
      hits.push({
        file: rel,
        line: lineNo,
        snippet: lineText.trim(),
        scheme,
        pattern: name,
      });
    }
  }

  return hits;
}

function filterUnknownSchemes(hits: Hit[], allowlist: ReadonlySet<string>): Hit[] {
  return hits.filter((h) => {
    if (allowlist.has(h.scheme)) {
      return false;
    }
    if (h.snippet.includes(ALLOWLIST_MARKER)) {
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('URI-scheme allowlist audit (broader invariant A-static)', () => {
  it("every `vscode.Uri.parse('<scheme>:...')` site uses a built-in or registered scheme", () => {
    const root = repoRoot();
    const files = collectSourceFiles();
    const registered = buildRegisteredSchemeSet();
    const allowlist = new Set<string>([...BUILTIN_SCHEMES, ...registered]);

    const hits: Hit[] = [];
    for (const abs of files) {
      hits.push(...scanFile(root, abs));
    }
    const unknown = filterUnknownSchemes(hits, allowlist);
    if (unknown.length === 0) {
      return;
    }

    const byScheme = new Map<string, Hit[]>();
    for (const h of unknown) {
      const arr = byScheme.get(h.scheme) ?? [];
      arr.push(h);
      byScheme.set(h.scheme, arr);
    }
    const lines: string[] = [];
    lines.push(
      `Found ${unknown.length} URI site(s) with unknown scheme(s). Every URI's scheme must be either:`
    );
    lines.push(`  (a) a built-in VS Code scheme: ${[...BUILTIN_SCHEMES].join(', ')}`);
    lines.push(
      `  (b) a scheme registered via \`registerTextDocumentContentProvider\` in this repo (currently: ${
        [...registered].sort().join(', ') || '(none)'
      })`
    );
    lines.push(`  (c) explicitly exempt via \`// ALLOWED-SCHEME: <reason>\` on the same line.`);
    lines.push('');
    for (const [scheme, group] of byScheme) {
      lines.push(`  Unknown scheme \`${scheme}:\` — ${group.length} site(s):`);
      for (const h of group) {
        lines.push(`    ${h.file}:${h.line}  [${h.pattern}]`);
        lines.push(`      ${h.snippet}`);
      }
      lines.push('');
    }
    assert.fail(lines.join('\n'));
  });

  it('builtin allowlist sanity: `file`, `http`, `intellig-git` are accepted', () => {
    const registered = buildRegisteredSchemeSet();
    assert.ok(BUILTIN_SCHEMES.has('file'), '`file` must be in the built-in allowlist');
    assert.ok(BUILTIN_SCHEMES.has('http'), '`http` must be in the built-in allowlist');
    assert.ok(
      registered.has('intellig-git'),
      '`intellig-git` must be discovered from registerTextDocumentContentProvider'
    );
  });

  it('detector matches the four syntactic forms', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uri-scheme-allowlist-'));
    const tmpFile = path.join(tmpDir, 'sample.ts');
    try {
      fs.writeFileSync(
        tmpFile,
        [
          "const a = vscode.Uri.parse('zzz-unknown-a:foo');",
          'const b = vscode.Uri.parse(`zzz-unknown-b:foo`);',
          "const c = new vscode.Uri('zzz-unknown-c', '', 'foo', '', '');",
          "const d = someUri.with({ scheme: 'zzz-unknown-d', path: '/x' });",
        ].join('\n'),
        'utf-8'
      );
      const hits = scanFile(tmpDir, tmpFile);
      const schemes = new Set(hits.map((h) => h.scheme));
      for (const expected of ['zzz-unknown-a', 'zzz-unknown-b', 'zzz-unknown-c', 'zzz-unknown-d']) {
        assert.ok(
          schemes.has(expected),
          `Detector must match scheme \`${expected}\` in synthetic fixture; got: [${[...schemes].join(', ')}]`
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detector matches multi-line `Uri.parse(\\n  `scheme:...`)` shape', () => {
    // Regression for the single-line regex trap: the previous iteration
    // missed `vscode.Uri.parse(\n  \`git-show:...\`)` because it matched
    // line-by-line. The `s` flag + whole-file scan fixes it.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uri-scheme-allowlist-'));
    const tmpFile = path.join(tmpDir, 'sample.ts');
    try {
      fs.writeFileSync(
        tmpFile,
        ['const uri = vscode.Uri.parse(', '  `zzz-multiline-scheme:path?query=value`', ');'].join(
          '\n'
        ),
        'utf-8'
      );
      const hits = scanFile(tmpDir, tmpFile);
      assert.strictEqual(hits.length, 1, 'Multi-line Uri.parse must be detected');
      assert.strictEqual(hits[0].scheme, 'zzz-multiline-scheme');
      // The reported line anchors on the `Uri.parse(` token — the start of
      // the offending call expression. The failure message still surfaces
      // the full file:line, which is unambiguous either way.
      assert.strictEqual(hits[0].line, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('same-line `// ALLOWED-SCHEME:` marker exempts a use', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uri-scheme-allowlist-'));
    const tmpFile = path.join(tmpDir, 'sample.ts');
    try {
      fs.writeFileSync(
        tmpFile,
        "const a = vscode.Uri.parse('zzz-genuinely-fine:foo'); // ALLOWED-SCHEME: platform adapter test\n",
        'utf-8'
      );
      const hits = scanFile(tmpDir, tmpFile);
      const unknown = filterUnknownSchemes(hits, new Set(['file']));
      assert.deepStrictEqual(
        unknown,
        [],
        'Same-line // ALLOWED-SCHEME: marker must exempt the hit'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('an unknown scheme WITHOUT marker is flagged', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uri-scheme-allowlist-'));
    const tmpFile = path.join(tmpDir, 'sample.ts');
    try {
      fs.writeFileSync(
        tmpFile,
        "const a = vscode.Uri.parse('git-show:path/to/file?ref=abc');\n",
        'utf-8'
      );
      const hits = scanFile(tmpDir, tmpFile);
      const unknown = filterUnknownSchemes(hits, new Set(['file', 'intellig-git']));
      assert.strictEqual(unknown.length, 1, 'Unknown scheme must be flagged');
      assert.strictEqual(unknown[0].scheme, 'git-show');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('provider-registration harvester picks up `intellig-git`', () => {
    const registered = buildRegisteredSchemeSet();
    assert.ok(
      registered.has('intellig-git'),
      `Harvester failed to discover \`intellig-git\` scheme; found: [${[...registered].join(', ')}]`
    );
  });
});

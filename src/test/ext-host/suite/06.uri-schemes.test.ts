/**
 * Smoke test 6 — URI-scheme coherence runtime probe (invariant A-runtime).
 *
 * Background — today's crash (L-3 senior-R5):
 *   `Compare with Local` / `Show Repo at Revision` / `Branch Comparison View`
 *   constructed URIs with the `git-show:` scheme, but only `intellig-git:` has
 *   a content provider registered (`src/extension.ts:4209`). At runtime the
 *   host threw "Unable to resolve resource git-show:…" and the diff editor
 *   crashed. Unit tests could NOT catch this — the mock
 *   `workspace.openTextDocument` returns a fake document for any URI without
 *   consulting the registered-scheme set.
 *
 * What this test does:
 *   Pairs with the static audit at
 *   `src/test/unit/audit/uriScheme.audit.test.ts`. Where the static audit
 *   proves no production code references an unregistered scheme, the runtime
 *   probe proves the registered schemes actually resolve inside a live
 *   extension host:
 *
 *     1. Positive path — for each scheme registered via
 *        `registerTextDocumentContentProvider(<scheme>, …)` (discovered
 *        dynamically from the source tree, so newly-registered schemes join
 *        automatically), call `vscode.workspace.openTextDocument` with a
 *        representative URI and assert VS Code does NOT reply with the
 *        "Unable to resolve" / "cannot open" scheme-not-registered shape.
 *
 *     2. Negative path — synthesize a URI with a KNOWN-UNREGISTERED scheme
 *        (`zzz-deliberately-unregistered-scheme`) and assert the exact same
 *        `openTextDocument` call DOES throw the "Unable to resolve" error.
 *        This proves the probe is actually load-bearing: if VS Code ever
 *        changed its error shape, the probe would warn us instead of
 *        silently passing for every scheme.
 *
 * Retroactive validation:
 *   Running this suite against the pre-fix tip (before the urischeme coder
 *   lands their fix) is not applicable — this suite only probes REGISTERED
 *   schemes for the positive path. The static audit (invariant A-static)
 *   catches the `git-show:` use sites directly. This runtime probe's job is
 *   to catch the OTHER half: a case where someone registers a provider but
 *   accidentally breaks its subscription (e.g. duplicate registration, or
 *   the provider's `dispose()` firing on activation). Static audit passes,
 *   runtime probe fails.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const EXT_ID = 'intellig-vscode.intellig';

/**
 * Regex that harvests every `registerTextDocumentContentProvider('<scheme>',
 * …)` site in the `src/` tree (excluding `src/test/` and `src/__mocks__/`).
 * Group 1 is the scheme. Mirrors the A-static audit's harvester.
 */
const PROVIDER_REGISTER_RE =
  /\bregisterTextDocumentContentProvider\s*\(\s*['"]([a-zA-Z][a-zA-Z0-9+.-]*)['"]/g;

function repoRoot(): string {
  // Test runs from the compiled bundle at `out/test/ext-host/suite/…`, so
  // the repo root is 4 levels up.
  return path.resolve(__dirname, '../../../..');
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
      if (entry.name === 'test' || entry.name === '__mocks__') {
        continue;
      }
      walk(full, out);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
}

function discoverRegisteredSchemes(): string[] {
  const root = repoRoot();
  const files: string[] = [];
  walk(path.join(root, 'src'), files);
  const schemes = new Set<string>();
  for (const abs of files) {
    const raw = fs.readFileSync(abs, 'utf-8');
    PROVIDER_REGISTER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PROVIDER_REGISTER_RE.exec(raw)) !== null) {
      schemes.add(m[1]);
    }
  }
  return [...schemes].sort();
}

/**
 * The telltale error shape VS Code raises when a URI's scheme has no
 * registered content provider, DIFFERENTIATED from the shape raised when a
 * provider exists but throws.
 *
 * Observed VS Code error messages:
 *   - Unregistered scheme:
 *       "cannot open <URI>. Detail: Unable to resolve resource <URI>"
 *     …where the Detail clause explicitly says "Unable to resolve resource"
 *     (the scheme has no provider).
 *   - Provider exists and threw:
 *       "cannot open <URI>. Detail: <whatever the provider threw>"
 *     e.g. "Detail: Extension services not initialized" — we want this to
 *     NOT count as "unresolved" because it proves the provider WAS invoked.
 *
 * The matcher therefore requires BOTH "cannot open" AND a scheme-absence
 * phrase like "Unable to resolve resource" or "no provider". This is
 * deliberately narrower than matching "cannot open" on its own — a provider
 * that throws "Unable to resolve foo" would otherwise trigger a false
 * positive.
 */
function isUnresolvedSchemeError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  // Require both the VS Code wrapper ("cannot open") AND evidence that the
  // scheme itself lacks a provider. This keeps provider-thrown errors
  // (which have arbitrary `Detail:` suffixes) from tripping the matcher.
  const hasVscodeWrapper = lower.includes('cannot open');
  const hasUnresolvedDetail =
    lower.includes('unable to resolve resource') ||
    lower.includes('no provider registered') ||
    lower.includes('no provider for');
  return hasVscodeWrapper && hasUnresolvedDetail;
}

describe('ext-host smoke — 6. URI-scheme coherence runtime probe', function () {
  this.timeout(30_000);

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `Extension ${EXT_ID} not installed in host`);
    await ext.activate();
  });

  it('discovers at least one registered content-provider scheme from source', () => {
    const schemes = discoverRegisteredSchemes();
    assert.ok(
      schemes.length > 0,
      'Harvester found no registerTextDocumentContentProvider sites in src/ — regression'
    );
    assert.ok(
      schemes.includes('intellig-git'),
      `Expected intellig-git in discovered schemes, got: [${schemes.join(', ')}]`
    );
  });

  it('every registered scheme resolves via workspace.openTextDocument (positive path)', async () => {
    const schemes = discoverRegisteredSchemes();
    const failures: string[] = [];
    for (const scheme of schemes) {
      // Build a representative URI. The query string `HEAD` is meaningful for
      // `intellig-git:` (git ref) and harmless for any future scheme.
      const uri = vscode.Uri.parse(`${scheme}:README.md?HEAD`);
      try {
        // `openTextDocument` forces VS Code to look up the provider. If no
        // provider exists for the scheme, VS Code throws — this is the bug
        // shape we're guarding against. If the provider exists but the
        // underlying content can't be resolved (e.g. file doesn't exist at
        // ref), the provider returns empty/throws a DIFFERENT error — also
        // acceptable here because it proves the scheme is wired up.
        await vscode.workspace.openTextDocument(uri);
      } catch (err) {
        if (isUnresolvedSchemeError(err)) {
          failures.push(
            `  ${scheme}: resolved URI "${uri.toString()}" with scheme-unregistered error: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
        // Other errors (e.g. "No Git repository found") are fine — they
        // prove the scheme is actually mounted.
      }
    }
    assert.deepStrictEqual(
      failures,
      [],
      `Registered schemes failed to resolve (provider registration is broken):\n${failures.join('\n')}`
    );
  });

  it('a deliberately-unregistered scheme DOES fail with the unresolved-scheme error (probe sanity)', async () => {
    // If this ever STOPS failing, the positive-path assertion above is
    // useless — every scheme would pass. Prove the probe mechanism is
    // load-bearing by asserting an unregistered scheme triggers the exact
    // error shape the positive path is guarding against.
    const uri = vscode.Uri.parse('zzz-deliberately-unregistered-scheme:probe?q=1');
    let caught: unknown;
    try {
      await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'openTextDocument on unregistered scheme must throw');
    assert.ok(
      isUnresolvedSchemeError(caught),
      `openTextDocument on unregistered scheme threw unexpected error: ${
        caught instanceof Error ? caught.message : String(caught)
      } — update isUnresolvedSchemeError() matcher if VS Code changed its error shape.`
    );
  });

  it('intellig-git:README.md?HEAD opens without the scheme-unregistered error class (regression for L-3)', async () => {
    // Explicit regression for the user-observed crash. This is redundant
    // with the generic "every registered scheme" positive path above, but
    // it names the scheme and the error class in plain English so a future
    // engineer reading the suite sees exactly which bug was caught.
    const uri = vscode.Uri.parse('intellig-git:README.md?HEAD');
    let threwUnresolved = false;
    try {
      await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      if (isUnresolvedSchemeError(err)) {
        threwUnresolved = true;
      }
      // Non-unresolved errors are fine — e.g. provider returned empty, or
      // repo is not present. We only care that the scheme itself is
      // registered.
    }
    assert.strictEqual(
      threwUnresolved,
      false,
      '`intellig-git:` must be resolvable — registerTextDocumentContentProvider broken or not called'
    );
  });
});

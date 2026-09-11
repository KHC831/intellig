/**
 * Companion spec for scripts/check-doc-citations.mjs.
 *
 * Reaches the guard two ways. Spawning it as a child process — via the
 * runGuard() helper, or spawnSync directly — either passes no args, running
 * against the real docs tree and its real allowlist, or passes
 * `--fixture [docsDir] [repoRoot] [minCitations] [exemptionsPath]`, against
 * either a throwaway docs/src fixture built by makeFixture() or a docsDir
 * chosen not to exist (the fail-closed vacuity arm). minCitations defaults
 * to 0 (the anti-vacuity floor is off) and exemptionsPath to a nonexistent
 * path (empty allowlist) unless a spec passes them explicitly. loadScript()
 * imports the module in-process, letting a spec call an export like
 * resolveInvocation directly with nothing spawned.
 *
 * The guarantees this file proves are exactly the `it(` titles below — this
 * comment does not restate them, so it cannot drift out of sync with them.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-doc-citations.mjs');
const TMP_ROOT = SCRATCH_ROOT;

/** Only the two exports specs actually read off `loadScript()`'s result —
 * declaring an unexercised member here would type-check against nothing,
 * since the cast at `loadScript()` never runs the real module through it. */
interface CheckDocCitationsModule {
  DEFAULT_MIN_CITATIONS: number;
  resolveInvocation: (argv: string[]) => {
    fixtureMode: boolean;
    docsDir: string;
    repoRoot: string;
    minCitations: number;
    exemptionsPath: string;
  };
}

async function loadScript(): Promise<CheckDocCitationsModule> {
  const mod: unknown = await import(SCRIPT);
  return mod as CheckDocCitationsModule;
}

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A docs/ tree plus the src/ tree it cites, both under one throwaway root. */
function makeFixture(docs: Record<string, string>, existingFiles: string[] = []): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(TMP_ROOT, 'doc-citations-'));
  const docsDir = path.join(root, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  for (const [name, content] of Object.entries(docs)) {
    const full = path.join(docsDir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  for (const rel of existingFiles) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '// fixture\n', 'utf8');
  }
  return root;
}

function writeExemptions(root: string, entries: unknown[]): string {
  const file = path.join(root, 'exemptions.json');
  fs.writeFileSync(file, JSON.stringify(entries), 'utf8');
  return file;
}

describe('check-doc-citations guard', () => {
  it('passes against the real docs tree and its allowlist', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on the real docs tree; stderr:\n${stderr}`);
  });

  it('has teeth on a citation to a src/*.ts path that does not exist', () => {
    const root = makeFixture({
      'ADR-fixture.md': 'See `src/utils/gone.ts` for the split.\n',
    });
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(status, 1, `dead citation must fail; stderr:\n${stderr}`);
    assert.ok(/src\/utils\/gone\.ts/.test(stderr));
  });

  it('accepts a citation to a src/*.ts path that exists', () => {
    const root = makeFixture({ 'ADR-fixture.md': 'See `src/utils/live.ts` for the split.\n' }, [
      'src/utils/live.ts',
    ]);
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(status, 0, `live citation must pass; stderr:\n${stderr}`);
  });

  it('also catches dead test/*.ts and scripts/*.mjs citations (widened scope)', () => {
    const root = makeFixture({
      'ADR-fixture.md': 'See `test/e2e/support/gone.ts` and `scripts/gone.mjs` for the split.\n',
    });
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(status, 1, `dead test/scripts citations must fail; stderr:\n${stderr}`);
    assert.ok(/test\/e2e\/support\/gone\.ts/.test(stderr));
    assert.ok(/scripts\/gone\.mjs/.test(stderr));
  });

  it("has teeth on a citation whose line number is beyond the cited file's current length", () => {
    const root = makeFixture({ 'ADR-fixture.md': 'See `src/utils/live.ts:50` for the split.\n' }, [
      'src/utils/live.ts',
    ]);
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(status, 1, `an out-of-range line citation must fail; stderr:\n${stderr}`);
    assert.ok(/out-of-range/.test(stderr), stderr);
    assert.ok(/src\/utils\/live\.ts:50/.test(stderr), stderr);
  });

  it("has teeth on a range citation whose end line is beyond the cited file's current length", () => {
    const root = makeFixture(
      { 'ADR-fixture.md': 'See `src/utils/live.ts:1-50` for the split.\n' },
      ['src/utils/live.ts']
    );
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(status, 1, `an out-of-range end line must fail; stderr:\n${stderr}`);
    assert.ok(/src\/utils\/live\.ts:1-50/.test(stderr), stderr);
  });

  it("accepts a line citation that lands inside the cited file's current length", () => {
    const root = makeFixture({ 'ADR-fixture.md': 'See `src/utils/live.ts:1` for the split.\n' }, [
      'src/utils/live.ts',
    ]);
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(status, 0, `an in-range line citation must pass; stderr:\n${stderr}`);
  });

  it("accepts a line citation to the trailing-newline slack line past a file's real content", () => {
    const root = makeFixture({ 'ADR-fixture.md': 'See `src/utils/live.ts:3` for the split.\n' }, [
      'src/utils/live.ts',
    ]);
    fs.writeFileSync(path.join(root, 'src/utils/live.ts'), 'line1\nline2\n', 'utf8');
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(
      status,
      0,
      `line 3 is split('\\n').length of a trailing-newline 2-line file, deliberately accepted; stderr:\n${stderr}`
    );
  });

  it('has teeth on a line citation one line past the trailing-newline slack line', () => {
    const root = makeFixture({ 'ADR-fixture.md': 'See `src/utils/live.ts:4` for the split.\n' }, [
      'src/utils/live.ts',
    ]);
    fs.writeFileSync(path.join(root, 'src/utils/live.ts'), 'line1\nline2\n', 'utf8');
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(
      status,
      1,
      `line 4 is past even the trailing-newline slack; stderr:\n${stderr}`
    );
  });

  it('has teeth on a citation whose start line is not a valid line number', () => {
    const root = makeFixture({ 'ADR-fixture.md': 'See `src/utils/live.ts:0` for the split.\n' }, [
      'src/utils/live.ts',
    ]);
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(status, 1, `a zero start line must fail; stderr:\n${stderr}`);
    assert.ok(/not a valid line number/.test(stderr), stderr);
    assert.ok(/src\/utils\/live\.ts:0/.test(stderr), stderr);
  });

  it('has teeth on a range citation whose end line is before its start line', () => {
    const root = makeFixture({ 'ADR-fixture.md': 'See `src/utils/live.ts:5-2` for the split.\n' }, [
      'src/utils/live.ts',
    ]);
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(status, 1, `an inverted range must fail; stderr:\n${stderr}`);
    assert.ok(/before its start/.test(stderr), stderr);
    assert.ok(/src\/utils\/live\.ts:5-2/.test(stderr), stderr);
  });

  it('accepts a live test/*.ts and scripts/*.sh citation', () => {
    const root = makeFixture(
      { 'ADR-fixture.md': 'See `test/e2e/support/live.ts` and `scripts/live.sh`.\n' },
      ['test/e2e/support/live.ts', 'scripts/live.sh']
    );
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(status, 0, `live citations must pass; stderr:\n${stderr}`);
  });

  it('has teeth on a rooted *.test.ts citation that carries a line-number suffix', () => {
    // A spec file's line numbers move with every edit to it, and nothing
    // else checks that a doc's line-number claim about a test still points
    // at the right `it(` — the test's title, quoted in prose, is the citation
    // that cannot drift out of sync with itself.
    // Cites an IN-BOUNDS line (fixture files are 2 lines: `// fixture\n`),
    // so a red here can only come from the new arm, never the existing
    // out-of-range check (the dead-citation check is ruled out below by
    // asserting the arm's own message text, not just a matching path).
    const root = makeFixture(
      { 'ADR-fixture.md': 'See `test/unit/thing.test.ts:1` for the case.\n' },
      ['test/unit/thing.test.ts']
    );
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(
      status,
      1,
      `a *.test.ts citation with a line number must fail; stderr:\n${stderr}`
    );
    assert.ok(/test\/unit\/thing\.test\.ts/.test(stderr), stderr);
    assert.ok(/line-number suffix/.test(stderr), stderr);
  });

  it('has teeth on an UNROOTED *.test.ts citation that carries a line-number suffix', () => {
    // CITATION_RE requires a src|test|scripts root, so an unrooted citation
    // like this one is not a "citation" CITATION_RE recognizes at all — it
    // contributes 0 to the citation count and is invisible to the dead/
    // out-of-range checks. This is the shape ADR-016 actually uses once a
    // test file has been named once (see check-doc-citations.mjs section 4),
    // so the rejection has to catch it independently of CITATION_RE.
    const root = makeFixture({
      'ADR-fixture.md': 'See `thing.test.ts:1` for the case.\n',
    });
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(
      status,
      1,
      `an unrooted *.test.ts citation with a line number must fail; stderr:\n${stderr}`
    );
    assert.ok(/thing\.test\.ts/.test(stderr), stderr);
    assert.ok(/line-number suffix/.test(stderr), stderr);
  });

  it('has teeth on a MID-PATH (partial, unrooted) *.test.ts citation that carries a line-number suffix', () => {
    // "graph/laneLinking.test.ts" — a directory prefix short of a
    // src|test|scripts root — is the established partial-path convention
    // this docs tree uses for source files (ARCHITECTURE.md, coverage.md,
    // ADR-009, ADR-012), just never yet applied to a test file. Neither
    // CITATION_RE (needs the full root) nor a lookbehind that only refuses
    // a bare filename's own characters catches this: it has a path prefix,
    // just not a rooted one.
    const root = makeFixture({
      'ADR-fixture.md': 'See `graph/thing.test.ts:1` for the case.\n',
    });
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(
      status,
      1,
      `a mid-path *.test.ts citation with a line number must fail; stderr:\n${stderr}`
    );
    assert.ok(/graph\/thing\.test\.ts/.test(stderr), stderr);
    assert.ok(/line-number suffix/.test(stderr), stderr);
  });

  it('accepts a *.test.ts citation with no line-number suffix', () => {
    const root = makeFixture(
      { 'ADR-fixture.md': 'See `test/unit/thing.test.ts` for the case.\n' },
      ['test/unit/thing.test.ts']
    );
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(
      status,
      0,
      `a *.test.ts citation without a line number must pass; stderr:\n${stderr}`
    );
  });

  it('does not read a directory-prefixed path as a citation of its suffix', () => {
    const root = makeFixture({
      'ADR-fixture.md': 'See `vendor/src/thing.ts` for the vendored copy.\n',
    });
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(
      status,
      0,
      `vendor/src/thing.ts must not be read as a dead src/thing.ts citation; stderr:\n${stderr}`
    );
  });

  it('does not read a longer real extension as a citation of the shorter one', () => {
    const root = makeFixture({
      'ADR-fixture.md': 'See `src/thing.tsx` for the component.\n',
    });
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(
      status,
      0,
      `src/thing.tsx must not be read as a dead src/thing.ts citation; stderr:\n${stderr}`
    );
  });

  it('enforces a dead citation shown inside an HTML comment exactly like prose', () => {
    const root = makeFixture({
      'ADR-fixture.md': 'Prose. <!-- see src/utils/gone.ts for history --> More prose.\n',
    });
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(
      status,
      1,
      `a commented-out dead citation must still fail; stderr:\n${stderr}`
    );
    assert.ok(/src\/utils\/gone\.ts/.test(stderr), stderr);
  });

  it('enforces a dead citation written inside a fenced code block', () => {
    const root = makeFixture({
      'ADR-fixture.md': 'Example:\n```json\n{ "path": "src/utils/gone.ts" }\n```\n',
    });
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(status, 1, `a fenced dead citation must still fail; stderr:\n${stderr}`);
    assert.ok(/src\/utils\/gone\.ts/.test(stderr), stderr);
  });

  it('an allowlist entry exempts a dead citation whether it sits in prose, a comment, or a fence', () => {
    const root = makeFixture({
      'ADR-fixture.md':
        'See `src/utils/gone.ts`, also shown in `<!-- src/utils/gone.ts -->` ' +
        'and in\n```json\n{ "path": "src/utils/gone.ts" }\n```\n',
    });
    // All three occurrences are the same (doc, citedPath) pair, so one entry
    // exempts all of them — the allowlist matches paths, not markup positions.
    const exemptionsPath = writeExemptions(root, [
      { doc: 'docs/ADR-fixture.md', citedPath: 'src/utils/gone.ts', reason: 'retired' },
    ]);
    const { status, stdout, stderr } = runGuard([
      '--fixture',
      path.join(root, 'docs'),
      root,
      '0',
      exemptionsPath,
    ]);
    assert.strictEqual(status, 0, `all three occurrences must be exempted; stderr:\n${stderr}`);
    assert.ok(/3 exempt/.test(stdout), stdout);
  });

  describe('the exemptions allowlist', () => {
    it('exempts a dead citation with an exact (doc, citedPath) allowlist entry', () => {
      const root = makeFixture({
        'ADR-fixture.md': '`src/services/Old.ts` moved on.\n',
      });
      const exemptionsPath = writeExemptions(root, [
        { doc: 'docs/ADR-fixture.md', citedPath: 'src/services/Old.ts', reason: 'retired' },
      ]);
      const { status, stdout, stderr } = runGuard([
        '--fixture',
        path.join(root, 'docs'),
        root,
        '0',
        exemptionsPath,
      ]);
      assert.strictEqual(status, 0, `an exempted dead citation must pass; stderr:\n${stderr}`);
      assert.ok(/1 exempt/.test(stdout), stdout);
    });

    it('does NOT exempt a citation whose path is only a prefix/suffix of the allowlisted path', () => {
      const root = makeFixture({
        'ADR-fixture.md': 'See `test/unit/dead.ts` and also `src/test/unit/dead.ts` for details.\n',
      });
      const exemptionsPath = writeExemptions(root, [
        { doc: 'docs/ADR-fixture.md', citedPath: 'test/unit/dead.ts', reason: 'unrelated file' },
      ]);
      const { status, stderr } = runGuard([
        '--fixture',
        path.join(root, 'docs'),
        root,
        '0',
        exemptionsPath,
      ]);
      assert.strictEqual(
        status,
        1,
        `the suffix-colliding citation must not be exempted too; stderr:\n${stderr}`
      );
      assert.ok(/1 dead citation/.test(stderr), stderr);
      assert.ok(/\ssrc\/test\/unit\/dead\.ts$/m.test(stderr), stderr);
      assert.ok(
        !/\stest\/unit\/dead\.ts$/m.test(stderr),
        `the allowlisted citation must not also be reported dead:\n${stderr}`
      );
    });

    it('does NOT exempt a citation in a different doc than the allowlist entry names', () => {
      const root = makeFixture({
        'a.md': '`src/services/Old.ts` moved on.\n',
        'b.md': '`src/services/Old.ts` moved on.\n',
      });
      const exemptionsPath = writeExemptions(root, [
        { doc: 'docs/a.md', citedPath: 'src/services/Old.ts', reason: 'retired' },
      ]);
      const { status, stderr } = runGuard([
        '--fixture',
        path.join(root, 'docs'),
        root,
        '0',
        exemptionsPath,
      ]);
      assert.strictEqual(status, 1, `b.md's citation must still fail; stderr:\n${stderr}`);
      assert.ok(/b\.md/.test(stderr), stderr);
    });

    it('fails the run when the allowlist has a stale entry whose citedPath now exists on disk', () => {
      const root = makeFixture({ 'ADR-fixture.md': 'See `src/services/Old.ts`.\n' }, [
        'src/services/Old.ts',
      ]);
      const exemptionsPath = writeExemptions(root, [
        { doc: 'docs/ADR-fixture.md', citedPath: 'src/services/Old.ts', reason: 'retired' },
      ]);
      const { status, stderr } = runGuard([
        '--fixture',
        path.join(root, 'docs'),
        root,
        '0',
        exemptionsPath,
      ]);
      assert.strictEqual(status, 1, 'a resurrected path must fail as a stale entry');
      assert.ok(/now exists on disk/.test(stderr), stderr);
    });

    it('fails the run when the allowlist has a stale entry the doc no longer cites', () => {
      const root = makeFixture({
        'ADR-fixture.md': 'This paragraph no longer mentions the old path at all.\n',
      });
      const exemptionsPath = writeExemptions(root, [
        { doc: 'docs/ADR-fixture.md', citedPath: 'src/services/Old.ts', reason: 'retired' },
      ]);
      const { status, stderr } = runGuard([
        '--fixture',
        path.join(root, 'docs'),
        root,
        '0',
        exemptionsPath,
      ]);
      assert.strictEqual(status, 1, 'an entry the doc no longer cites must fail');
      assert.ok(/no longer cites/.test(stderr), stderr);
    });

    it('fails the run when the allowlist names a doc that does not exist', () => {
      const root = makeFixture({ 'ADR-fixture.md': 'Nothing relevant here.\n' });
      const exemptionsPath = writeExemptions(root, [
        { doc: 'docs/does-not-exist.md', citedPath: 'src/services/Old.ts', reason: 'retired' },
      ]);
      const { status, stderr } = runGuard([
        '--fixture',
        path.join(root, 'docs'),
        root,
        '0',
        exemptionsPath,
      ]);
      assert.strictEqual(status, 1, 'a missing doc must fail');
      assert.ok(/doc does not exist/.test(stderr), stderr);
    });

    it('fails the run when the allowlist file is not valid JSON', () => {
      const root = makeFixture({ 'ADR-fixture.md': 'Nothing relevant here.\n' });
      const exemptionsPath = path.join(root, 'exemptions.json');
      fs.writeFileSync(exemptionsPath, '{ not json', 'utf8');
      const { status, stderr } = runGuard([
        '--fixture',
        path.join(root, 'docs'),
        root,
        '0',
        exemptionsPath,
      ]);
      assert.strictEqual(status, 1, 'invalid JSON must fail');
      assert.ok(/not valid JSON/.test(stderr), stderr);
    });

    it('fails the run when an allowlist entry is missing a required field', () => {
      const root = makeFixture({ 'ADR-fixture.md': 'Nothing relevant here.\n' });
      const exemptionsPath = writeExemptions(root, [
        { doc: 'docs/ADR-fixture.md', citedPath: 'src/services/Old.ts' },
      ]);
      const { status, stderr } = runGuard([
        '--fixture',
        path.join(root, 'docs'),
        root,
        '0',
        exemptionsPath,
      ]);
      assert.strictEqual(status, 1, 'a missing "reason" field must fail');
      assert.ok(/reason/.test(stderr), stderr);
    });

    it('fails the run when the allowlist has a duplicate (doc, citedPath) entry', () => {
      const root = makeFixture({ 'ADR-fixture.md': '`src/services/Old.ts`\n' });
      const entry = { doc: 'docs/ADR-fixture.md', citedPath: 'src/services/Old.ts', reason: 'a' };
      const exemptionsPath = writeExemptions(root, [entry, { ...entry, reason: 'b' }]);
      const { status, stderr } = runGuard([
        '--fixture',
        path.join(root, 'docs'),
        root,
        '0',
        exemptionsPath,
      ]);
      assert.strictEqual(status, 1, 'a duplicate entry must fail');
      assert.ok(/duplicate/.test(stderr), stderr);
    });
  });

  it('is FAIL-CLOSED: scanning zero docs fails instead of reporting OK', () => {
    const { status, stderr } = runGuard(['--fixture', path.join(TMP_ROOT, 'does-not-exist')]);
    assert.strictEqual(status, 1, 'a vacuous scan must fail');
    assert.ok(/vacuous/.test(stderr), `expected the vacuity arm; got:\n${stderr}`);
  });

  it('is FAIL-CLOSED: fewer citations than the floor fails even though docs were found', () => {
    const root = makeFixture({ 'ADR-fixture.md': 'No citations here at all.\n' });
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root, '1']);
    assert.strictEqual(status, 1, 'a below-floor citation count must fail');
    assert.ok(/only 0 citation/.test(stderr), `expected the floor arm; got:\n${stderr}`);
  });

  it('the floor is OFF by default in fixture mode, so ordinary small fixtures still pass', () => {
    const root = makeFixture({ 'ADR-fixture.md': 'No citations here at all.\n' });
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(status, 0, `no floor means zero citations is fine; stderr:\n${stderr}`);
  });
});

describe('check-doc-citations resolveInvocation', () => {
  it('is real mode with a non-zero floor when invoked with no arguments', async () => {
    const { resolveInvocation, DEFAULT_MIN_CITATIONS } = await loadScript();
    const invocation = resolveInvocation(['node', 'check-doc-citations.mjs']);
    assert.strictEqual(invocation.fixtureMode, false);
    assert.strictEqual(invocation.minCitations, DEFAULT_MIN_CITATIONS);
    assert.ok(DEFAULT_MIN_CITATIONS > 0, 'the real-mode floor must not be zero');
  });

  it('stays in real mode, floor intact, when a positional argument is passed without --fixture', async () => {
    // The natural explicit invocation `node check-doc-citations.mjs docs .`
    // must not be read as "an argument was passed, disable the floor".
    const { resolveInvocation, DEFAULT_MIN_CITATIONS } = await loadScript();
    const invocation = resolveInvocation(['node', 'check-doc-citations.mjs', 'docs', '.']);
    assert.strictEqual(invocation.fixtureMode, false);
    assert.strictEqual(invocation.minCitations, DEFAULT_MIN_CITATIONS);
  });

  it('only enters fixture mode, with the floor off by default, when argv[2] is exactly --fixture', async () => {
    const { resolveInvocation } = await loadScript();
    const invocation = resolveInvocation([
      'node',
      'check-doc-citations.mjs',
      '--fixture',
      'd',
      'r',
    ]);
    assert.strictEqual(invocation.fixtureMode, true);
    assert.strictEqual(invocation.minCitations, 0);
  });

  it('reports at least the configured floor of citations on the real docs tree', () => {
    const { status, stdout } = runGuard([]);
    assert.strictEqual(status, 0);
    const match = /(\d+) citation\(s\)/.exec(stdout);
    assert.ok(match, `expected a citation count in stdout; got:\n${stdout}`);
    assert.ok(Number(match[1]) >= 100, `expected at least 100 citations; got ${match[1]}`);
  });
});

describe('check-doc-citations runs when spawned from a path containing a space', () => {
  // import.meta.url percent-encodes; process.argv[1] does not. A naive
  // string comparison between the two makes main() never run on any
  // checkout path containing a space, #, %, or non-ASCII character — the
  // script exits 0 having printed nothing.
  it('invokes main() and reports the dead citation, rather than silently exiting 0', () => {
    const scriptRoot = fs.mkdtempSync(path.join(TMP_ROOT, 'space-'));
    const scriptsDir = path.join(scriptRoot, 'r22 spaced', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const spacedScript = path.join(scriptsDir, path.basename(SCRIPT));
    fs.copyFileSync(SCRIPT, spacedScript);
    const root = makeFixture({ 'ADR-fixture.md': 'See `src/utils/gone.ts` for the split.\n' });

    const result = spawnSync('node', [spacedScript, '--fixture', path.join(root, 'docs'), root], {
      encoding: 'utf8',
    });

    assert.notStrictEqual(result.status, 0, 'a spaced script path must not silently no-op');
    assert.ok(
      /src\/utils\/gone\.ts/.test(result.stderr),
      `expected main() to run and report the dead citation; stderr:\n${result.stderr}`
    );
  });

  it('invokes main() when spawned through a symlinked scripts directory', () => {
    // import.meta.url resolves through a symlink to the file's real path;
    // process.argv[1] does not, unless it is realpath'd too — this is the
    // other half of the isMain fix, reproduced with a real symlink rather
    // than a space in the name.
    const scriptRoot = fs.mkdtempSync(path.join(TMP_ROOT, 'symlink-'));
    const realScriptsDir = path.join(scriptRoot, 'real', 'scripts');
    fs.mkdirSync(realScriptsDir, { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(realScriptsDir, path.basename(SCRIPT)));
    const linkedScriptsDir = path.join(scriptRoot, 'linked', 'scripts');
    fs.mkdirSync(path.dirname(linkedScriptsDir), { recursive: true });
    fs.symlinkSync(realScriptsDir, linkedScriptsDir, 'dir');
    const root = makeFixture({ 'ADR-fixture.md': 'See `src/utils/gone.ts` for the split.\n' });

    const result = spawnSync(
      'node',
      [
        path.join(linkedScriptsDir, path.basename(SCRIPT)),
        '--fixture',
        path.join(root, 'docs'),
        root,
      ],
      { encoding: 'utf8' }
    );

    assert.notStrictEqual(result.status, 0, 'a symlinked script path must not silently no-op');
    assert.ok(
      /src\/utils\/gone\.ts/.test(result.stderr),
      `expected main() to run and report the dead citation; stderr:\n${result.stderr}`
    );
  });
});

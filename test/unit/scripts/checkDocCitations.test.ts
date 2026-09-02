/**
 * Companion spec for scripts/check-doc-citations.mjs.
 *
 * Proves the guard passes on the real docs tree with its allowlist, has
 * teeth on a dead citation, exempts only an EXACT (doc, citedPath) match
 * from scripts/doc-citation-exemptions.json (no substring/prefix/suffix
 * collision), fails on a stale allowlist entry, anchors the path regex so a
 * directory prefix or a longer real extension cannot slip past, enforces a
 * citation exactly the same way whether it sits in prose, an HTML comment,
 * or a code fence (the scan is purely textual — no markdown parsing), and
 * keeps the anti-vacuity floor unconditional in real mode regardless of argv.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-doc-citations.mjs');
const TMP_ROOT = SCRATCH_ROOT;

interface Exemption {
  doc: string;
  citedPath: string;
  reason: string;
}

interface CheckDocCitationsModule {
  CITATION_RE: RegExp;
  DEFAULT_MIN_CITATIONS: number;
  findCitations: (text: string) => Array<{ lineNo: number; citedPath: string }>;
  listMarkdownFiles: (dir: string) => string[];
  loadExemptions: (exemptionsPath: string) => Exemption[];
  resolveInvocation: (argv: string[]) => {
    fixtureMode: boolean;
    docsDir: string;
    repoRoot: string;
    minCitations: number;
    exemptionsPath: string;
  };
  staleExemptions: (
    exemptions: Exemption[],
    repoRoot: string,
    citationsByDoc: Map<string, Set<string>>
  ) => Array<{ entry: Exemption; reason: string }>;
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

  it('accepts a live test/*.ts and scripts/*.sh citation', () => {
    const root = makeFixture(
      { 'ADR-fixture.md': 'See `test/e2e/support/live.ts` and `scripts/live.sh`.\n' },
      ['test/e2e/support/live.ts', 'scripts/live.sh']
    );
    const { status, stderr } = runGuard(['--fixture', path.join(root, 'docs'), root]);
    assert.strictEqual(status, 0, `live citations must pass; stderr:\n${stderr}`);
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

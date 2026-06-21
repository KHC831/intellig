/**
 * Companion spec for scripts/check-no-section-symbol.sh (the U+00A7 ban).
 *
 * Proves the guard (a) passes against the real tree, (b) has teeth — it fails
 * when the glyph appears in a scanned path, (c) honours its broadened scope —
 * the test subtree is IN scope (test titles + doc-content assertions spell
 * the word "section"), and (d) in default (no-arg) mode scans git-TRACKED
 * files only, so an untracked/gitignored coordination scratch file
 * (AGENT_WORKSPACE.md and friends) is never flagged while a tracked glyph
 * still fails.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-no-section-symbol.sh');
const GLYPH = Buffer.from([0xc2, 0xa7]).toString('utf8'); // U+00A7, never typed literally here

function runGuard(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr ?? '' };
}

// Run the guard with its cwd set to a fixture repo so the default (no-arg)
// git-tracked scan resolves against that repo, not the real one.
function runGuardInDir(cwd: string): { status: number | null; stderr: string } {
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', cwd });
  return { status: r.status, stderr: r.stderr ?? '' };
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr ?? ''}`);
  }
}

describe('check-no-section-symbol guard', () => {
  it('passes against the real tree — src (incl. test), scripts, docs, root .md (default scope)', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on a clean tree; stderr:\n${stderr}`);
  });

  it('fails when the glyph appears in a scanned file (has teeth)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sect-guard-'));
    try {
      fs.writeFileSync(path.join(dir, 'offender.ts'), `// see ADR-009 ${GLYPH}6\n`, 'utf8');
      const { status, stderr } = runGuard([dir]);
      assert.strictEqual(status, 1, 'guard must fail when the glyph is present');
      assert.ok(/section-symbol guard FAILED/.test(stderr), 'should report the failure');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a binary file whose raw bytes contain the glyph (e.g. a stray .DS_Store)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sect-guard-'));
    try {
      // macOS Finder drops gitignored .DS_Store binaries into scanned dirs; their
      // raw bytes can contain 0xA7, which must not trip the text-only glyph guard.
      fs.writeFileSync(path.join(dir, '.DS_Store'), Buffer.from([0x00, 0xc2, 0xa7, 0x00, 0xff]));
      const { status, stderr } = runGuard([dir]);
      assert.strictEqual(status, 0, `binary 0xA7 must be ignored; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes the test subtree in scope (a glyph under a test/ dir fails)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sect-guard-'));
    try {
      const testDir = path.join(dir, 'test');
      fs.mkdirSync(testDir);
      fs.writeFileSync(path.join(testDir, 'spec.ts'), `// ADR-009 ${GLYPH}6 citation\n`, 'utf8');
      const { status } = runGuard([dir]);
      assert.strictEqual(
        status,
        1,
        'glyph under a test/ dir must now be in scope and fail the guard'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Default (no-arg) mode scans git-tracked files only. These fixtures stand
  // up a throwaway git repo so the git-grep path is exercised for real.
  it('default mode skips untracked + gitignored files (a coordination scratch note is not flagged)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sect-guard-git-'));
    try {
      git(dir, 'init', '-q');
      // A tracked, clean doc so the in-scope scan has real content to chew on.
      fs.mkdirSync(path.join(dir, 'docs'));
      fs.writeFileSync(path.join(dir, 'docs', 'clean.md'), '# clean\nsee section 3\n', 'utf8');
      fs.writeFileSync(path.join(dir, '.gitignore'), 'IGNORED.md\n', 'utf8');
      git(dir, 'add', 'docs/clean.md', '.gitignore');
      // Untracked AND gitignored scratch, both glyph-laden — mimics the
      // teammates' AGENT_WORKSPACE.md that triggered the gate failure.
      fs.writeFileSync(path.join(dir, 'UNTRACKED.md'), `report cites ADR-009 ${GLYPH}6\n`, 'utf8');
      fs.writeFileSync(path.join(dir, 'IGNORED.md'), `report cites ADR-009 ${GLYPH}3\n`, 'utf8');
      const { status, stderr } = runGuardInDir(dir);
      assert.strictEqual(
        status,
        0,
        `untracked/gitignored .md must be out of default scope; stderr:\n${stderr}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('default mode still has teeth (a tracked .md with the glyph fails)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sect-guard-git-'));
    try {
      git(dir, 'init', '-q');
      fs.mkdirSync(path.join(dir, 'docs'));
      fs.writeFileSync(path.join(dir, 'docs', 'offender.md'), `see ADR-009 ${GLYPH}6\n`, 'utf8');
      git(dir, 'add', 'docs/offender.md');
      const { status, stderr } = runGuardInDir(dir);
      assert.strictEqual(status, 1, 'a tracked .md with the glyph must fail in default mode');
      assert.ok(/section-symbol guard FAILED/.test(stderr), 'should report the failure');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

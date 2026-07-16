/**
 * Companion spec for scripts/check-git-dir-markers.sh.
 *
 * Proves the guard (a) passes against the real tree, (b) has teeth on a raw
 * rebase state-dir literal, (c) ignores comment-only mentions and the
 * `--rebase-merges` CLI flag, and (d) honours the
 * `git-dir-marker-exempt:` marker on the same or preceding line.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-git-dir-markers.sh');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes/tmp');

function runGuard(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr ?? '' };
}

function checkSource(src: string): number | null {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'git-dir-markers-guard-'));
  try {
    fs.writeFileSync(path.join(dir, 'offender.ts'), src, 'utf8');
    return runGuard([dir]).status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-git-dir-markers guard', () => {
  it('passes against the real tree', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on a clean tree; stderr:\n${stderr}`);
  });

  it('fails on a raw rebase-apply path join (has teeth)', () => {
    assert.strictEqual(
      checkSource("const p = path.join(gitDir, 'rebase-apply');\n"),
      1,
      'a raw rebase-apply literal must fail'
    );
  });

  it('fails on a raw rebase-merge marker read', () => {
    assert.strictEqual(
      checkSource("const raw = await tryReadGitFile(path.join(gitDir, 'rebase-merge', 'onto'));\n"),
      1,
      'a raw rebase-merge literal must fail'
    );
  });

  it('fails on a watcher glob literal', () => {
    assert.strictEqual(
      checkSource("const patterns = ['HEAD', 'rebase-merge/**'];\n"),
      1,
      'a glob built from the raw dir name must fail'
    );
  });

  it('ignores comment-only mentions of the dirs', () => {
    assert.strictEqual(
      checkSource(
        '// rebase-merge holds the interactive rebase state\n' +
          ' * `.git/rebase-apply/` backs git am too\n' +
          'const unrelated = 1;\n'
      ),
      0,
      'comments may name the dirs freely'
    );
  });

  it('ignores the --rebase-merges CLI flag', () => {
    assert.strictEqual(
      checkSource("flags.push('--rebase-merges');\n"),
      0,
      'the CLI flag is not a state-dir literal'
    );
  });

  it('honours the exempt marker on the same line', () => {
    assert.strictEqual(
      checkSource(
        "const hint = 'see rebase-apply docs'; // git-dir-marker-exempt: UI copy, not a .git path\n"
      ),
      0,
      'a same-line exempt marker must be allowed'
    );
  });

  it('honours the exempt marker on the preceding line', () => {
    assert.strictEqual(
      checkSource(
        '// git-dir-marker-exempt: UI copy, not a .git path\n' +
          "const hint = 'see rebase-apply docs';\n"
      ),
      0,
      'a preceding-line exempt marker must be allowed'
    );
  });
});

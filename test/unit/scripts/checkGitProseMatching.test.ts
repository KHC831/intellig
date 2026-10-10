/**
 * Companion spec for scripts/check-git-prose-matching.sh.
 *
 * Proves the guard (a) passes against the real tree (every prose predicate
 * lives in git-core/gitProse.ts), (b) has teeth on both matching shapes — a
 * string-literal `.includes('<git prose>')` and a regex-literal
 * `/<git prose>/.test(...)` outside the sanctioned module — and (c) honours
 * the `git-prose-exempt` escape hatch. Explicit-path mode treats every given
 * file as non-sanctioned so fixtures exercise the teeth.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-git-prose-matching.sh');
const TMP_ROOT = SCRATCH_ROOT;

function runGuard(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '' };
}

function checkSource(src: string): number | null {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'git-prose-guard-'));
  try {
    fs.writeFileSync(path.join(dir, 'offender.ts'), src, 'utf8');
    return runGuard([dir]).status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-git-prose-matching guard', () => {
  it('passes against the real tree', () => {
    const { status, stdout } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on a clean tree; stdout:\n${stdout}`);
  });

  it(".includes('<git prose>') outside gitProse.ts fails (has teeth)", () => {
    assert.strictEqual(
      checkSource("if (stderr.includes('would be overwritten')) { handle(); }\n"),
      1,
      'a hand-rolled prose .includes must fail the guard'
    );
  });

  it('a prose regex literal with .test( outside gitProse.ts fails', () => {
    assert.strictEqual(
      checkSource('if (/CONFLICT|needs merge/i.test(message)) { handle(); }\n'),
      1,
      'a hand-rolled prose regex predicate must fail the guard'
    );
  });

  it('catches the worktree-remove refusals too', () => {
    for (const src of [
      'if (/cannot remove a locked working tree/.test(message)) { retry(); }\n',
      "if (message.includes('contains modified or untracked files')) { retry(); }\n",
    ]) {
      assert.strictEqual(checkSource(src), 1, `the worktree-remove refusal is fenced: ${src}`);
    }
  });

  it('catches the untracked-overwrite phrasing too', () => {
    assert.strictEqual(
      checkSource(
        'const hit = lines.findIndex((l) => /untracked working tree files would be overwritten by/i.test(l));\n'
      ),
      1,
      'the untracked-overwrite detector class is part of the fence'
    );
  });

  it('honours the git-prose-exempt marker on the same or preceding line', () => {
    assert.strictEqual(
      checkSource(
        '// git-prose-exempt: matching OUR OWN toast copy in a test bridge, not git output\n' +
          "if (toast.includes('would be overwritten')) { count++; }\n"
      ),
      0,
      'a justified prose match must be allowed'
    );
  });

  it('leaves plain UI copy (no .includes/.test/.match call) alone', () => {
    assert.strictEqual(
      checkSource(
        "void vscode.window.showErrorMessage('Local changes would be overwritten by this reset.');\n"
      ),
      0,
      'emitting prose in a toast is not detection — only matching is fenced'
    );
  });
});

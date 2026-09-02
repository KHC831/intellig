/**
 * Companion spec for scripts/check-conflict-toast-handoff.sh.
 *
 * Proves the guard (a) passes against the real tree, (b) has teeth on a bare
 * conflict toast with no dialog handoff, (c) allows the toast when a
 * conflictResolutionService guard precedes it within the window, and
 * (d) honours the `conflict-toast-exempt:` marker.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-conflict-toast-handoff.sh');
const TMP_ROOT = SCRATCH_ROOT;

function runGuard(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr ?? '' };
}

function checkSource(src: string): number | null {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'conflict-toast-guard-'));
  try {
    fs.writeFileSync(path.join(dir, 'offender.ts'), src, 'utf8');
    return runGuard([dir]).status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TOAST =
  'void vscode.window.showWarningMessage(\n' +
  '  `Merge conflicts in ${n} file(s). Please resolve conflicts.`\n' +
  ');\n';

describe('check-conflict-toast-handoff guard', () => {
  it('passes against the real tree', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on a clean tree; stderr:\n${stderr}`);
  });

  it('fails on a bare conflict toast with no dialog handoff (has teeth)', () => {
    assert.strictEqual(checkSource(TOAST), 1, 'a bare conflict toast must fail');
  });

  it('allows the toast as the fallback behind a conflictResolutionService guard', () => {
    const guarded =
      'if (this._conflictResolutionService) {\n' +
      '  await this._openResolveConflictsDialog(repo, conflicts, opts);\n' +
      '} else {\n' +
      `  ${TOAST}` +
      '}\n';
    assert.strictEqual(checkSource(guarded), 0, 'the guarded fallback shape must pass');
  });

  it('skips a line carrying the conflict-toast-exempt marker', () => {
    const exempted =
      '// conflict-toast-exempt below is deliberate\n' +
      'void warn(`in 2 file(s). Please resolve conflicts.`); // conflict-toast-exempt: preflight guard, not a post-op arm\n';
    assert.strictEqual(checkSource(exempted), 0, 'a marked line must be allowed');
  });
});

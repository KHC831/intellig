/**
 * Companion spec for scripts/check-rebase-containment-guarded.mjs.
 *
 * Proves the guard (a) passes against the real tree, has teeth in BOTH homes —
 * (b) a MODULE `export function` and (d) a CLASS method that start a rebase
 * without the containment guard both fail — (c)+(e) the ctx-stem guard and the
 * exempt marker pass, and (f) it is fail-closed: a scan that matches zero
 * rebase-start sites fails rather than reading as clean. The module fixtures are
 * proven red here even though the real module may not exist yet.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-rebase-containment-guarded.mjs');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes/tmp');

function runFixture(source: string): { status: number | null; stderr: string; stdout: string } {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'rebase-containment-'));
  try {
    fs.writeFileSync(path.join(dir, 'sample.ts'), source, 'utf8');
    const r = spawnSync('node', [SCRIPT, dir], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const MODULE_UNGATED = `export async function handleDropCommit(ctx: I, hashes: string[]): Promise<void> {
  await ctx.rebaseService.startInteractiveRebase(repo, onto);
}
`;
const MODULE_GATED = `export async function handleDropCommit(ctx: I, hashes: string[]): Promise<void> {
  if (!(await ctx.isOldestInCurrentBranch(repo, oldest))) return;
  await ctx.rebaseService.startInteractiveRebase(repo, onto);
}
`;
const CLASS_UNGATED = `class C {
  private async _handleDropCommit(hashes: string[]): Promise<void> {
    await this._rebaseService.startInteractiveRebase(repo, onto);
  }
}
`;
const MODULE_EXEMPT = `export async function runHistoryRewrite(ctx: I): Promise<void> {
  // rebase-containment-exempt: callers gate on their own oldest hash first.
  await ctx.rebaseService.startInteractiveRebase(repo, onto);
}
`;
const NO_REBASE = `export async function noop(): Promise<void> {
  return;
}
`;

describe('check-rebase-containment-guarded guard', () => {
  it('passes against the real tree', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    assert.strictEqual(
      r.status,
      0,
      `guard should pass on the real tree; stderr:\n${r.stderr ?? ''}`
    );
  });

  it('fails a MODULE export function that starts a rebase without the guard (module arm has teeth)', () => {
    const { status, stderr } = runFixture(MODULE_UNGATED);
    assert.strictEqual(status, 1, `an un-gated module rebase-starter must fail; ${stderr}`);
    assert.ok(stderr.includes('handleDropCommit'));
  });

  it('passes a module function that carries the ctx-stem guard', () => {
    const { status, stderr } = runFixture(MODULE_GATED);
    assert.strictEqual(status, 0, `a gated module rebase-starter must pass; ${stderr}`);
  });

  it('fails a CLASS method that starts a rebase without the guard (class arm still has teeth)', () => {
    const { status, stderr } = runFixture(CLASS_UNGATED);
    assert.strictEqual(status, 1, `an un-gated class rebase-starter must fail; ${stderr}`);
    assert.ok(stderr.includes('_handleDropCommit'));
  });

  it('honours the rebase-containment-exempt marker', () => {
    const { status, stderr } = runFixture(MODULE_EXEMPT);
    assert.strictEqual(status, 0, `an exempt rebase-starter must pass; ${stderr}`);
  });

  it('is FAIL-CLOSED: a scan matching zero rebase-start sites fails', () => {
    const { status, stderr } = runFixture(NO_REBASE);
    assert.strictEqual(
      status,
      1,
      `zero rebase-start sites must fail, not read as clean; ${stderr}`
    );
    assert.ok(stderr.includes('FAIL-CLOSED'));
  });
});

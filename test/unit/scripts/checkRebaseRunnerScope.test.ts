/**
 * Companion spec for scripts/check-rebase-runner-scope.mjs (the mjs port of the
 * former conflict-flow checks (b) executeRebase-only-inside-the-runner and (c)
 * the-runner-keeps-its-gates).
 *
 * Proves the guard (a) passes against the real tree, has teeth on the runner
 * contract in BOTH homes — a CLASS `_runHistoryRewrite` and a MODULE
 * `runHistoryRewrite` export — for out-of-scope execute, indent-anchored scope
 * end, and each missing pre-flight gate; honours both escape markers; and is
 * FAIL-CLOSED when the scan matches no runner / no execute.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-rebase-runner-scope.mjs');
const TMP_ROOT = SCRATCH_ROOT;

function runFixture(source: string): { status: number | null; stderr: string } {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'runner-scope-'));
  try {
    fs.writeFileSync(path.join(dir, 'sample.ts'), source, 'utf8');
    const r = spawnSync('node', [SCRIPT, dir], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CLASS_RUNNER_OK = `class C {
  private async _runHistoryRewrite(repo: IRepository): Promise<void> {
    if (!(await this._isRangeMergeFree(repo, onto))) return;
    if (!(await this._isNotOnProtectedBranch(cwd, oldest))) return;
    const r = await this._rebaseService.executeRebase(repo);
  }
}
`;
const MODULE_RUNNER_OK = `export async function runHistoryRewrite(ctx: I): Promise<void> {
  if (!(await ctx.isRangeMergeFree(repo, onto))) return;
  if (!(await ctx.isNotOnProtectedBranch(cwd, oldest))) return;
  const r = await ctx.rebaseService.executeRebase(repo);
}
`;
// A valid runner plus a second function whose execute is OUT of the runner scope.
const MODULE_EXECUTE_OUTSIDE = `export async function runHistoryRewrite(ctx: I): Promise<void> {
  if (!(await ctx.isRangeMergeFree(repo, onto))) return;
  if (!(await ctx.isNotOnProtectedBranch(cwd, oldest))) return;
  const r = await ctx.rebaseService.executeRebase(repo);
}
export async function sneaky(ctx: I): Promise<void> {
  await ctx.rebaseService.executeRebase(repo);
}
`;
const CLASS_EXECUTE_AFTER = `class C {
  private async _runHistoryRewrite(repo: IRepository): Promise<void> {
    if (!(await this._isRangeMergeFree(repo, onto))) return;
    if (!(await this._isNotOnProtectedBranch(cwd, oldest))) return;
    const r = await this._rebaseService.executeRebase(repo);
  }
  private async _another(repo: IRepository): Promise<void> {
    await this._rebaseService.executeRebase(repo);
  }
}
`;
const MODULE_MISSING_MERGE = `export async function runHistoryRewrite(ctx: I): Promise<void> {
  if (!(await ctx.isNotOnProtectedBranch(cwd, oldest))) return;
  const r = await ctx.rebaseService.executeRebase(repo);
}
`;
const MODULE_MISSING_PROT = `export async function runHistoryRewrite(ctx: I): Promise<void> {
  if (!(await ctx.isRangeMergeFree(repo, onto))) return;
  const r = await ctx.rebaseService.executeRebase(repo);
}
`;
const GATE_EXEMPT = `// runner-gate-exempt: fixture runner exercising an unrelated invariant
export async function runHistoryRewrite(ctx: I): Promise<void> {
  const r = await ctx.rebaseService.executeRebase(repo);
}
`;
const HR_EXEMPT = `export async function runHistoryRewrite(ctx: I): Promise<void> {
  if (!(await ctx.isRangeMergeFree(repo, onto))) return;
  if (!(await ctx.isNotOnProtectedBranch(cwd, oldest))) return;
  const r = await ctx.rebaseService.executeRebase(repo);
}
export async function scripted(ctx: I): Promise<void> {
  // history-rewrite-exempt: exercised by a scripted migration, not a user flow
  await ctx.rebaseService.executeRebase(repo);
}
`;
const NO_RUNNER = `export async function noop(): Promise<void> {
  return;
}
`;

describe('check-rebase-runner-scope guard', () => {
  it('passes against the real tree', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    assert.strictEqual(
      r.status,
      0,
      `guard should pass on the real tree; stderr:\n${r.stderr ?? ''}`
    );
  });

  it('passes a well-formed CLASS runner (execute inside, both gates)', () => {
    assert.strictEqual(runFixture(CLASS_RUNNER_OK).status, 0);
  });

  it('passes a well-formed MODULE runner (execute inside, both gates)', () => {
    assert.strictEqual(runFixture(MODULE_RUNNER_OK).status, 0);
  });

  it('fails a MODULE execute outside any runner scope (no fifth skeleton)', () => {
    const { status, stderr } = runFixture(MODULE_EXECUTE_OUTSIDE);
    assert.strictEqual(status, 1, `an out-of-runner execute must fail; ${stderr}`);
    assert.ok(stderr.includes('outside a runHistoryRewrite scope'));
  });

  it('scope ends at the runner close — a CLASS execute in the next member fails', () => {
    const { status, stderr } = runFixture(CLASS_EXECUTE_AFTER);
    assert.strictEqual(status, 1, `the runner scope must not leak past its close; ${stderr}`);
  });

  it('fails a runner missing the merge-flattening gate', () => {
    const { status, stderr } = runFixture(MODULE_MISSING_MERGE);
    assert.strictEqual(status, 1, `missing isRangeMergeFree( must fail; ${stderr}`);
    assert.ok(stderr.includes('isRangeMergeFree('));
  });

  it('fails a runner missing the protected-branch gate', () => {
    const { status, stderr } = runFixture(MODULE_MISSING_PROT);
    assert.strictEqual(status, 1, `missing isNotOnProtectedBranch( must fail; ${stderr}`);
    assert.ok(stderr.includes('isNotOnProtectedBranch('));
  });

  it('honours the runner-gate-exempt marker on the preceding line', () => {
    assert.strictEqual(runFixture(GATE_EXEMPT).status, 0);
  });

  it('honours the history-rewrite-exempt marker on the preceding line', () => {
    assert.strictEqual(runFixture(HR_EXEMPT).status, 0);
  });

  it('is FAIL-CLOSED: zero runner scopes / zero execute sites fails', () => {
    const { status, stderr } = runFixture(NO_RUNNER);
    assert.strictEqual(
      status,
      1,
      `a scan matching no runner must fail, not read as clean; ${stderr}`
    );
    assert.ok(stderr.includes('FAIL-CLOSED'));
  });
});

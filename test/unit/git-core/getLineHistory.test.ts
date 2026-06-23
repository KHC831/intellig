/**
 * F slice — line-scoped file history (`git log -L<start>,<end>:<file>`).
 *
 * Mirrors IntelliJ's "Show History for Selection"
 * (`platform/vcs-impl/.../SelectedBlockHistoryAction` +
 * `VcsSelectionHistoryDialog`): history restricted to a specific line range.
 * The native git equivalent is `git log -L<start>,<end>:<file>`, which embeds
 * the path in the `-L` token (so it is one argv element — no shell splice) and
 * implies `--patch`; we add `--no-patch` so the custom log format parses
 * cleanly into commit metadata.
 */

import '../../setup';
import * as assert from 'assert';
import { StashTagHistoryOps } from '../../../src/git-core/ops/StashTagHistoryOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';

function makeOps(exitCode = 0): { ops: StashTagHistoryOps; calls: string[][] } {
  const calls: string[][] = [];
  const gitCli = {
    exec: async (args: string[]) => {
      calls.push(args);
      return { exitCode, stdout: '', stderr: '' };
    },
  };
  const ctx = {
    gitCli,
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return { ops: new StashTagHistoryOps(ctx), calls };
}

const repo = { rootUri: { fsPath: '/repo' } } as unknown as IRepository;

describe('StashTagHistoryOps.getLineHistory — line-scoped history (F)', () => {
  it('builds a -L<start>,<end>:<file> token as a single argv element', async () => {
    const { ops, calls } = makeOps();
    await ops.getLineHistory(repo, 'src/foo.ts', 10, 20);
    const args = calls[0];
    assert.ok(
      args.includes('-L10,20:src/foo.ts'),
      `expected a -L token, got: ${JSON.stringify(args)}`
    );
  });

  it('suppresses patch output with --no-patch so the log format parses', async () => {
    const { ops, calls } = makeOps();
    await ops.getLineHistory(repo, 'src/foo.ts', 1, 5);
    assert.ok(calls[0].includes('--no-patch'), '--no-patch must be present');
  });

  it('embeds the path inside the -L token rather than a -- pathspec', async () => {
    const { ops, calls } = makeOps();
    await ops.getLineHistory(repo, 'src/foo.ts', 1, 5);
    const args = calls[0];
    // -L carries the path; a separate `-- path` pathspec is illegal with -L.
    assert.ok(!args.includes('--'), 'no -- pathspec separator when using -L');
  });

  it('passes a branch ref as a revision argument when given', async () => {
    const { ops, calls } = makeOps();
    await ops.getLineHistory(repo, 'src/foo.ts', 1, 5, { branch: 'origin/feature' });
    assert.ok(calls[0].includes('origin/feature'), 'branch ref passed as a revision');
  });

  it('does not add a revision arg when no branch is given', async () => {
    const { ops, calls } = makeOps();
    await ops.getLineHistory(repo, 'src/foo.ts', 1, 5);
    assert.ok(!calls[0].some((a) => a === 'origin/feature'));
  });

  it('returns Ok([]) when git exits non-zero', async () => {
    const { ops } = makeOps(1);
    const result = await ops.getLineHistory(repo, 'src/foo.ts', 1, 5);
    assert.ok(result.isOk());
    assert.deepStrictEqual(result._unsafeUnwrap(), []);
  });

  it('errs on a start line that is not a positive integer', async () => {
    const { ops, calls } = makeOps();
    for (const start of [0, 1.5, -3]) {
      const result = await ops.getLineHistory(repo, 'src/foo.ts', start, 5);
      assert.ok(result.isErr(), `expected Err for start line ${start}`);
      assert.strictEqual(result._unsafeUnwrapErr().kind, 'invalid-argument');
    }
    assert.strictEqual(calls.length, 0, 'git must not be invoked for an invalid range');
  });

  it('errs on an end line below the start line', async () => {
    const { ops, calls } = makeOps();
    const result = await ops.getLineHistory(repo, 'src/foo.ts', 20, 10);
    assert.ok(result.isErr());
    assert.strictEqual(result._unsafeUnwrapErr().kind, 'invalid-argument');
    assert.strictEqual(calls.length, 0, 'git must not be invoked for an inverted range');
  });
});

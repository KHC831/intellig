/**
 * StagingOps.revertHunk must not leave a stale index.
 *
 * `revertHunk` reverse-applies the hunk patch to the working tree only (no
 * `--cached`). If the same file also has staged changes, the index keeps the
 * pre-revert content, so the "discarded" hunk silently reappears on the next
 * commit — the user thinks they discarded it; they didn't. The guard refuses
 * the revert when the file has staged changes rather than corrupt the index.
 */

import '../../setup';
import * as assert from 'assert';
import { StagingOps } from '../../../src/git-core/ops/StagingOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { IRepository, IHunk } from '../../../src/git-core/interfaces/IGitService';
import { literalPathspec } from '../../../src/git-core/gitCli';

interface ExecCall {
  args: string[];
  input?: string;
}

interface ScriptedResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function makeMockOps(script: ScriptedResult[] = []): { ops: StagingOps; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const responses = [...script];
  const gitCli = {
    exec: async (args: string[], options?: { input?: string }) => {
      calls.push({ args, input: options?.input });
      return responses.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const ctx = {
    gitCli,
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return { ops: new StagingOps(ctx), calls };
}

const repo = (root: string): IRepository =>
  ({ rootUri: { fsPath: root } }) as unknown as IRepository;

function modifyHunk(): IHunk {
  return {
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    header: '@@ -1,2 +1,2 @@',
    lines: [
      { type: 'context', content: 'line1', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'delete', content: 'line2', oldLineNumber: 2 },
      { type: 'add', content: 'MODIFIED', newLineNumber: 2 },
    ],
  };
}

describe('StagingOps — revertHunk refuses to leave a stale index', () => {
  it('throws (without reverse-applying) when the file already has staged changes', async () => {
    // `git diff --cached --name-only -- <path>` returns the path → staged.
    const { ops, calls } = makeMockOps([{ exitCode: 0, stdout: 'src/file.txt\n', stderr: '' }]);
    const result = await ops.revertHunk(repo('/repo'), 'src/file.txt', modifyHunk());
    assert.ok(result.isErr());
    assert.strictEqual(result._unsafeUnwrapErr().kind, 'invalid-argument');
    assert.match(result._unsafeUnwrapErr().message, /stage|unstage/i);
    // The guard must run BEFORE any `git apply -R` — otherwise the working tree
    // is mutated while the index keeps the ghost change.
    const applyCall = calls.find((c) => c.args[0] === 'apply');
    assert.strictEqual(applyCall, undefined, 'revertHunk must not reverse-apply when staged');
  });

  it('reverse-applies to the working tree when the file has no staged changes', async () => {
    const { ops, calls } = makeMockOps([{ exitCode: 0, stdout: '', stderr: '' }]);
    await ops.revertHunk(repo('/repo'), 'src/file.txt', modifyHunk());
    const applyCall = calls.find((c) => c.args[0] === 'apply');
    assert.ok(applyCall, 'expected a git apply call');
    assert.deepStrictEqual(applyCall.args, ['apply', '-R', '-']);
  });

  it('checks the staged state of the exact path being reverted', async () => {
    const { ops, calls } = makeMockOps([{ exitCode: 0, stdout: '', stderr: '' }]);
    await ops.revertHunk(repo('/repo'), 'dir/sub file.txt', modifyHunk());
    assert.deepStrictEqual(calls[0].args, [
      'diff',
      '--cached',
      '--name-only',
      '--',
      literalPathspec('dir/sub file.txt'),
    ]);
  });
});

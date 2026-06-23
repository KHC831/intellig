/**
 * H3 — cherry-pick and revert with `-m <mainline>` for merge commits.
 *
 * `git cherry-pick` and `git revert` both fail with "is a merge but no -m
 * option was given" when the target commit is a merge commit. The ops layer
 * must pass `-m 1` (parent 1 = conventional mainline) when the caller sets
 * `mainline: 1` in the options.
 *
 * For revert, a `message` option lets the caller supply the commit message;
 * the implementation uses `--no-commit` + `git commit -m <message>` so the
 * message is applied atomically without needing $GIT_EDITOR.
 */

import '../../setup';
import * as assert from 'assert';
import { CherryPickRevertOps } from '../../../src/git-core/ops/CherryPickRevertOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';

interface ExecCall {
  args: string[];
}

function makeMockOps(responses: { exitCode: number; stdout: string; stderr: string }[]): {
  ops: CherryPickRevertOps;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const queue = [...responses];
  const gitCli = {
    exec: async (args: string[]) => {
      calls.push({ args });
      return queue.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const ctx: IGitOpsContext = {
    get gitCli() {
      return gitCli as unknown as IGitOpsContext['gitCli'];
    },
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  };
  return { ops: new CherryPickRevertOps(ctx), calls };
}

const repo = (): IRepository => ({ rootUri: { fsPath: '/repo' } }) as unknown as IRepository;

describe('CherryPickRevertOps — -m mainline for merge commits (H3)', () => {
  describe('cherry-pick', () => {
    it('passes -m 1 when mainline option is 1', async () => {
      const { ops, calls } = makeMockOps([{ exitCode: 0, stdout: '', stderr: '' }]);
      const result = (await ops.cherryPick(repo(), ['abc1234'], { mainline: 1 }))._unsafeUnwrap();
      assert.ok(result.success);
      const cherry = calls.find((c) => c.args[0] === 'cherry-pick');
      assert.ok(cherry, 'cherry-pick was called');
      assert.ok(cherry.args.includes('-m'), 'expected -m flag');
      const mIdx = cherry.args.indexOf('-m');
      assert.strictEqual(cherry.args[mIdx + 1], '1', 'mainline should be 1');
    });

    it('does not pass -m when mainline is absent', async () => {
      const { ops, calls } = makeMockOps([{ exitCode: 0, stdout: '', stderr: '' }]);
      await ops.cherryPick(repo(), ['abc1234']);
      const cherry = calls.find((c) => c.args[0] === 'cherry-pick');
      assert.ok(cherry, 'cherry-pick was called');
      assert.ok(!cherry.args.includes('-m'), 'should not have -m flag');
    });

    it('-m is placed before the commit hashes in the args list', async () => {
      const { ops, calls } = makeMockOps([{ exitCode: 0, stdout: '', stderr: '' }]);
      await ops.cherryPick(repo(), ['deadbeef'], { mainline: 1 });
      const cherry = calls.find((c) => c.args[0] === 'cherry-pick');
      assert.ok(cherry);
      const mIdx = cherry.args.indexOf('-m');
      const hashIdx = cherry.args.indexOf('deadbeef');
      assert.ok(mIdx < hashIdx, '-m should appear before the hash');
    });
  });

  describe('revert', () => {
    it('passes -m 1 when mainline option is 1', async () => {
      const { ops, calls } = makeMockOps([{ exitCode: 0, stdout: '', stderr: '' }]);
      const result = (await ops.revert(repo(), ['abc1234'], { mainline: 1 }))._unsafeUnwrap();
      assert.ok(result.success);
      const revert = calls.find((c) => c.args[0] === 'revert');
      assert.ok(revert, 'revert was called');
      assert.ok(revert.args.includes('-m'), 'expected -m flag');
      assert.strictEqual(revert.args[revert.args.indexOf('-m') + 1], '1');
    });

    it('does not pass -m when mainline is absent', async () => {
      const { ops, calls } = makeMockOps([{ exitCode: 0, stdout: '', stderr: '' }]);
      await ops.revert(repo(), ['abc1234']);
      const revert = calls.find((c) => c.args[0] === 'revert');
      assert.ok(revert);
      assert.ok(!revert.args.includes('-m'));
    });

    it('uses --no-commit then git commit when message is provided', async () => {
      const { ops, calls } = makeMockOps([
        { exitCode: 0, stdout: '', stderr: '' }, // revert --no-commit
        { exitCode: 0, stdout: '', stderr: '' }, // git commit -m
      ]);
      const result = (
        await ops.revert(repo(), ['abc1234'], { message: 'Revert "feat: something"' })
      )._unsafeUnwrap();
      assert.ok(result.success);
      const revert = calls.find((c) => c.args[0] === 'revert');
      assert.ok(revert, 'revert was called');
      assert.ok(revert.args.includes('--no-commit'), 'should use --no-commit');
      assert.ok(
        !revert.args.includes('--no-edit'),
        'should not use --no-edit when message provided'
      );
      const commit = calls.find((c) => c.args[0] === 'commit');
      assert.ok(commit, 'git commit was called');
      assert.ok(commit.args.includes('-m'), 'commit should use -m');
      const mIdx = commit.args.indexOf('-m');
      assert.strictEqual(commit.args[mIdx + 1], 'Revert "feat: something"');
    });

    it('message + mainline together: uses --no-commit -m 1 then git commit', async () => {
      const { ops, calls } = makeMockOps([
        { exitCode: 0, stdout: '', stderr: '' },
        { exitCode: 0, stdout: '', stderr: '' },
      ]);
      await ops.revert(repo(), ['mergehash'], { mainline: 1, message: 'Revert the merge' });
      const revert = calls.find((c) => c.args[0] === 'revert');
      assert.ok(revert);
      assert.ok(revert.args.includes('--no-commit'));
      assert.ok(revert.args.includes('-m'));
      assert.strictEqual(revert.args[revert.args.indexOf('-m') + 1], '1');
      const commit = calls.find((c) => c.args[0] === 'commit');
      assert.ok(commit);
    });

    it('without message uses --no-edit (existing behaviour)', async () => {
      const { ops, calls } = makeMockOps([{ exitCode: 0, stdout: '', stderr: '' }]);
      await ops.revert(repo(), ['abc1234']);
      const revert = calls.find((c) => c.args[0] === 'revert');
      assert.ok(revert);
      assert.ok(revert.args.includes('--no-edit'));
    });
  });

  // The mainline parent number is spliced directly into argv. A non-integer
  // or non-positive value must be rejected before it reaches git, so a
  // malformed caller value can never land as a stray token in the command.
  describe('mainline validation (argv injection-safe)', () => {
    const bad: { label: string; value: number }[] = [
      { label: 'zero', value: 0 },
      { label: 'negative', value: -1 },
      { label: 'fractional', value: 2.5 },
      { label: 'NaN', value: Number.NaN },
      { label: 'Infinity', value: Number.POSITIVE_INFINITY },
    ];
    for (const { label, value } of bad) {
      it(`cherry-pick rejects ${label} mainline and never spawns git`, async () => {
        const { ops, calls } = makeMockOps([{ exitCode: 0, stdout: '', stderr: '' }]);
        const result = await ops.cherryPick(repo(), ['abc1234'], { mainline: value });
        assert.ok(result.isErr());
        assert.strictEqual(result._unsafeUnwrapErr().kind, 'invalid-argument');
        assert.strictEqual(calls.length, 0, 'no git command should run for invalid mainline');
      });
      it(`revert rejects ${label} mainline and never spawns git`, async () => {
        const { ops, calls } = makeMockOps([{ exitCode: 0, stdout: '', stderr: '' }]);
        const result = await ops.revert(repo(), ['abc1234'], { mainline: value });
        assert.ok(result.isErr());
        assert.strictEqual(result._unsafeUnwrapErr().kind, 'invalid-argument');
        assert.strictEqual(calls.length, 0, 'no git command should run for invalid mainline');
      });
    }

    it('cherry-pick accepts mainline 2 and places hash behind --end-of-options', async () => {
      const { ops, calls } = makeMockOps([{ exitCode: 0, stdout: '', stderr: '' }]);
      await ops.cherryPick(repo(), ['deadbeef'], { mainline: 2 });
      const cherry = calls.find((c) => c.args[0] === 'cherry-pick');
      assert.ok(cherry);
      assert.strictEqual(cherry.args[cherry.args.indexOf('-m') + 1], '2');
      const eooIdx = cherry.args.indexOf('--end-of-options');
      const hashIdx = cherry.args.indexOf('deadbeef');
      assert.ok(eooIdx >= 0 && eooIdx < hashIdx, 'hash must sit behind --end-of-options');
    });

    it('revert accepts mainline 2 and places hash behind --end-of-options', async () => {
      const { ops, calls } = makeMockOps([{ exitCode: 0, stdout: '', stderr: '' }]);
      await ops.revert(repo(), ['deadbeef'], { mainline: 2 });
      const revert = calls.find((c) => c.args[0] === 'revert');
      assert.ok(revert);
      assert.strictEqual(revert.args[revert.args.indexOf('-m') + 1], '2');
      const eooIdx = revert.args.indexOf('--end-of-options');
      const hashIdx = revert.args.indexOf('deadbeef');
      assert.ok(eooIdx >= 0 && eooIdx < hashIdx, 'hash must sit behind --end-of-options');
    });
  });
});

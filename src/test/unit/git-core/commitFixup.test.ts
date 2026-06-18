/**
 * RemoteOps.commitFixup — IntelliJ git4idea "Fixup…" / "Squash Into…"
 * (Git.Fixup.To.Commit / Git.Squash.Into.Commit).
 *
 * These commit the currently-staged changes as `fixup! <target subject>` /
 * `squash! <target subject>` of a SELECTED commit — the `git commit
 * --fixup=<hash>` / `git commit --squash=<hash> --no-edit` primitives.
 *
 * Specs pin:
 *   - real-git round-trip: the new HEAD subject is exactly `fixup!`/`squash!`
 *     prefixed with the target commit's subject;
 *   - the nothing-to-commit path returns a structured failure (no throw);
 *   - the target hash is validated as hex before it reaches the `--fixup=` /
 *     `--squash=` flag value (injection-safe);
 *   - the emitted argv (mock-exec) carries `--no-edit` for squash but not fixup.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { RemoteOps } from '../../../git-core/ops/RemoteOps';
import { IGitOpsContext } from '../../../git-core/ops/GitOpsContext';
import { createGitCli, GitCli } from '../../../git-core/gitCli';
import { IRepository } from '../../../git-core/interfaces/IGitService';

interface ExecCall {
  args: string[];
}

/** Mock-exec context that records argv and replays a scripted result. */
function makeMockOps(result = { exitCode: 0, stdout: '', stderr: '' }): {
  ops: RemoteOps;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const gitCli = {
    exec: async (args: string[]) => {
      calls.push({ args });
      return result;
    },
  };
  const ctx = {
    gitCli,
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return { ops: new RemoteOps(ctx), calls };
}

/** Real-git context backed by a live GitCli for round-trip assertions. */
function makeRealOps(): { ops: RemoteOps; cli: GitCli } {
  const cli = createGitCli();
  const ctx = {
    gitCli: cli,
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return { ops: new RemoteOps(ctx), cli };
}

const repo = (root: string): IRepository =>
  ({ rootUri: { fsPath: root } }) as unknown as IRepository;

describe('RemoteOps.commitFixup', () => {
  describe('argv (injection-safe + flag shape)', () => {
    it('rejects a non-hex target hash before running git', async () => {
      const { ops, calls } = makeMockOps();
      const res = await ops.commitFixup(repo('/r'), '--force', 'fixup');
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.reason, 'invalid-hash');
      assert.strictEqual(calls.length, 0, 'must not invoke git with an invalid hash');
    });

    it('builds `commit --fixup=<hash>` with no --no-edit for fixup mode', async () => {
      const { ops, calls } = makeMockOps();
      await ops.commitFixup(repo('/r'), 'abc123', 'fixup');
      assert.deepStrictEqual(calls[0].args, ['commit', '--fixup=abc123']);
    });

    it('builds `commit --squash=<hash> --no-edit` for squash mode', async () => {
      const { ops, calls } = makeMockOps();
      await ops.commitFixup(repo('/r'), 'abc123', 'squash');
      assert.deepStrictEqual(calls[0].args, ['commit', '--squash=abc123', '--no-edit']);
    });

    it('surfaces nothing-to-commit as a structured failure (no throw)', async () => {
      const { ops } = makeMockOps({
        exitCode: 1,
        stdout: 'nothing to commit, working tree clean',
        stderr: '',
      });
      const res = await ops.commitFixup(repo('/r'), 'abc123', 'fixup');
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.reason, 'nothing-to-commit');
    });
  });

  describe('round-trips real git', () => {
    let tmp: string;
    let realCli: GitCli;

    function git(cwd: string, ...args: string[]): string {
      return execFileSync('git', args, { cwd, encoding: 'utf8' });
    }

    function seedTwoCommits(): string {
      git(tmp, 'init', '-q');
      git(tmp, 'config', 'user.email', 'a@b.c');
      git(tmp, 'config', 'user.name', 't');
      fs.writeFileSync(path.join(tmp, 'a.txt'), 'one\n');
      git(tmp, 'add', '-A');
      git(tmp, 'commit', '-qm', 'first subject');
      const firstHash = git(tmp, 'rev-parse', 'HEAD').trim();
      fs.writeFileSync(path.join(tmp, 'b.txt'), 'two\n');
      git(tmp, 'add', '-A');
      git(tmp, 'commit', '-qm', 'second subject');
      return firstHash;
    }

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-commit-fixup-'));
    });

    afterEach(() => {
      realCli?.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('fixup commits staged changes as `fixup! <target subject>`', async () => {
      const firstHash = seedTwoCommits();
      fs.writeFileSync(path.join(tmp, 'c.txt'), 'three\n');
      git(tmp, 'add', '-A');
      const { ops, cli } = makeRealOps();
      realCli = cli;

      const res = await ops.commitFixup(repo(tmp), firstHash, 'fixup');

      assert.strictEqual(res.success, true);
      const subject = git(tmp, 'log', '-1', '--format=%s').trim();
      assert.strictEqual(subject, 'fixup! first subject');
    });

    it('squash commits staged changes as `squash! <target subject>`', async () => {
      const firstHash = seedTwoCommits();
      fs.writeFileSync(path.join(tmp, 'c.txt'), 'three\n');
      git(tmp, 'add', '-A');
      const { ops, cli } = makeRealOps();
      realCli = cli;

      const res = await ops.commitFixup(repo(tmp), firstHash, 'squash');

      assert.strictEqual(res.success, true);
      const subject = git(tmp, 'log', '-1', '--format=%s').trim();
      assert.strictEqual(subject, 'squash! first subject');
    });

    it('returns nothing-to-commit when no changes are staged', async () => {
      const firstHash = seedTwoCommits();
      const { ops, cli } = makeRealOps();
      realCli = cli;

      const res = await ops.commitFixup(repo(tmp), firstHash, 'fixup');

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.reason, 'nothing-to-commit');
      // HEAD must be untouched — still the second commit.
      const subject = git(tmp, 'log', '-1', '--format=%s').trim();
      assert.strictEqual(subject, 'second subject');
    });
  });
});

import * as assert from 'assert';
import { GitCommandError, IGitCommandResult } from '../../../src/git-core/gitCli';
import {
  GitError,
  NotARepositoryError,
  SpawnFailedError,
  CommandFailedError,
  TimeoutError,
  InvalidArgumentError,
  classifyGitCommandError,
} from '../../../src/git-core/errors';

function makeResult(over: Partial<IGitCommandResult>): IGitCommandResult {
  return { exitCode: 0, stdout: '', stderr: '', combined: '', ...over };
}

describe('git error taxonomy', () => {
  describe('error classes carry a discriminant kind + extend Error', () => {
    it('NotARepositoryError', () => {
      const e = new NotARepositoryError('/some/path');
      assert.ok(e instanceof Error);
      assert.strictEqual(e.kind, 'not-a-repository');
      assert.ok(e.message.includes('/some/path'));
    });

    it('SpawnFailedError', () => {
      const e = new SpawnFailedError('spawn ENOTDIR');
      assert.ok(e instanceof Error);
      assert.strictEqual(e.kind, 'spawn-failed');
    });

    it('CommandFailedError exposes exitCode + stderr', () => {
      const e = new CommandFailedError(128, 'fatal: bad');
      assert.ok(e instanceof Error);
      assert.strictEqual(e.kind, 'command-failed');
      assert.strictEqual(e.exitCode, 128);
      assert.strictEqual(e.stderr, 'fatal: bad');
    });

    it('TimeoutError', () => {
      const e = new TimeoutError();
      assert.ok(e instanceof Error);
      assert.strictEqual(e.kind, 'timeout');
    });

    it('InvalidArgumentError (pre-exec validation, git never ran)', () => {
      const e = new InvalidArgumentError('Invalid ref: --evil');
      assert.ok(e instanceof Error);
      assert.strictEqual(e.kind, 'invalid-argument');
      assert.match(e.message, /Invalid ref/);
    });
  });

  describe('classifyGitCommandError — system vs domain', () => {
    it('classifies a raw ENOTDIR spawn throw (file passed as cwd) as spawn-failed, NEVER not-a-repository', () => {
      // The real failure mode: child_process.spawn() throws SYNCHRONOUSLY with
      // a raw ErrnoException (code ENOTDIR, errno -20) when handed a file as
      // cwd — it is NOT wrapped in GitCommandError. This is the exact error
      // that used to be swallowed to `undefined`, masquerading as "not a repo".
      const raw = Object.assign(new Error('spawn ENOTDIR'), {
        code: 'ENOTDIR',
        errno: -20,
        syscall: 'spawn',
      });
      const classified: GitError = classifyGitCommandError(raw);
      assert.strictEqual(classified.kind, 'spawn-failed');
    });

    it('classifies a GitCommandError spawn failure (ENOENT, exitCode -1) as spawn-failed', () => {
      const err = new GitCommandError(
        'git',
        ['--version'],
        makeResult({ exitCode: -1, stderr: 'spawn git ENOENT' }),
        'Failed to execute git: spawn git ENOENT'
      );
      assert.strictEqual(classifyGitCommandError(err).kind, 'spawn-failed');
    });

    it('classifies a timeout GitCommandError as timeout', () => {
      const err = new GitCommandError(
        'git',
        ['log'],
        makeResult({ exitCode: -1 }),
        'Git command timed out'
      );
      assert.strictEqual(classifyGitCommandError(err).kind, 'timeout');
    });

    it('classifies a non-zero exit GitCommandError as command-failed with exitCode + stderr', () => {
      const err = new GitCommandError(
        'git',
        ['rev-parse', 'HEAD'],
        makeResult({ exitCode: 128, stderr: 'fatal: ambiguous argument' })
      );
      const classified = classifyGitCommandError(err);
      assert.strictEqual(classified.kind, 'command-failed');
      assert.ok(classified instanceof CommandFailedError);
      assert.strictEqual(classified.exitCode, 128);
      assert.ok(classified.stderr.includes('ambiguous'));
    });

    it('classifies a non-zero exit as command-failed EVEN when stderr mentions an errno token', () => {
      // A genuine git command failure (e.g. `git checkout` of a missing path)
      // can legitimately print ENOENT/ENOTDIR in its stderr. Because git DID
      // run and exit non-zero, it must classify as command-failed — sniffing
      // stderr for errno tokens would mis-tag it spawn-failed (the masquerade
      // in reverse).
      const err = new GitCommandError(
        'git',
        ['checkout', 'missing'],
        makeResult({ exitCode: 128, stderr: 'fatal: ... ENOENT: no such file ... ENOTDIR ...' })
      );
      const classified = classifyGitCommandError(err);
      assert.strictEqual(classified.kind, 'command-failed');
      assert.ok(classified instanceof CommandFailedError);
      assert.strictEqual(classified.exitCode, 128);
    });

    it('classifies an unknown thrown value as spawn-failed (never silently lost)', () => {
      assert.strictEqual(classifyGitCommandError('boom').kind, 'spawn-failed');
      assert.strictEqual(classifyGitCommandError(undefined).kind, 'spawn-failed');
    });
  });
});

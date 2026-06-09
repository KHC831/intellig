import * as assert from 'assert';
import { GitCli, GitCommandError, createGitCli } from '../../../git-core/gitCli';

describe('Git CLI Utilities', () => {
  let gitCli: GitCli;

  beforeEach(() => {
    gitCli = createGitCli();
  });

  afterEach(() => {
    gitCli.dispose();
  });

  describe('GitCli', () => {
    it('should create a GitCli instance with default path', () => {
      // The default `'git'` token is pre-resolved at construction time
      // to an absolute path (or left as `'git'` if resolution fails) —
      // a hardening fix for the `spawn git ENOENT` flake on Linux CI
      // under fork pressure. The test allows EITHER:
      //   - the bare `'git'` (resolution fell back, e.g. PATH-less env)
      //   - an absolute path ending in `/git` or `\git`
      // Both are correct outcomes of the constructor.
      const p = gitCli.gitPath;
      const isBare = p === 'git';
      const isAbsoluteEndingInGit =
        (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) && /(?:^|[\\/])git(?:\.exe)?$/.test(p);
      assert.ok(
        isBare || isAbsoluteEndingInGit,
        `default gitPath should be either 'git' or an absolute path to git; got: ${p}`
      );
    });

    it('should create a GitCli instance with custom path', () => {
      const customCli = new GitCli('/usr/local/bin/git');
      assert.strictEqual(customCli.gitPath, '/usr/local/bin/git');
      customCli.dispose();
    });

    it('should allow setting git path', () => {
      gitCli.gitPath = '/custom/git';
      assert.strictEqual(gitCli.gitPath, '/custom/git');
    });
  });

  describe('exec', () => {
    it('should execute git --version successfully', async () => {
      const result = await gitCli.exec(['--version']);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('git version'));
    });

    it('should return non-zero exit code for invalid command', async () => {
      const result = await gitCli.exec(['invalid-command-xyz']);

      assert.notStrictEqual(result.exitCode, 0);
    });

    // ─── ENOENT retry — Linux runner under fork pressure ───────────────
    //
    // libuv's `posix_spawnp` occasionally fails to find an executable
    // on PATH under fork pressure (GitHub Actions inside `xvfb-run`).
    // The constructor pre-resolves `'git'` to an absolute path; if the
    // spawn STILL fails with ENOENT past that, exec retries once after
    // a short delay. Pinning here so a future refactor can't silently
    // remove the retry and reintroduce the flake.
    it('retries up to two times with exponential backoff on ENOENT (regression for spawn-git-ENOENT flake)', async () => {
      // Make the gitPath point at a non-executable token that ENOENTs
      // on every attempt. The retry contract is: try once, retry up to
      // TWO times (50ms + 200ms backoff = ~250ms total), then surface
      // the error. The bogus-binary fixture lets us verify the timing
      // floor without needing real fork pressure.
      const cli = new GitCli('definitely-not-a-real-binary-xyz-abc-123');
      const beforeMs = Date.now();
      try {
        await cli.exec(['--version']);
        assert.fail('expected ENOENT to throw');
      } catch (err) {
        assert.ok(err instanceof GitCommandError, 'should be GitCommandError');
        assert.ok(
          /ENOENT/i.test(err.message),
          `error message should mention ENOENT; got: ${err.message}`
        );
      }
      // Two retries inject 50ms + 200ms = 250ms minimum. Tolerant
      // lower bound (200ms) for clock jitter; upper bound (1000ms)
      // catches a regression where retry count balloons or backoff
      // becomes pathological.
      const elapsed = Date.now() - beforeMs;
      assert.ok(
        elapsed >= 200,
        `expected >= 200ms (retry chain includes 50ms + 200ms backoff); got elapsed=${elapsed}ms`
      );
      assert.ok(elapsed < 1000, `expected < 1000ms (bounded retry); got elapsed=${elapsed}ms`);
      cli.dispose();
    });

    it('does NOT retry when the failure is non-ENOENT (e.g. invalid args, non-zero exit)', async () => {
      // A normal git invocation that returns a non-zero exit code MUST
      // NOT trigger the retry path — that would multiply the cost of
      // every failing command. Verify by timing: a normal git error
      // should complete WELL under 200ms (no retry backoff).
      const beforeMs = Date.now();
      try {
        await gitCli.execString(['definitely-not-a-real-git-subcommand-xyz']);
        // execString throws on non-zero exit, so we should not reach here.
        assert.fail('expected throw on invalid subcommand');
      } catch (err) {
        assert.ok(err instanceof GitCommandError);
      }
      const elapsed = Date.now() - beforeMs;
      // Upper bound generous enough for a busy CI runner but well
      // below the 50+200=250ms retry-chain floor. If this fires, the
      // retry guard has regressed.
      assert.ok(
        elapsed < 200,
        `expected non-ENOENT error to be fast (no retry); got elapsed=${elapsed}ms`
      );
    });

    it('fails fast with a clear message when cwd is missing (NOT a transient ENOENT — no retry)', async () => {
      // Pre-validation in `_spawnOnce` distinguishes "missing cwd"
      // from "missing binary": both produce ENOENT but the cwd case
      // is deterministic and we surface a clearer error to avoid
      // misleading the user. The retry path explicitly excludes
      // 'working directory missing' messages so failing-fast is the
      // contract.
      const beforeMs = Date.now();
      try {
        await gitCli.exec(['status'], { cwd: '/tmp/intellig-test-nonexistent-cwd-xyz-abc' });
        assert.fail('expected missing-cwd to throw');
      } catch (err) {
        assert.ok(err instanceof GitCommandError);
        assert.ok(
          /working directory missing/i.test(err.message),
          `expected "working directory missing" prefix; got: ${err.message}`
        );
      }
      const elapsed = Date.now() - beforeMs;
      // Must complete WELL under the 250ms ENOENT-retry floor —
      // missing-cwd is not retried.
      assert.ok(elapsed < 200, `missing-cwd must fail fast (no retry); got elapsed=${elapsed}ms`);
    });
  });

  describe('execString', () => {
    it('should return stdout on success', async () => {
      const result = await gitCli.execString(['--version']);

      assert.ok(result.includes('git version'));
    });

    it('should throw GitCommandError on failure', async () => {
      try {
        await gitCli.execString(['invalid-command-xyz']);
        assert.fail('Should have thrown an error');
      } catch (error) {
        assert.ok(error instanceof GitCommandError);
      }
    });
  });

  describe('isAvailable', () => {
    it('should return true when git is available', async () => {
      const result = await gitCli.isAvailable();
      assert.strictEqual(result, true);
    });
  });

  describe('getVersion', () => {
    it('should return git version string', async () => {
      const version = await gitCli.getVersion();

      assert.ok(version);
      assert.ok(/\d+\.\d+/.test(version));
    });
  });

  describe('GitCommandError', () => {
    it('should contain command information', () => {
      const result = {
        exitCode: 1,
        stdout: '',
        stderr: 'error message',
        combined: 'error message',
      };
      const error = new GitCommandError('git', ['status'], result);

      assert.strictEqual(error.command, 'git');
      assert.deepStrictEqual(error.args, ['status']);
      assert.strictEqual(error.result.exitCode, 1);
      assert.ok(error.message.includes('git status'));
    });

    it('should use custom message when provided', () => {
      const result = {
        exitCode: 1,
        stdout: '',
        stderr: '',
        combined: '',
      };
      const error = new GitCommandError('git', ['status'], result, 'Custom error');

      assert.strictEqual(error.message, 'Custom error');
    });
  });

  describe('onCommandExecuted event', () => {
    it('should fire event when command is executed', async () => {
      let eventFired = false;
      let capturedArgs: string[] = [];

      const disposable = gitCli.onCommandExecuted((event) => {
        eventFired = true;
        capturedArgs = event.args;
      });

      await gitCli.exec(['--version']);

      assert.strictEqual(eventFired, true);
      assert.deepStrictEqual(capturedArgs, ['--version']);

      disposable.dispose();
    });
  });
});

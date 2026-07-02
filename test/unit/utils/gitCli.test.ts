import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import {
  GitCli,
  GitCommandError,
  createGitCli,
  appendCapped,
  MAX_GIT_OUTPUT_BYTES,
  resolveGitTimeoutMs,
  NETWORK_GIT_TIMEOUT_MS,
  LOCAL_GIT_TIMEOUT_MS,
} from '../../../src/git-core/gitCli';

describe('appendCapped — runaway-output guard (crash regression)', () => {
  // Regression: on a huge repo, `stdout += chunk` grew past V8's max string
  // length and threw `RangeError: Invalid string length` inside the socket
  // data handler, crashing the extension host. appendCapped bounds growth so
  // a chunk can never push the accumulator past the cap.
  it('appends normally below the cap', () => {
    assert.strictEqual(appendCapped('foo', 'bar', 100), 'foobar');
  });

  it('never returns a string longer than the cap', () => {
    const out = appendCapped('a'.repeat(90), 'b'.repeat(50), 100);
    assert.ok(out.length <= 100, `expected <= 100, got ${out.length}`);
  });

  it('keeps the existing head and truncates the incoming overflow', () => {
    const out = appendCapped('a'.repeat(98), 'bbbb', 100);
    // Existing 98 a's preserved, only room for 2 more chars.
    assert.strictEqual(out, 'a'.repeat(98) + 'bb');
  });

  it('returns the accumulator unchanged once it is already at the cap', () => {
    const full = 'x'.repeat(100);
    assert.strictEqual(appendCapped(full, 'more', 100), full);
  });

  it('handles an oversized single chunk without throwing', () => {
    // Simulates one giant git data event.
    const out = appendCapped('', 'z'.repeat(1000), 100);
    assert.strictEqual(out.length, 100);
  });

  it('exposes a sane default cap (well under V8 max string length)', () => {
    assert.ok(MAX_GIT_OUTPUT_BYTES > 0 && MAX_GIT_OUTPUT_BYTES <= 256 * 1024 * 1024);
  });
});

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
    it('retries once after a short delay on ENOENT and succeeds (regression for spawn-git-ENOENT flake)', async () => {
      // Make the gitPath point at a non-executable token that resolves
      // to ENOENT on the first spawn. Then on the retry, swap it to a
      // valid binary.
      const cli = new GitCli('definitely-not-a-real-binary-xyz-abc-123');
      // First call should retry once, then fail (no real git on the
      // bogus path). Verify the failure shape so we know the retry
      // path was exercised — without retry, only ONE spawn attempt
      // would happen; with retry, TWO.
      const origExec = cli.exec.bind(cli);
      // Wrap exec via the public surface — count internal _spawnOnce
      // calls indirectly by counting onCommandExecuted events. (Each
      // spawn that completes — whether ENOENT or normal — fires the
      // event from the close handler. ENOENT fires from the error
      // handler instead and does NOT fire onCommandExecuted, so we
      // can't observe count via the event channel directly.)
      const beforeMs = Date.now();
      try {
        await origExec(['--version']);
        assert.fail('expected ENOENT to throw');
      } catch (err) {
        assert.ok(err instanceof GitCommandError, 'should be GitCommandError');
        assert.ok(
          /ENOENT/i.test(err.message),
          `error message should mention ENOENT; got: ${err.message}`
        );
      }
      // The retry inserts a 50ms backoff. We expect total elapsed >= 50ms
      // when ENOENT is hit. Tolerant lower bound (40ms) for clock jitter.
      const elapsed = Date.now() - beforeMs;
      assert.ok(
        elapsed >= 40,
        `expected >= 40ms (retry includes 50ms backoff); got elapsed=${elapsed}ms`
      );
      cli.dispose();
    });

    it('does NOT retry when the failure is non-ENOENT (e.g. invalid args, non-zero exit)', async () => {
      // A normal git invocation that returns a non-zero exit code MUST
      // NOT trigger the retry path — that would double the cost of every
      // failing command. Verify by timing: a normal git error should
      // complete WELL under 40ms (no retry backoff).
      const beforeMs = Date.now();
      try {
        await gitCli.execString(['definitely-not-a-real-git-subcommand-xyz']);
        // execString throws on non-zero exit, so we should not reach here.
        assert.fail('expected throw on invalid subcommand');
      } catch (err) {
        assert.ok(err instanceof GitCommandError);
      }
      const elapsed = Date.now() - beforeMs;
      // Generous upper bound (200ms) — non-ENOENT errors should never
      // pay the 50ms backoff penalty. If this fires, the retry guard
      // has been broken.
      assert.ok(
        elapsed < 200,
        `expected non-ENOENT error to be fast (no retry); got elapsed=${elapsed}ms`
      );
    });
  });

  describe('stdin input', () => {
    it('feeds provided input to the child stdin (git hash-object --stdin reads it)', async () => {
      // `git hash-object --stdin` hashes whatever it reads on stdin. A fixed
      // input yields a deterministic blob sha, proving the input reached the
      // child's stdin intact.
      const result = await gitCli.exec(['hash-object', '--stdin'], { input: 'hello\n' });
      assert.strictEqual(result.exitCode, 0);
      // Well-known git blob sha for "hello\n".
      assert.strictEqual(result.stdout.trim(), 'ce013625030ba8dba906f756967f9e9ca394464a');
    });

    it('closes stdin for an EMPTY input string (empty-buffer blame class)', async () => {
      // BlameService passes `input: contents` where contents can be `''`
      // (empty live buffer). A falsy check on `input` never closes stdin and
      // `git hash-object --stdin` (like `blame --contents -`) waits for EOF
      // until the timeout kills it. An explicit `!== undefined` gate must
      // close the pipe so the command completes with the empty-blob sha.
      const result = await gitCli.exec(['hash-object', '--stdin'], { input: '', timeout: 5000 });
      assert.strictEqual(result.exitCode, 0);
      // Well-known git blob sha for the empty blob.
      assert.strictEqual(result.stdout.trim(), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    });

    it('handles a stdin stream error (EPIPE) without an uncaught throw', async () => {
      // `git --version` ignores stdin and exits immediately, so a large write
      // races against a closed pipe and emits EPIPE on the child's stdin. The
      // wired `'error'` handler must swallow+log it; without the handler this
      // would surface as an uncaught async exception and crash the host (here:
      // the test process). exec still resolves from the child's `close` event.
      const big = 'x'.repeat(8 * 1024 * 1024);
      const result = await gitCli.exec(['--version'], { input: big });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('git version'));
      // Give any late async stdin 'error' a tick to fire; if unhandled it would
      // crash the process rather than reach this assertion.
      await new Promise((r) => setTimeout(r, 50));
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
    it('returns Ok with the git version string', async () => {
      const result = await gitCli.getVersion();

      assert.ok(result.isOk(), 'git --version should succeed');
      const version = result._unsafeUnwrap();
      assert.ok(/\d+\.\d+/.test(version));
    });
  });

  // ─── Result boundary: system error vs domain outcome ──────────────────
  //
  // The query methods return a neverthrow Result so a SYSTEM fault (a file
  // handed as cwd → spawn ENOTDIR, a bug) is distinguishable from a DOMAIN
  // outcome ("this dir is not a repo"), rather than swallowing EVERY failure
  // to `undefined`/`false` and conflating the two: a non-repo directory
  // is the expected absence (Ok(undefined) / Ok(false)), while a spawn fault
  // is a typed Err that can NEVER masquerade as "no repository".
  describe('getRepositoryRoot — Result boundary', () => {
    let tmpRoot: string;
    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-gitcli-root-'));
    });
    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('returns Ok(root) inside a real repository', async () => {
      execFileSync('git', ['init', '-q'], { cwd: tmpRoot });
      const result = await gitCli.getRepositoryRoot(tmpRoot);

      assert.ok(result.isOk());
      const root = result._unsafeUnwrap();
      assert.ok(root, 'expected a root path');
      // macOS routes os.tmpdir() through the /var → /private/var symlink, so
      // compare realpaths rather than raw strings.
      assert.strictEqual(fs.realpathSync(root), fs.realpathSync(tmpRoot));
    });

    it('returns Ok(undefined) for a real directory that is NOT a repo (domain absence)', async () => {
      const result = await gitCli.getRepositoryRoot(tmpRoot);

      assert.ok(result.isOk(), 'not-a-repo is an expected absence, not an error');
      assert.strictEqual(result._unsafeUnwrap(), undefined);
    });

    it('returns a typed spawn-failed Err for a FILE cwd (ENOTDIR) — NOT a silent not-a-repo', async () => {
      const filePath = path.join(tmpRoot, 'a-file.txt');
      fs.writeFileSync(filePath, 'hi');
      const result = await gitCli.getRepositoryRoot(filePath);

      assert.ok(result.isErr(), 'file cwd must be an Err, not Ok(undefined)');
      assert.strictEqual(result._unsafeUnwrapErr().kind, 'spawn-failed');
    });
  });

  describe('isRepository — Result boundary', () => {
    let tmpRoot: string;
    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-gitcli-isrepo-'));
    });
    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('returns Ok(true) inside a repo', async () => {
      execFileSync('git', ['init', '-q'], { cwd: tmpRoot });
      const result = await gitCli.isRepository(tmpRoot);

      assert.ok(result.isOk());
      assert.strictEqual(result._unsafeUnwrap(), true);
    });

    it('returns Ok(false) for a non-repo directory', async () => {
      const result = await gitCli.isRepository(tmpRoot);

      assert.ok(result.isOk());
      assert.strictEqual(result._unsafeUnwrap(), false);
    });

    it('returns a typed spawn-failed Err for a FILE cwd', async () => {
      const filePath = path.join(tmpRoot, 'f.txt');
      fs.writeFileSync(filePath, 'x');
      const result = await gitCli.isRepository(filePath);

      assert.ok(result.isErr());
      assert.strictEqual(result._unsafeUnwrapErr().kind, 'spawn-failed');
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

describe('resolveGitTimeoutMs — per-verb default bounds', () => {
  it('bounds network verbs (fetch/pull/push) at the network default', () => {
    assert.strictEqual(resolveGitTimeoutMs(['fetch', '--porcelain']), NETWORK_GIT_TIMEOUT_MS);
    assert.strictEqual(resolveGitTimeoutMs(['pull']), NETWORK_GIT_TIMEOUT_MS);
    assert.strictEqual(resolveGitTimeoutMs(['push', 'origin', 'main']), NETWORK_GIT_TIMEOUT_MS);
  });

  it('leaves clone and ls-remote UNBOUNDED (0)', () => {
    assert.strictEqual(resolveGitTimeoutMs(['clone', 'url', 'dir']), 0);
    assert.strictEqual(resolveGitTimeoutMs(['ls-remote', 'origin']), 0);
  });

  it('bounds local verbs at the (longer) local default', () => {
    assert.strictEqual(resolveGitTimeoutMs(['status', '--porcelain', '-z']), LOCAL_GIT_TIMEOUT_MS);
    assert.strictEqual(resolveGitTimeoutMs(['log', '--oneline']), LOCAL_GIT_TIMEOUT_MS);
  });

  it('skips a leading global flag to find the verb', () => {
    assert.strictEqual(
      resolveGitTimeoutMs(['--no-optional-locks', 'status', '--untracked-files=no']),
      LOCAL_GIT_TIMEOUT_MS
    );
  });

  it('skips a value-taking global flag and its value when finding the verb', () => {
    // `-c http.proxy=… fetch` must classify as the NETWORK verb `fetch`, not
    // read the config value as the verb (which fell to the local default).
    assert.strictEqual(
      resolveGitTimeoutMs(['-c', 'http.proxy=http://p', 'fetch', 'origin']),
      NETWORK_GIT_TIMEOUT_MS
    );
    assert.strictEqual(resolveGitTimeoutMs(['-C', '/some/path', 'pull']), NETWORK_GIT_TIMEOUT_MS);
  });

  it('an explicit timeout always wins — including 0 (opt-out) on a network verb', () => {
    assert.strictEqual(resolveGitTimeoutMs(['fetch'], 0), 0);
    assert.strictEqual(resolveGitTimeoutMs(['status'], 5000), 5000);
  });
});

describe('GitCli command timeout — kill machinery', () => {
  /** A controllable fake child: records kill signals and emits `close` only
   * when killed with a signal in `closeOn` (so a child can "ignore" SIGTERM). */
  class FakeChild extends EventEmitter {
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
    readonly stdin = Object.assign(new EventEmitter(), {
      write: (): boolean => true,
      end: (): void => {},
    });
    readonly killSignals: string[] = [];
    constructor(private readonly closeOn: Set<string>) {
      super();
    }
    kill(signal: string): boolean {
      this.killSignals.push(signal);
      if (this.closeOn.has(signal)) {
        setImmediate(() => this.emit('close', null));
      }
      return true;
    }
  }

  function cliWith(child: FakeChild): GitCli {
    return new GitCli('git', (() => child as unknown as ChildProcess) as never);
  }

  it('SIGTERM-kills a stalled command once its bound elapses and rejects with a timeout error', async () => {
    const child = new FakeChild(new Set(['SIGTERM']));
    await assert.rejects(() => cliWith(child).exec(['fetch'], { timeout: 20 }), /timed out/i);
    assert.deepStrictEqual(child.killSignals, ['SIGTERM']);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async function () {
    this.timeout(8000); // waits the real SIGTERM→SIGKILL grace
    const child = new FakeChild(new Set(['SIGKILL'])); // ignores SIGTERM
    await assert.rejects(() => cliWith(child).exec(['fetch'], { timeout: 20 }), /timed out/i);
    assert.deepStrictEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
  });

  it('does NOT arm a kill timer when timeout is explicitly 0', async () => {
    const child = new FakeChild(new Set()); // never self-closes
    const cli = cliWith(child);
    const pending = cli.exec(['fetch'], { timeout: 0 });
    await new Promise((r) => setTimeout(r, 60));
    assert.deepStrictEqual(child.killSignals, [], 'timeout:0 must not kill the child');
    child.emit('close', 0); // settle the never-ending command
    const result = await pending;
    assert.strictEqual(result.exitCode, 0);
  });

  it('does NOT bound a clone by default (unbounded verb)', async () => {
    const child = new FakeChild(new Set());
    const cli = cliWith(child);
    const pending = cli.exec(['clone', 'https://example.test/repo.git', 'dir']);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepStrictEqual(child.killSignals, [], 'clone must not be killed by a default timeout');
    child.emit('close', 0);
    const result = await pending;
    assert.strictEqual(result.exitCode, 0);
  });
});

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
      assert.strictEqual(gitCli.gitPath, 'git');
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

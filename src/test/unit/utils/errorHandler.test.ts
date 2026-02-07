/**
 * Unit tests for the error handler utility.
 */

import * as assert from 'assert';
import {
  categorizeGitError,
  GitErrorCategory,
  isNetworkError,
  isAuthenticationError,
  isConflictError,
  isUncommittedChangesError,
  formatErrorForLogging,
  formatUserFriendlyError,
  getRecoverySuggestions,
} from '../../../utils/errorHandler';
import { GitCommandError, IGitCommandResult } from '../../../utils/gitCli';

describe('Error Handler', () => {
  describe('categorizeGitError', () => {
    describe('Network Errors', () => {
      it('should categorize connection refused errors', () => {
        const error = new Error('fatal: unable to access: Connection refused');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Network);
        assert.ok(result.message.includes('network'));
        assert.ok(result.recoveryActions && result.recoveryActions.length > 0);
      });

      it('should categorize DNS resolution errors', () => {
        const error = new Error('fatal: Could not resolve host: github.com');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Network);
      });

      it('should categorize timeout errors', () => {
        const error = new Error('Connection timed out');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Network);
      });

      it('should categorize SSL certificate errors', () => {
        const error = new Error('SSL certificate problem: certificate verify failed');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Network);
      });
    });

    describe('Authentication Errors', () => {
      it('should categorize authentication failed errors', () => {
        const error = new Error('fatal: Authentication failed for https://github.com/repo.git');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Authentication);
        assert.ok(result.message.includes('Authentication'));
      });

      it('should categorize SSH permission denied errors', () => {
        const error = new Error('Permission denied (publickey)');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Authentication);
      });

      it('should categorize host key verification errors', () => {
        const error = new Error('Host key verification failed');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Authentication);
      });
    });

    describe('Conflict Errors', () => {
      it('should categorize merge conflict errors', () => {
        const error = new Error('CONFLICT (content): Merge conflict in file.txt');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Conflict);
        assert.ok(result.message.includes('conflict'));
      });

      it('should categorize automatic merge failed errors', () => {
        const error = new Error(
          'Automatic merge failed; fix conflicts and then commit the result.'
        );
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Conflict);
      });

      it('should categorize unmerged files errors', () => {
        const error = new Error('error: Pulling is not possible because you have unmerged files.');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Conflict);
      });
    });

    describe('Permission Errors', () => {
      it('should categorize permission denied errors', () => {
        const error = new Error('error: unable to create file: Permission denied');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Permission);
      });
    });

    describe('Repository Errors', () => {
      it('should categorize not a git repository errors', () => {
        const error = new Error(
          'fatal: not a git repository (or any of the parent directories): .git'
        );
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Repository);
        assert.ok(result.recoveryActions?.some((a) => a.commandId === 'git.init'));
      });

      it('should categorize corrupt repository errors', () => {
        const error = new Error('error: object file is empty or corrupt');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Repository);
      });
    });

    describe('Branch Errors', () => {
      it('should categorize branch already exists errors', () => {
        const error = new Error("fatal: A branch named 'feature' already exists.");
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Branch);
        assert.ok(result.message.includes('feature'));
      });

      it('should categorize branch not found errors', () => {
        const error = new Error("error: branch 'nonexistent' not found.");
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Branch);
      });

      it('should categorize cannot delete current branch errors', () => {
        const error = new Error(
          "error: Cannot delete the branch 'main' which you are currently on."
        );
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Branch);
      });

      it('should categorize unmerged branch errors', () => {
        const error = new Error("error: The branch 'feature' is not fully merged.");
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Branch);
      });
    });

    describe('Remote Errors', () => {
      it('should categorize push rejected errors', () => {
        const error = new Error('! [rejected] main -> main (non-fast-forward)');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Remote);
        assert.ok(result.message.includes('behind'));
      });

      it('should categorize no upstream branch errors', () => {
        const error = new Error('fatal: The current branch has no upstream branch.');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Remote);
      });

      it('should categorize remote already exists errors', () => {
        const error = new Error('fatal: remote origin already exists.');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Remote);
      });
    });

    describe('Uncommitted Changes Errors', () => {
      it('should categorize local changes would be overwritten errors', () => {
        const error = new Error(
          'error: Your local changes to the following files would be overwritten by checkout'
        );
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.UncommittedChanges);
        assert.ok(result.recoveryActions?.some((a) => a.label === 'Stash Changes'));
      });

      it('should categorize please commit or stash errors', () => {
        const error = new Error(
          'Please commit your changes or stash them before you switch branches.'
        );
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.UncommittedChanges);
      });
    });

    describe('Lock Errors', () => {
      it('should categorize lock file errors', () => {
        const error = new Error("fatal: Unable to create '/path/.git/index.lock': File exists.");
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Lock);
      });

      it('should categorize another git process errors', () => {
        const error = new Error('Another git process seems to be running in this repository');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Lock);
      });
    });

    describe('Invalid Input Errors', () => {
      it('should categorize empty commit message errors', () => {
        const error = new Error('Aborting commit due to empty commit message.');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.InvalidInput);
      });

      it('should categorize pathspec not found errors', () => {
        const error = new Error(
          "error: pathspec 'nonexistent.txt' did not match any file(s) known to git"
        );
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.InvalidInput);
        assert.ok(result.message.includes('nonexistent.txt'));
      });
    });

    describe('Git Not Found Errors', () => {
      it('should categorize git not found errors', () => {
        const error = new Error("'git' is not recognized as an internal or external command");
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.GitNotFound);
      });
    });

    describe('Unknown Errors', () => {
      it('should categorize unknown errors', () => {
        const error = new Error('Some completely unknown error message');
        const result = categorizeGitError(error);

        assert.strictEqual(result.category, GitErrorCategory.Unknown);
        assert.ok(result.recoveryActions && result.recoveryActions.length > 0);
      });
    });

    describe('GitCommandError handling', () => {
      it('should extract stderr from GitCommandError', () => {
        const result: IGitCommandResult = {
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: not a git repository',
          combined: 'fatal: not a git repository',
        };
        const error = new GitCommandError('git', ['status'], result);
        const categorized = categorizeGitError(error);

        assert.strictEqual(categorized.category, GitErrorCategory.Repository);
      });
    });
  });

  describe('Helper Functions', () => {
    describe('isNetworkError', () => {
      it('should return true for network errors', () => {
        assert.strictEqual(isNetworkError(new Error('Connection refused')), true);
      });

      it('should return false for non-network errors', () => {
        assert.strictEqual(isNetworkError(new Error('Authentication failed')), false);
      });
    });

    describe('isAuthenticationError', () => {
      it('should return true for authentication errors', () => {
        assert.strictEqual(isAuthenticationError(new Error('Authentication failed')), true);
      });

      it('should return false for non-authentication errors', () => {
        assert.strictEqual(isAuthenticationError(new Error('Connection refused')), false);
      });
    });

    describe('isConflictError', () => {
      it('should return true for conflict errors', () => {
        assert.strictEqual(isConflictError(new Error('CONFLICT in file.txt')), true);
      });

      it('should return false for non-conflict errors', () => {
        assert.strictEqual(isConflictError(new Error('Authentication failed')), false);
      });
    });

    describe('isUncommittedChangesError', () => {
      it('should return true for uncommitted changes errors', () => {
        assert.strictEqual(
          isUncommittedChangesError(new Error('Your local changes would be overwritten')),
          true
        );
      });

      it('should return false for non-uncommitted changes errors', () => {
        assert.strictEqual(isUncommittedChangesError(new Error('Authentication failed')), false);
      });
    });
  });

  describe('formatErrorForLogging', () => {
    it('should format error with category and message', () => {
      const error = new Error('fatal: not a git repository');
      const formatted = formatErrorForLogging(error);

      assert.ok(formatted.includes('[Git Error]'));
      assert.ok(formatted.includes('Category:'));
      assert.ok(formatted.includes('Message:'));
    });

    it('should include command details for GitCommandError', () => {
      const result: IGitCommandResult = {
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: not a git repository',
        combined: 'fatal: not a git repository',
      };
      const error = new GitCommandError('git', ['status'], result);
      const formatted = formatErrorForLogging(error);

      assert.ok(formatted.includes('Command:'));
      assert.ok(formatted.includes('Exit Code:'));
    });
  });

  describe('formatUserFriendlyError', () => {
    it('should return user-friendly message', () => {
      const error = new Error('fatal: not a git repository');
      const formatted = formatUserFriendlyError(error);

      assert.ok(formatted.includes('not a Git repository'));
    });

    it('should include recovery suggestions when requested', () => {
      const error = new Error('fatal: not a git repository');
      const formatted = formatUserFriendlyError(error, true);

      assert.ok(formatted.includes('Suggestions'));
    });

    it('should exclude recovery suggestions when not requested', () => {
      const error = new Error('fatal: not a git repository');
      const formatted = formatUserFriendlyError(error, false);

      assert.ok(!formatted.includes('Suggestions'));
    });
  });

  describe('getRecoverySuggestions', () => {
    it('should return suggestions for network errors', () => {
      const suggestions = getRecoverySuggestions(GitErrorCategory.Network);

      assert.ok(suggestions.length > 0);
      assert.ok(suggestions.some((s) => s.includes('connection')));
    });

    it('should return suggestions for authentication errors', () => {
      const suggestions = getRecoverySuggestions(GitErrorCategory.Authentication);

      assert.ok(suggestions.length > 0);
      assert.ok(suggestions.some((s) => s.includes('credentials') || s.includes('SSH')));
    });

    it('should return suggestions for conflict errors', () => {
      const suggestions = getRecoverySuggestions(GitErrorCategory.Conflict);

      assert.ok(suggestions.length > 0);
      assert.ok(suggestions.some((s) => s.includes('conflict')));
    });

    it('should return suggestions for unknown errors', () => {
      const suggestions = getRecoverySuggestions(GitErrorCategory.Unknown);

      assert.ok(suggestions.length > 0);
    });
  });
});

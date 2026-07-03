/**
 * IConflictResolutionResult.error / IOperationCompletionResult.error are
 * DISPLAY strings — several palette toasts render them raw
 * (rebaseConflictCommands accept/mark-resolved sites), bypassing the
 * toast-sanitizer guard which only sees `.message` interpolation. So the
 * strings must be sanitized at the SOURCE (where the service composes them
 * from raw git stderr / Error.message), not left to each consumer.
 */

import '../../setup';
import * as assert from 'assert';
import { ConflictResolutionService } from '../../../src/conflicts/ConflictResolutionService';
import { GitError, CommandFailedError } from '../../../src/git-core/errors';
import { errAsync } from 'neverthrow';
import { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';

const HOME_LEAK = 'error: unable to write /Users/alice/secret-project/.git/index.lock';

function makeRepo(): IRepository {
  return {
    rootUri: { fsPath: '/repo' },
    state: 'merging',
    head: { name: 'main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
  } as unknown as IRepository;
}

/** A git service whose stage fails with a home-path-leaking error. */
function makeGitService(): IGitService {
  return {
    gitCli: {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '', combined: '' }),
      onCommandExecuted: (): { dispose: () => void } => ({ dispose: (): void => {} }),
    },
    onDidChangeRepository: () => ({ dispose: (): void => {} }),
    getStatus: () => Promise.resolve([]),
    stage: () => errAsync<void, GitError>(new CommandFailedError(1, HOME_LEAK)),
  } as unknown as IGitService;
}

describe('ConflictResolutionService composes sanitized error strings', () => {
  it('scrubs a home path from acceptCurrent result.error', async () => {
    const service = new ConflictResolutionService(makeGitService(), {
      // Index writer that reports the side needs staging → stage() runs → fails.
      readStages: async () => new Map(),
      takeSide: async () => true,
      restoreConflict: async () => undefined,
    });
    try {
      const result = await service.acceptCurrent(makeRepo(), 'a.ts');
      assert.strictEqual(result.success, false);
      assert.ok(result.error, 'expected an error string');
      assert.ok(
        !result.error.includes('/Users/alice/'),
        `home path must be scrubbed at the source; got: "${result.error}"`
      );
      assert.ok(result.error.includes('~/'), 'the home dir should be rewritten to ~/');
    } finally {
      service.dispose();
    }
  });
});

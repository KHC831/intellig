/**
 * P1 #8 — Smart Reset (IntelliJ GitResetOperation parity).
 *
 * When a reset fails because local changes would be overwritten, IntelliJ
 * offers Stash and Reset / Force / Cancel (GitResetOperation.proposeSmartReset).
 * `isLocalChangesOverwriteError` detects that git failure; `runSmartReset` is
 * the pure orchestration over injected ops.
 */

import '../../setup';
import * as assert from 'assert';
import { runSmartReset, SmartResetUnstashConflict } from '../../../src/ui-shell/ResetDialog';
import { isLocalChangesOverwriteError } from '../../../src/git-core/gitProse';
import { ResetMode } from '../../../src/git-core/interfaces/IGitService';

describe('isLocalChangesOverwriteError (#8 smart reset detection)', () => {
  it('detects git’s "local changes would be overwritten" reset failure', () => {
    const msg =
      'error: Your local changes to the following files would be overwritten by reset:\n\tsrc/a.ts';
    assert.strictEqual(isLocalChangesOverwriteError(msg), true);
  });

  it('is false for unrelated git errors', () => {
    assert.strictEqual(isLocalChangesOverwriteError('fatal: bad revision'), false);
    assert.strictEqual(isLocalChangesOverwriteError(''), false);
  });
});

describe('runSmartReset (#8 stash / force / cancel)', () => {
  function makeOps(choice: 'stash' | 'force' | 'cancel') {
    const calls: string[] = [];
    return {
      calls,
      prompt: async () => choice,
      stash: async () => {
        calls.push('stash');
      },
      reset: async (mode: ResetMode) => {
        calls.push(`reset:${mode}`);
      },
      unstash: async () => {
        calls.push('unstash');
      },
    };
  }

  it('stash choice → stash, reset (same mode), unstash in order', async () => {
    const ops = makeOps('stash');
    const choice = await runSmartReset('keep', ops);
    assert.strictEqual(choice, 'stash');
    assert.deepStrictEqual(ops.calls, ['stash', 'reset:keep', 'unstash']);
  });

  it('force choice → a single hard reset, no stash', async () => {
    const ops = makeOps('force');
    const choice = await runSmartReset('keep', ops);
    assert.strictEqual(choice, 'force');
    assert.deepStrictEqual(ops.calls, ['reset:hard']);
  });

  it('cancel choice → nothing happens', async () => {
    const ops = makeOps('cancel');
    const choice = await runSmartReset('keep', ops);
    assert.strictEqual(choice, 'cancel');
    assert.deepStrictEqual(ops.calls, []);
  });

  it('wraps an unstash failure in SmartResetUnstashConflict (reset already ran)', async () => {
    const calls: string[] = [];
    const popError = new Error('CONFLICT (content): Merge conflict in src/a.ts');
    const ops = {
      prompt: async () => 'stash' as const,
      stash: async () => {
        calls.push('stash');
      },
      reset: async (mode: ResetMode) => {
        calls.push(`reset:${mode}`);
      },
      unstash: async () => {
        calls.push('unstash');
        throw popError;
      },
    };

    await assert.rejects(
      () => runSmartReset('keep', ops),
      (err: unknown) => {
        assert.ok(
          err instanceof SmartResetUnstashConflict,
          'an unstash failure must surface as SmartResetUnstashConflict, not the raw error'
        );
        assert.strictEqual(err.cause, popError, 'the original pop error is preserved as cause');
        return true;
      }
    );
    // The reset DID run before the failed pop — so HEAD has moved.
    assert.deepStrictEqual(calls, ['stash', 'reset:keep', 'unstash']);
  });

  it('does NOT wrap a reset failure (that is a genuine reset failure)', async () => {
    const resetError = new Error('error: reset failed');
    const ops = {
      prompt: async () => 'stash' as const,
      stash: async () => {},
      reset: async () => {
        throw resetError;
      },
      unstash: async () => {},
    };

    await assert.rejects(
      () => runSmartReset('keep', ops),
      (err: unknown) => {
        assert.ok(
          !(err instanceof SmartResetUnstashConflict),
          'a reset failure must propagate raw, not as an unstash conflict'
        );
        assert.strictEqual(err, resetError);
        return true;
      }
    );
  });
});

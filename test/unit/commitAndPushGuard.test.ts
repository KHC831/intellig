/**
 * Unit guard for the "Commit and Push" orchestration (slice A-1).
 *
 * IntelliJ's `GitCommitAndPushExecutor` (plugins/git4idea/backend/src/checkin/
 * GitCommitAndPushExecutor.kt) pushes ONLY after the commit — and its
 * before-commit checks — succeed: it requests sync commit checks and the
 * workflow performs the push as a post-commit step. A cancelled or failed
 * commit must NOT trigger a push.
 *
 * `commitThenPush` is the extracted, vscode-free orchestrator the
 * `intellig.commitAndPush` command delegates to. These tests pin the
 * failure-guard: push fires iff the commit reported `committed: true`.
 */

import '../setup';
import * as assert from 'assert';
import {
  commitAndPushFollowUp,
  commitThenPush,
} from '../../src/commands/registration/commitRepoCoreCommands';

describe('commitThenPush (A-1 commit-and-push guard)', () => {
  it('pushes after a successful commit', async () => {
    let pushed = false;
    const outcome = await commitThenPush(
      async () => ({ committed: true }),
      async () => {
        pushed = true;
      }
    );
    assert.strictEqual(pushed, true, 'push must run when the commit succeeded');
    assert.strictEqual(outcome.pushed, true);
  });

  it('does NOT push when the commit was cancelled/dismissed', async () => {
    let pushed = false;
    const outcome = await commitThenPush(
      async () => ({ committed: false }),
      async () => {
        pushed = true;
      }
    );
    assert.strictEqual(pushed, false, 'a cancelled commit must not push');
    assert.strictEqual(outcome.pushed, false);
  });

  it('does NOT push when the commit entry point returns no result', async () => {
    // The Commit tool-window path reveals the view and returns undefined
    // (the commit happens later, via the window's own button). No synchronous
    // commit result means no push.
    let pushed = false;
    const outcome = await commitThenPush(
      async () => undefined,
      async () => {
        pushed = true;
      }
    );
    assert.strictEqual(pushed, false, 'no commit result must not push');
    assert.strictEqual(outcome.pushed, false);
  });

  it('does NOT push when the commit throws / is blocked by before-commit checks', async () => {
    let pushed = false;
    await assert.rejects(
      commitThenPush(
        async () => {
          throw new Error('before-commit check blocked the commit');
        },
        async () => {
          pushed = true;
        }
      )
    );
    assert.strictEqual(pushed, false, 'a blocked/failed commit must not push');
  });
});

describe('commitAndPushFollowUp (tool-window reveal handoff)', () => {
  // In the default config `intellig.commit` reveals the Commit tool window
  // and returns undefined, so the chained push is (correctly) skipped — but
  // the user who asked for "Commit and Push" must be told where the push
  // went, or the second half of the command silently evaporates.
  it('directs the user to the panel button when the tool-window reveal swallowed the push', () => {
    const msg = commitAndPushFollowUp(false, true);
    assert.ok(msg, 'a follow-up toast is required');
    assert.ok(/commit and push/i.test(msg), `should name the panel button; got: "${msg}"`);
  });

  it('stays quiet when the push actually ran', () => {
    assert.strictEqual(commitAndPushFollowUp(true, true), undefined);
    assert.strictEqual(commitAndPushFollowUp(true, false), undefined);
  });

  it('stays quiet when the modal dialog path was taken (a cancelled commit is the user choice)', () => {
    assert.strictEqual(commitAndPushFollowUp(false, false), undefined);
  });
});

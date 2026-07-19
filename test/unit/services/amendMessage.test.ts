/**
 * Unit tests for the shared amend-message helper (amendMessage.ts) used by
 * both CommitDialog and CommitToolWindow (reference AmendCommitHandlerImpl):
 * enter-amend swaps HEAD's message in (saving the draft), exit-amend restores
 * the draft only when the amend message is unedited.
 */

import '../../setup';
import * as assert from 'assert';
import { AmendMessageTracker, loadHeadCommitMessage } from '../../../src/commits/amendMessage';
import type {
  IGitService,
  IRepository,
  ICommit,
} from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

function gitWithLog(impl: () => Promise<ICommit[]>): IGitService {
  return { getLog: impl } as unknown as IGitService;
}

describe('loadHeadCommitMessage', () => {
  it('joins subject and body with a blank line', async () => {
    const git = gitWithLog(async () => [{ message: 'subject', body: 'body text' } as ICommit]);
    assert.strictEqual(await loadHeadCommitMessage(git, makeRepo()), 'subject\n\nbody text');
  });

  it('returns the subject alone when HEAD has no body', async () => {
    const git = gitWithLog(async () => [{ message: 'subject only', body: '' } as ICommit]);
    assert.strictEqual(await loadHeadCommitMessage(git, makeRepo()), 'subject only');
  });

  it('returns undefined on an empty log (fresh repo)', async () => {
    const git = gitWithLog(async () => []);
    assert.strictEqual(await loadHeadCommitMessage(git, makeRepo()), undefined);
  });

  it('returns undefined when the log read throws (degrade, no prefill)', async () => {
    const git = gitWithLog(async () => {
      throw new Error('boom');
    });
    assert.strictEqual(await loadHeadCommitMessage(git, makeRepo()), undefined);
  });

  it('returns undefined without a repository', async () => {
    const git = gitWithLog(async () => [{ message: 'x', body: '' } as ICommit]);
    assert.strictEqual(await loadHeadCommitMessage(git, undefined), undefined);
  });
});

describe('AmendMessageTracker', () => {
  const loadHead = (msg: string | undefined) => async () => msg;

  it('enterAmend returns the HEAD message and saves the draft', async () => {
    const tracker = new AmendMessageTracker();
    assert.strictEqual(await tracker.enterAmend('draft', loadHead('head msg')), 'head msg');
    assert.strictEqual(tracker.exitAmend('head msg'), 'draft');
  });

  it('enterAmend leaves the composer untouched when HEAD has no message', async () => {
    const tracker = new AmendMessageTracker();
    assert.strictEqual(await tracker.enterAmend('draft', loadHead(undefined)), undefined);
  });

  it('enterAmend leaves the draft alone when HEAD has an empty message', async () => {
    // A commit made with --allow-empty-message reads back as '' (or as
    // whitespace). Swapping that in would silently erase the user's draft.
    const tracker = new AmendMessageTracker();
    assert.strictEqual(await tracker.enterAmend('draft', loadHead('')), undefined);
    assert.strictEqual(await tracker.enterAmend('draft', loadHead('   \n\n')), undefined);
  });

  it('a blank HEAD message leaves nothing to restore on exit', async () => {
    const tracker = new AmendMessageTracker();
    await tracker.enterAmend('draft', loadHead(''));
    assert.strictEqual(tracker.exitAmend('draft'), undefined, 'the draft was never replaced');
  });

  it('enterAmend is a no-op when the draft already equals the HEAD message', async () => {
    const tracker = new AmendMessageTracker();
    assert.strictEqual(await tracker.enterAmend('same', loadHead('same')), undefined);
  });

  it('exitAmend keeps user edits to the amend message (no restore)', async () => {
    const tracker = new AmendMessageTracker();
    await tracker.enterAmend('draft', loadHead('head msg'));
    assert.strictEqual(tracker.exitAmend('head msg edited'), undefined);
  });

  it('discards a HEAD load that a later toggle superseded', async () => {
    // Check then un-check while the HEAD read is still in flight. Applying the
    // late result would put HEAD's message in the composer with the draft gone,
    // and Commit would then create a NEW commit carrying HEAD's message.
    const tracker = new AmendMessageTracker();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const entering = tracker.enterAmend('draft', async () => {
      await gate;
      return 'head msg';
    });
    assert.strictEqual(tracker.exitAmend('draft'), undefined, 'nothing to restore yet');
    release();

    assert.strictEqual(
      await entering,
      undefined,
      'the superseded load must not reach the composer'
    );
    assert.strictEqual(
      tracker.exitAmend('draft'),
      undefined,
      'and it must not have recorded amend state either'
    );
  });

  it('exitAmend without a prior enter is a no-op', () => {
    const tracker = new AmendMessageTracker();
    assert.strictEqual(tracker.exitAmend('whatever'), undefined);
  });

  it('exitAmend consumes the saved draft (second exit is a no-op)', async () => {
    const tracker = new AmendMessageTracker();
    await tracker.enterAmend('draft', loadHead('head msg'));
    assert.strictEqual(tracker.exitAmend('head msg'), 'draft');
    assert.strictEqual(tracker.exitAmend('head msg'), undefined);
  });
});

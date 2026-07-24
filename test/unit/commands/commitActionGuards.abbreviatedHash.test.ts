/**
 * HEAD-containment guard must accept an abbreviated selection hash.
 *
 * `git merge-base` (and `GitService.getMergeBase`) always returns the FULL
 * 40-char SHA, while log-surface selections can carry an abbreviated hash —
 * the same class `undoCommit` defends against with a symmetric prefix match.
 * Exact equality reads "aaaaaaa" vs "aaaaaaa…a" as not-contained and wrongly
 * refuses a valid drop/squash/reword/interactive-rebase.
 */

import '../../setup';
import * as assert from 'assert';
import { isOldestInCurrentBranch } from '../../../src/commits/commitActionGuards';
import type { ICommitGuardsContext } from '../../../src/commits/commitActionGuards';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import type { GitCli } from '../../../src/git-core/gitCli';
import { Uri } from '../../mocks/vscode';
import { writableWindow } from '../../typed/windowStub';

const A_FULL = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE_FULL = 'dddddddddddddddddddddddddddddddddddddddd';

function createRepo(): IRepository {
  return { rootUri: Uri.file('/test-repo') } as unknown as IRepository;
}

/** Real-git shape: merge-base output is always the full SHA. */
function createCtx(mergeBaseResult: string): ICommitGuardsContext {
  return {
    gitService: {
      getMergeBase: async () => mergeBaseResult,
    } as unknown as IGitService,
    gitCli: {} as unknown as GitCli,
    readProtectedBranches: () => [],
  };
}

function captureErrors(): string[] {
  const errors: string[] = [];
  const w = writableWindow();
  w.showErrorMessage = ((msg: string) => {
    errors.push(msg);
    return Promise.resolve(undefined);
  }) as unknown as typeof w.showErrorMessage;
  return errors;
}

describe('isOldestInCurrentBranch with an abbreviated selection hash', () => {
  afterEach(() => {
    const w = writableWindow();
    w.showErrorMessage = () => Promise.resolve(undefined);
  });

  it('accepts a contained commit selected by its 7-char hash', async () => {
    const errors = captureErrors();
    const contained = await isOldestInCurrentBranch(
      createCtx(A_FULL),
      createRepo(),
      A_FULL.substring(0, 7)
    );
    assert.strictEqual(contained, true, 'abbreviated ancestor hash must be read as contained');
    assert.deepStrictEqual(errors, []);
  });

  it('still accepts the full-hash form', async () => {
    const errors = captureErrors();
    const contained = await isOldestInCurrentBranch(createCtx(A_FULL), createRepo(), A_FULL);
    assert.strictEqual(contained, true);
    assert.deepStrictEqual(errors, []);
  });

  it('still refuses an off-branch commit selected by its 7-char hash', async () => {
    const errors = captureErrors();
    // Off-branch: merge-base with HEAD is the common ancestor, not the commit.
    const contained = await isOldestInCurrentBranch(createCtx(BASE_FULL), createRepo(), 'bbbbbbb');
    assert.strictEqual(contained, false, 'off-branch commit must still be refused');
    assert.strictEqual(errors.length, 1);
    assert.ok(/not in the current branch/i.test(errors[0]));
  });
});

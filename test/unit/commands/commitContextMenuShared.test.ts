/**
 * Behavioural specs for the shared commit-menu helpers: the entry preamble's
 * guard ordering and the hash-tolerant matching predicate.
 */

import '../../setup';
import * as assert from 'assert';
import {
  hashesReferToSameCommit,
  resolveCommitSelection,
  type ICommitSelectionContext,
} from '../../../src/commits/commitContextMenuShared';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

const FULL = 'a'.repeat(40);

function createRepo(): IRepository {
  return { rootUri: Uri.file('/test-repo') } as unknown as IRepository;
}

describe('resolveCommitSelection', () => {
  it('probes cross-repo BEFORE hash validity so the cross-repo warning still fires', async () => {
    // The cross-repo probe owns a user-facing warning toast; a malformed
    // hash in the same selection must not short-circuit past it.
    let crossRepoProbed = false;
    const ctx: ICommitSelectionContext = {
      getRepositoryForCommit: async () => createRepo(),
      isCrossRepoSelection: () => {
        crossRepoProbed = true;
        return true;
      },
    };

    const repo = await resolveCommitSelection(ctx, [FULL, 'not-a-hash!']);

    assert.strictEqual(repo, undefined, 'a cross-repo selection must be refused');
    assert.strictEqual(
      crossRepoProbed,
      true,
      'the cross-repo probe (and its warning toast) must run before validity rejects'
    );
  });

  it('rejects a malformed single-repo selection without resolving a repo', async () => {
    let resolved = false;
    const ctx: ICommitSelectionContext = {
      getRepositoryForCommit: async () => {
        resolved = true;
        return createRepo();
      },
      isCrossRepoSelection: () => false,
    };

    const repo = await resolveCommitSelection(ctx, ['not-a-hash!']);

    assert.strictEqual(repo, undefined);
    assert.strictEqual(resolved, false, 'no repo lookup for malformed input');
  });

  it('rejects an empty selection', async () => {
    const ctx: ICommitSelectionContext = {
      getRepositoryForCommit: async () => createRepo(),
      isCrossRepoSelection: () => false,
    };
    assert.strictEqual(await resolveCommitSelection(ctx, []), undefined);
  });

  it('resolves the repo for a valid single-repo selection', async () => {
    const repo = createRepo();
    const ctx: ICommitSelectionContext = {
      getRepositoryForCommit: async () => repo,
      isCrossRepoSelection: () => false,
    };
    assert.strictEqual(await resolveCommitSelection(ctx, [FULL]), repo);
  });
});

describe('hashesReferToSameCommit', () => {
  it('matches identical full hashes', () => {
    assert.strictEqual(hashesReferToSameCommit(FULL, FULL), true);
  });

  it('matches an abbreviated hash against its full form, both directions', () => {
    assert.strictEqual(hashesReferToSameCommit(FULL.substring(0, 7), FULL), true);
    assert.strictEqual(hashesReferToSameCommit(FULL, FULL.substring(0, 7)), true);
  });

  it('rejects hashes of different commits', () => {
    assert.strictEqual(hashesReferToSameCommit('b'.repeat(40), FULL), false);
    assert.strictEqual(hashesReferToSameCommit('bbbbbbb', FULL), false);
  });
});

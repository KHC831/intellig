/**
 * Unit test: `updateContainingBranches` posts the "Contained in branches" list
 * for the expanded commit via a partial details-panel update.
 *
 * The branch list is fetched asynchronously after a commit is selected (so a
 * slow query never blocks the changed-files render). When it resolves the host
 * calls `updateContainingBranches(hash, branches)`, which must post a
 * `updateDetailsPanel` message whose model carries the branch names — and must
 * no-op when the user has since selected a different commit.
 */

import '../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import { ICommit, IAuthor } from '../../src/git-core/interfaces/IGitService';
import { Uri } from '../mocks/vscode';

interface IPostedMessage {
  type?: string;
  model?: { kind?: string; containingBranches?: string[] | null };
  [key: string]: unknown;
}

const AUTHOR: IAuthor = { name: 'tester', email: 't@example.com' };

function mkCommit(hash: string, message: string): ICommit {
  const date = new Date(2020, 0, 1);
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message,
    author: AUTHOR,
    committer: AUTHOR,
    parents: [],
    authorDate: date,
    commitDate: date,
  };
}

describe('Contained in branches — updateContainingBranches wiring', () => {
  let provider: GitToolWindowProvider;
  let posted: IPostedMessage[];
  const hash = '1111111111111111111111111111111111111111';

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    posted = [];

    provider.updateLogState([mkCommit(hash, 'tip commit')], new Map(), new Map());

    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
    const internals = provider as any;
    internals._extendedLogState.expandedCommit = hash;
    internals._view = {
      webview: {
        get html(): string {
          return '';
        },
        set html(_v: string) {},
        options: {},
        cspSource: 'test:',
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: (message: IPostedMessage) => {
          posted.push(message);
          return Promise.resolve(true);
        },
        asWebviewUri: (u: unknown) => u,
      },
      visible: true,
      onDidChangeVisibility: () => ({ dispose: () => {} }),
      onDidDispose: () => ({ dispose: () => {} }),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
  });

  afterEach(() => {
    provider.dispose();
  });

  it('posts an updateDetailsPanel model carrying the branch list for the expanded commit', () => {
    provider.updateContainingBranches(hash, ['dev', 'main']);

    const msg = posted.find((m) => m.type === 'updateDetailsPanel');
    assert.ok(msg, 'an updateDetailsPanel message must be posted');
    assert.strictEqual(msg?.model?.kind, 'single');
    assert.deepStrictEqual(msg?.model?.containingBranches, ['dev', 'main']);
  });

  it('posts an empty branch list (commit in no branch) as [] not loading', () => {
    provider.updateContainingBranches(hash, []);

    const msg = posted.find((m) => m.type === 'updateDetailsPanel');
    assert.deepStrictEqual(msg?.model?.containingBranches, []);
  });

  it('no-ops when the resolved hash is no longer the expanded commit', () => {
    provider.updateContainingBranches('2222222222222222222222222222222222222222', ['main']);

    assert.strictEqual(
      posted.find((m) => m.type === 'updateDetailsPanel'),
      undefined,
      'a stale branch result must not post a details update'
    );
  });
});

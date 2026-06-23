/**
 * Unit test: a plain commit click triggers ONLY partial updates — never a full
 * webview re-render.
 *
 * A full re-render (`_render`, which reassigns `view.webview.html`) rebuilds the
 * entire DOM and discards every live client-side-only piece of state: the user's
 * dragged column widths (`--col-author-width` / `--col-date-width` on
 * `.graph-panel`), the dragged graph/details divider (`panel.style.width`), and
 * scroll position. The reported bug — "the divider AND the Title/Author/Date
 * columns snap back to default on EVERY commit click" — is exactly the signature
 * of a full re-render leaking into the plain-select path.
 *
 * This test drives the real inbound dispatch (`_handleWebviewMessage` with a
 * `{ type: 'selectCommit' }` message, which is what a plain row click posts) and
 * asserts the host performs NO full re-render (`view.webview.html` is never
 * reassigned) and posts only partial-update message types. It is both the
 * "what does a click trigger" probe the diagnosis needed and a standing
 * regression guard against the reset-on-select class.
 */

import '../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import { ICommit, IAuthor } from '../../src/git-core/interfaces/IGitService';
import { Uri } from '../mocks/vscode';
import { invokePrivateHandler } from '../typed/privateHandler';

interface IPostedMessage {
  type?: string;
  commitHash?: string;
  [key: string]: unknown;
}

/**
 * Message types the partial plain-select path is allowed to post:
 *   - selectGraphRow / updateDetailsPanel — the in-place selection + details
 *     refresh from `selectCommit`.
 *   - updateMenuEnableState — `_postMenuStateUpdate` recomputing context-menu
 *     enablement for the new selection.
 */
const ALLOWED_PARTIAL_MESSAGE_TYPES = new Set<string>([
  'selectGraphRow',
  'updateDetailsPanel',
  'updateMenuEnableState',
]);

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

describe('plain commit click — partial update only, no full re-render', () => {
  let provider: GitToolWindowProvider;
  let posted: IPostedMessage[];
  let htmlSetCount: number;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    posted = [];
    htmlSetCount = 0;
  });

  afterEach(() => {
    provider.dispose();
  });

  it('selecting a commit does NOT reassign webview.html (the thing that resets dragged widths/scroll)', () => {
    const hashA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const hashB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    // Seed state BEFORE wiring the view so updateLogState's internal render
    // no-ops (no view yet) and doesn't pollute the html/postMessage taps.
    provider.updateLogState(
      [mkCommit(hashA, 'commit a'), mkCommit(hashB, 'commit b')],
      new Map(),
      new Map(),
      hashA
    );

    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
    const internals = provider as any;
    let htmlBacking = '';
    internals._view = {
      webview: {
        get html(): string {
          return htmlBacking;
        },
        set html(v: string) {
          htmlSetCount += 1;
          htmlBacking = v;
        },
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

    // Act: simulate a plain row click — the message a plain click posts.
    void invokePrivateHandler(provider, '_handleWebviewMessage', {
      type: 'selectCommit',
      commitHash: hashB,
    });

    // The crux: no full re-render. A reassignment of webview.html is what would
    // wipe the user's dragged column/divider widths back to default.
    assert.strictEqual(
      htmlSetCount,
      0,
      'a plain commit click must NOT reassign view.webview.html (no full re-render)'
    );

    // Every posted message must be a partial-update type.
    for (const m of posted) {
      assert.ok(
        m.type !== undefined && ALLOWED_PARTIAL_MESSAGE_TYPES.has(m.type),
        `plain click posted an unexpected (non-partial) message type: "${String(m.type)}"`
      );
    }

    // And the selection actually moved to the clicked commit.
    const state = provider.getExtendedLogState();
    assert.strictEqual(state.expandedCommit, hashB, 'clicked commit becomes the expanded commit');
    assert.ok(state.selectedCommits.has(hashB), 'clicked commit is selected');
  });
});

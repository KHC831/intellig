/**
 * Incoming tab interaction wiring.
 *
 * IncomingTab.handleMessage has always handled `incoming.selectCommit` and
 * `incoming.jumpToCommit`, but the webview posted neither — the rows were inert
 * and both handlers were unreachable. These boot the REAL bundled entry over the
 * REAL rendered body and assert a click/double-click reaches the host, so the
 * handlers stay wired end to end.
 */

import '../../setup';
import * as assert from 'assert';
import { bootWebviewEntry, type IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import { renderIncomingTabBody } from '../../../src/git-core/gitToolWindow/html/incomingHtml';
import type { IIncomingTabState } from '../../../src/git-core/gitToolWindow/tabs/IncomingTab';
import type { ICommit } from '../../../src/git-core/interfaces/IGitService';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';
const HASH = 'abc1234def5678abc1234def5678abc1234def56';

function makeCommit(hash: string): ICommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: 'Incoming change',
    author: { name: 'Alice', email: 'alice@example.com' },
    committer: { name: 'Alice', email: 'alice@example.com' },
    parents: [],
    authorDate: new Date('2026-06-01T12:00:00Z'),
    commitDate: new Date('2026-06-01T12:00:00Z'),
  } as unknown as ICommit;
}

function incomingState(): IIncomingTabState {
  return {
    branch: 'main',
    upstream: 'origin/main',
    incomingCount: 1,
    outgoingCount: 0,
    noUpstream: false,
    commits: [makeCommit(HASH)],
    selectedCommit: undefined,
    error: undefined,
    loading: false,
  };
}

const harnesses: IWebviewEntryHarness[] = [];
afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.dispose();
  }
});

function bootWithIncomingBody(): IWebviewEntryHarness {
  const harness = bootWebviewEntry(ENTRY, { bodyHtml: renderIncomingTabBody(incomingState()) });
  harnesses.push(harness);
  return harness;
}

/** Dispatch a bubbling mouse event of `type` on the first incoming row. */
function fireOnRow(harness: IWebviewEntryHarness, type: 'click' | 'dblclick'): void {
  const row = harness.document.querySelector('.incoming-commit-row');
  assert.ok(row, 'sanity: the rendered body has an incoming row');
  row.dispatchEvent(new harness.window.MouseEvent(type, { bubbles: true }));
}

describe('Incoming tab row interaction', () => {
  it('a row click posts incoming.selectCommit with the full hash', () => {
    const harness = bootWithIncomingBody();

    fireOnRow(harness, 'click');

    assert.deepStrictEqual(
      harness.posted.filter((m) => (m as { type?: string }).type === 'incoming.selectCommit'),
      [{ type: 'incoming.selectCommit', hash: HASH }]
    );
  });

  it('a row double-click posts incoming.jumpToCommit with the full hash', () => {
    const harness = bootWithIncomingBody();

    fireOnRow(harness, 'dblclick');

    assert.deepStrictEqual(
      harness.posted.filter((m) => (m as { type?: string }).type === 'incoming.jumpToCommit'),
      [{ type: 'incoming.jumpToCommit', hash: HASH }]
    );
  });

  it('boots without error when no incoming rows are present', () => {
    const harness = bootWebviewEntry(ENTRY, { bodyHtml: '<div class="incoming-tab-body"></div>' });
    harnesses.push(harness);

    assert.deepStrictEqual(harness.errors, []);
  });
});

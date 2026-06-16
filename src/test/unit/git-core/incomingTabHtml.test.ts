/**
 * Unit tests for renderIncomingTabBody (Gap A — incoming tab real HTML).
 *
 * Spec (red-first per TDD contract):
 *   1. undefined state  → renders without crashing, returns non-empty HTML
 *   2. loading:true     → rendered HTML contains a loading indicator
 *   3. noUpstream:true  → rendered HTML mentions "no upstream" / "no tracking"
 *   4. commits:[], not loading, not noUpstream → rendered HTML indicates in-sync
 *   5. commits:[{…}]    → rendered HTML shows short hash + subject
 */

import '../../setup';
import * as assert from 'assert';
import { renderIncomingTabBody } from '../../../git-core/gitToolWindow/html/incomingHtml';
import type { IIncomingTabState } from '../../../git-core/gitToolWindow/tabs/IncomingTab';
import type { ICommit } from '../../../git-core/interfaces/IGitService';

function makeCommit(hash: string, subject: string): ICommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: subject,
    author: { name: 'Test Author', email: 'test@example.com' },
    committer: { name: 'Test Author', email: 'test@example.com' },
    parents: [],
    authorDate: new Date('2026-06-01T12:00:00Z'),
    commitDate: new Date('2026-06-01T12:00:00Z'),
  };
}

function baseState(overrides: Partial<IIncomingTabState> = {}): IIncomingTabState {
  return {
    branch: 'main',
    upstream: 'origin/main',
    incomingCount: 0,
    outgoingCount: 0,
    noUpstream: false,
    commits: [],
    selectedCommit: undefined,
    error: undefined,
    loading: false,
    ...overrides,
  };
}

describe('renderIncomingTabBody', () => {
  it('undefined state — renders non-empty HTML without throwing', () => {
    const html = renderIncomingTabBody(undefined);
    assert.ok(typeof html === 'string' && html.trim().length > 0, 'HTML must be non-empty');
  });

  it('loading:true — rendered HTML contains a loading indicator', () => {
    const html = renderIncomingTabBody(baseState({ loading: true }));
    // Accept any of: "loading", spinner class, or ellipsis
    assert.ok(/loading|spinner|…/i.test(html), `Expected a loading indicator in:\n${html}`);
  });

  it('noUpstream:true — rendered HTML mentions no-upstream / no-tracking situation', () => {
    const html = renderIncomingTabBody(baseState({ noUpstream: true, upstream: undefined }));
    assert.ok(/upstream|tracking/i.test(html), `Expected an upstream-absent message in:\n${html}`);
  });

  it('empty commits, not loading, not noUpstream — rendered HTML indicates in-sync / up-to-date', () => {
    const html = renderIncomingTabBody(
      baseState({ commits: [], loading: false, noUpstream: false })
    );
    assert.ok(
      /up.?to.?date|in.?sync|no incoming/i.test(html),
      `Expected an up-to-date message in:\n${html}`
    );
  });

  it('commits:[commit] — rendered HTML contains short hash and subject', () => {
    const hash = 'abc1234567890def1234567890def1234567890de';
    const subject = 'fix: resolve critical bug in parser';
    const html = renderIncomingTabBody(
      baseState({
        commits: [makeCommit(hash, subject)],
        incomingCount: 1,
      })
    );
    // Short hash is first 7 chars
    assert.ok(html.includes('abc1234'), `Expected short hash "abc1234" in:\n${html}`);
    assert.ok(html.includes(subject), `Expected commit subject "${subject}" in:\n${html}`);
  });
});

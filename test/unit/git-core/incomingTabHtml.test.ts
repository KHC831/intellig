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
import {
  renderIncomingTabBody,
  incomingTabStyles,
} from '../../../src/git-core/gitToolWindow/html/incomingHtml';
import type { IIncomingTabState } from '../../../src/git-core/gitToolWindow/tabs/IncomingTab';
import type { ICommit } from '../../../src/git-core/interfaces/IGitService';

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

/**
 * The Incoming tab shipped classed markup with no stylesheet at all, so every
 * row rendered as run-together unstyled spans while sibling tabs looked right.
 * These pin that the tab owns rules for the classes it emits, that the rows
 * carry the data/list semantics the webview and screen readers need, and that
 * the empty state uses classes something actually defines.
 */
/** A populated (non-loading, has-upstream) incoming state. */
function makeLoadedState(overrides: Partial<IIncomingTabState> = {}): IIncomingTabState {
  return {
    branch: 'main',
    upstream: 'origin/main',
    incomingCount: 2,
    outgoingCount: 0,
    noUpstream: false,
    commits: [makeCommit('abc1234def5678', 'Add feature'), makeCommit('99f0000aaaa111', 'Fix bug')],
    selectedCommit: undefined,
    error: undefined,
    loading: false,
    ...overrides,
  };
}

describe('incoming tab styling + semantics', () => {
  it('defines a rule for every incoming-* class the renderer emits', () => {
    const state = makeLoadedState();
    const emitted = new Set(
      [...renderIncomingTabBody(state).matchAll(/class="([^"]+)"/g)]
        .flatMap((m) => m[1].split(/\s+/))
        .filter((c) => c.startsWith('incoming-'))
    );
    const css = incomingTabStyles();

    const unstyled = [...emitted].filter((c) => !css.includes(`.${c}`));
    assert.deepStrictEqual(
      unstyled,
      [],
      `classes emitted with no CSS rule: ${unstyled.join(', ')}`
    );
  });

  it('gives each commit row role=listitem inside the role=list container', () => {
    const state = makeLoadedState();

    const html = renderIncomingTabBody(state);

    assert.match(html, /role="list"/);
    assert.match(html, /class="incoming-commit-row"[^>]*role="listitem"/);
  });

  it('carries the full hash on each row so the webview can post a selection', () => {
    assert.match(renderIncomingTabBody(makeLoadedState()), /data-hash="abc1234def5678"/);
  });

  it('marks the selected row so the selection is visible', () => {
    const state = makeLoadedState({ selectedCommit: 'abc1234def5678' });

    const html = renderIncomingTabBody(state);

    assert.match(
      html,
      /class="incoming-commit-row incoming-selected"[^>]*data-hash="abc1234def5678"/,
      `the selected row must carry the class the stylesheet paints:\n${html}`
    );
  });

  it('marks only the selected row', () => {
    const state = makeLoadedState({ selectedCommit: 'abc1234def5678' });

    const html = renderIncomingTabBody(state);

    assert.strictEqual(
      (html.match(/incoming-selected/g) ?? []).length,
      1,
      'exactly one row is selected'
    );
  });

  it('marks no row when nothing is selected', () => {
    assert.ok(!renderIncomingTabBody(makeLoadedState()).includes('incoming-selected'));
  });
});

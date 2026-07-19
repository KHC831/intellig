/**
 * The log filter's search query has ONE source of truth: the search box.
 *
 * Host side, the in-flight draft used to outrank the applied filter forever,
 * so the box could display a query the active filter did not contain.
 * Webview side, only the Enter handler copied the box into `filterState`, so
 * the other filter gestures (regex/case toggles, author, branch, date) applied
 * a stale or empty query.
 */

import '../../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GitToolWindowProvider } from '../../../../src/ui-shell/GitToolWindowProvider';
import { Uri } from '../../../mocks/vscode';

const ENTRY_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../../../src/git-core/gitToolWindow/webview/gitToolWindow.ts'),
  'utf8'
);

interface Internals {
  _searchDraft?: string;
  _handleWebviewMessage(message: Record<string, unknown>): void;
}

describe('log filter search — host draft reconciliation', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  it('clears the in-flight draft once a filter is applied', () => {
    const internals = provider as unknown as Internals;
    internals._handleWebviewMessage({ type: 'logSearchDraft', text: 'half-typed' });
    assert.strictEqual(internals._searchDraft, 'half-typed', 'sanity: the draft was remembered');

    internals._handleWebviewMessage({
      type: 'applyLogFilter',
      filter: { searchText: 'committed' },
    });

    assert.strictEqual(
      internals._searchDraft,
      undefined,
      'applying a filter spends the draft that produced it'
    );
  });

  it('the box never shows text the active filter lacks', () => {
    const internals = provider as unknown as Internals;
    internals._handleWebviewMessage({ type: 'logSearchDraft', text: 'stale-draft' });

    internals._handleWebviewMessage({ type: 'applyLogFilter', filter: { searchText: 'applied' } });
    const html = provider._getLogFilterRowHtml();

    assert.ok(html.includes('applied'), 'the applied query is what the box shows');
    assert.ok(!html.includes('stale-draft'), 'the spent draft is gone');
  });

  it('clearing the filter leaves no draft behind either', () => {
    const internals = provider as unknown as Internals;
    internals._handleWebviewMessage({ type: 'logSearchDraft', text: 'leftover' });

    internals._handleWebviewMessage({ type: 'applyLogFilter', filter: null });

    assert.ok(!provider._getLogFilterRowHtml().includes('leftover'));
  });
});

describe('log filter search — webview reads the box on every apply', () => {
  it('applyFilters adopts the box text rather than a separately-written field', () => {
    // The regression shape: `searchText: filterState.searchText` with the only
    // writer being the Enter handler, so eight of nine apply sites sent a
    // stale value. Applying must read the input itself.
    const start = ENTRY_SOURCE.indexOf('function applyFilters()');
    assert.ok(start > 0, 'sanity: applyFilters was located in the entry source');
    const applyFn = ENTRY_SOURCE.slice(start, ENTRY_SOURCE.indexOf('function ', start + 10));
    assert.ok(
      /commitSearchText\(\)/.test(applyFn),
      'applyFilters must commit the search box before posting the filter'
    );
  });

  it('the commit helper reads the live input element', () => {
    const helper =
      /function commitSearchText\(\)[\s\S]{0,400}?\n {4}\}/.exec(ENTRY_SOURCE)?.[0] ?? '';
    assert.ok(helper.length > 0, 'sanity: commitSearchText exists');
    assert.ok(/filter-search/.test(helper), 'it reads the search input by id');
    assert.ok(
      /filterState\.searchText\s*=/.test(helper),
      'it writes the adopted text back into filter state'
    );
    assert.ok(
      /if\s*\(el\)/.test(helper),
      'a missing input must not wipe a programmatically applied query'
    );
  });

  it('no apply site writes searchText on its own any more', () => {
    // One writer keeps the box and the applied filter from drifting apart.
    const writers = ENTRY_SOURCE.match(/filterState\.searchText\s*=/g) ?? [];
    assert.strictEqual(
      writers.length,
      1,
      `searchText must have exactly one writer (found ${writers.length})`
    );
  });
});

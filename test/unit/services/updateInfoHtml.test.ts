/**
 * Update Info tab renderer — turns an IUpdateInfoTabState (the post-Update-
 * Project summary) into the tab body. Mirrors git4idea's Update Info tree.
 */

import '../../setup';
import * as assert from 'assert';
import {
  renderUpdateInfoTabBody,
  updateInfoTabStyles,
} from '../../../src/git-core/gitToolWindow/html/updateInfoHtml';
import { summarizeUpdate } from '../../../src/sync/updateProject';

describe('renderUpdateInfoTabBody', () => {
  it('shows an empty state before any update has run', () => {
    const empty = renderUpdateInfoTabBody();
    assert.match(empty, /no update/i);
    assert.doesNotMatch(empty, /coming soon/i, 'the placeholder stub must be gone');
  });

  it('renders a per-repo row with branch, strategy, incoming count and status', () => {
    const state = {
      summary: summarizeUpdate('rebase', [
        {
          name: 'alpha',
          rootPath: '/repos/alpha',
          branch: 'main',
          rebase: true,
          incoming: 3,
          status: 'updated' as const,
        },
      ]),
    };
    const html = renderUpdateInfoTabBody(state);
    assert.match(html, /alpha/);
    assert.match(html, /main/);
    assert.match(html, /rebase/i);
    assert.match(html, /3/);
    assert.match(html, /updated/i);
    // Headline present.
    assert.match(html, /1 commit|3 commit|Updated/i);
  });

  it('surfaces a conflict / error repo with its detail', () => {
    const state = {
      summary: summarizeUpdate('merge', [
        {
          name: 'beta',
          rootPath: '/repos/beta',
          branch: 'dev',
          rebase: false,
          incoming: 0,
          status: 'error' as const,
          detail: 'refusing to merge unrelated histories',
        },
      ]),
    };
    const html = renderUpdateInfoTabBody(state);
    assert.match(html, /beta/);
    assert.match(html, /error/i);
    assert.match(html, /unrelated histories/);
  });

  it('escapes repo names, branches and details (no HTML injection)', () => {
    const state = {
      summary: summarizeUpdate('merge', [
        {
          name: '<img src=x>',
          rootPath: '/r',
          branch: '<b>',
          rebase: false,
          incoming: 0,
          status: 'error' as const,
          detail: '<script>alert(1)</script>',
        },
      ]),
    };
    const html = renderUpdateInfoTabBody(state);
    assert.doesNotMatch(html, /<img src=x>/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;img/);
  });

  it('exposes tab styles as a non-empty string', () => {
    assert.ok(updateInfoTabStyles().length > 0);
  });
});

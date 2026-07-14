/**
 * Branch-focus partial-update DOM path.
 *
 * `setFocusedBranch` posts an `updateBranchFocus` message so the chip
 * outline lands WITHOUT a full DOM rebuild. The inline script's message
 * handler toggles `branch-label-focused` on every branch chip matching
 * `data-branch-name`. The selector MUST cover all three chip kinds —
 * local, remote, AND the current-branch chip (.branch-label-head) —
 * because the current branch can ALSO be the focused branch
 * (focusedBranchName and headBranchName are independent). This suite
 * executes the real inline script in jsdom and drives the message path so
 * the head-chip case is pinned at the partial-update layer, not just via
 * the full re-render.
 */

import '../../../setup';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../../helpers/bootWebviewEntry';

const BODY = `
  <div class="graph-panel" aria-multiselectable="true" data-selected-count="0">
    <span class="branch-label-head" data-branch-name="main"><i class="codicon codicon-git-branch"></i>main</span>
    <span class="branch-label-local" data-branch-name="feature"><i class="codicon codicon-git-branch"></i>feature</span>
    <span class="branch-label-remote" data-branch-name="origin/main"><i class="codicon codicon-git-branch"></i>origin/main</span>
  </div>`;

let harness: IWebviewEntryHarness;

/** Boot the entry over one chip of each branch-chip kind. */
function bootDom(): { window: IWebviewEntryHarness['window']; document: Document } {
  harness = bootWebviewEntry('git-core/gitToolWindow/webview/gitToolWindow', { bodyHtml: BODY });
  return { window: harness.window, document: harness.document };
}

function postFocus(window: IWebviewEntryHarness['window'], focusedBranchName: string | null): void {
  const evt = new window.MessageEvent('message', {
    data: { type: 'updateBranchFocus', focusedBranchName, focusedHash: null },
  });
  window.dispatchEvent(evt);
}

describe('Branch-focus partial-update — updateBranchFocus DOM toggle', () => {
  afterEach(() => {
    if (harness) {
      harness.dispose();
    }
  });

  it('adds branch-label-focused to the CURRENT-branch (.branch-label-head) chip when it is focused', () => {
    const { window, document } = bootDom();
    const headChip = document.querySelector('.branch-label-head')!;
    assert.ok(!headChip.classList.contains('branch-label-focused'), 'head chip starts unfocused');

    // Focus the current branch (focusedBranchName === headBranchName case).
    postFocus(window, 'main');

    assert.ok(
      headChip.classList.contains('branch-label-focused'),
      'the current-branch chip must gain branch-label-focused via the partial path (regression: selector omitted .branch-label-head)'
    );
  });

  it('removes branch-label-focused from the current-branch chip when focus moves away', () => {
    const { window, document } = bootDom();
    const headChip = document.querySelector('.branch-label-head')!;

    postFocus(window, 'main');
    assert.ok(headChip.classList.contains('branch-label-focused'), 'focused first');

    // Focus a different branch — the head chip must lose the class.
    postFocus(window, 'feature');
    assert.ok(
      !headChip.classList.contains('branch-label-focused'),
      'the current-branch chip must lose branch-label-focused when focus moves away'
    );
    assert.ok(
      document.querySelector('.branch-label-local')!.classList.contains('branch-label-focused'),
      'the now-focused local chip gains the class'
    );
  });

  it('clears the focus class from all chip kinds on updateBranchFocus(null)', () => {
    const { window, document } = bootDom();
    postFocus(window, 'main');
    postFocus(window, null);
    assert.ok(
      !document.querySelector('.branch-label-head')!.classList.contains('branch-label-focused'),
      'head chip cleared'
    );
    assert.ok(
      !document.querySelector('.branch-label-local')!.classList.contains('branch-label-focused'),
      'local chip cleared'
    );
    assert.ok(
      !document.querySelector('.branch-label-remote')!.classList.contains('branch-label-focused'),
      'remote chip cleared'
    );
  });
});

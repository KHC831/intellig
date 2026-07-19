/**
 * Push-dialog webview entry specs driven by a synthetic init island.
 *
 * The dialog's source column carries either a branch name or, for a
 * push-up-to-here row, the pushed commit's short hash — so the header label
 * must follow the rows. IntelliJ shows the same data in a headerless
 * CheckboxTree (platform/dvcs-impl PushLog.java), where the question never
 * arises.
 *
 * Files exercised: sync/webview/pushDialog.ts.
 */

import '../../setup';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import { initIslandHtml } from '../../../src/utils/webviewInit';
import type { IPushDialogInit, IPushRowView } from '../../../src/sync/pushDialog.protocol';

function row(overrides: Partial<IPushRowView> = {}): IPushRowView {
  return {
    id: 'r1',
    repoLabel: 'repo',
    localBranch: 'feature',
    targetBranch: 'feature',
    ahead: 1,
    selected: true,
    protected: false,
    sourceHash: null,
    error: null,
    ...overrides,
  };
}

function init(rows: IPushRowView[]): IPushDialogInit {
  return {
    empty: false,
    rows,
    primaryAction: 'push',
    primaryLabel: 'Push',
    anyProtected: false,
    overflow: { noVerify: false, pushTags: false, tagScope: 'all' },
  };
}

function boot(rows: IPushRowView[]): IWebviewEntryHarness {
  return bootWebviewEntry('sync/webview/pushDialog', {
    bodyHtml: `<div id="root"></div>${initIslandHtml(init(rows))}`,
  });
}

function headerTexts(h: IWebviewEntryHarness): string[] {
  return Array.from(h.document.querySelectorAll('thead th')).map((th) => th.textContent ?? '');
}

describe('webview: push dialog source column header', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('labels the source column "Branch" when every row pushes a branch tip', () => {
    h = boot([row()]);

    assert.deepStrictEqual(headerTexts(h), ['', 'Repository', 'Branch', 'Target', 'Commits']);
  });

  it('labels the source column "Source" when a row pushes an exact revision', () => {
    h = boot([row({ sourceHash: 'beebeeb1234567890' })]);

    assert.strictEqual(headerTexts(h)[2], 'Source');
  });

  it('labels the source column "Source" when only some rows push an exact revision', () => {
    h = boot([row(), row({ id: 'r2', sourceHash: 'beebeeb1234567890' })]);

    assert.strictEqual(headerTexts(h)[2], 'Source');
  });
});

/**
 * Regression (F-A): Ctrl/Cmd+C on a focused commit row copies its hash.
 *
 * The keyboard handler's `case 'c'` used to call an undefined `copyToClipboard`
 * — pressing Ctrl+C on a commit row threw a ReferenceError and copied nothing
 * (a latent bug). It now writes the hash via `navigator.clipboard.writeText`,
 * mirroring the `.hash-value` click-to-copy path. This boots the real entry and
 * pins that a focused-row Ctrl/Cmd+C reaches `writeText(hash)`.
 */

import '../../../setup';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../../helpers/bootWebviewEntry';

const ENTRY = 'git-core/gitToolWindow/webview/gitToolWindow';
const HASH = 'abc1234def5678abc1234def5678abc1234def56';

function boot(captured: string[]): IWebviewEntryHarness {
  return bootWebviewEntry(ENTRY, {
    bodyHtml:
      `<div class="graph-panel" aria-multiselectable="true">` +
      `<div class="commit-row" data-hash="${HASH}" tabindex="0"></div>` +
      `</div>`,
    beforeBoot: (window) => {
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string): Promise<void> => {
            captured.push(text);
            return Promise.resolve();
          },
        },
      });
    },
  });
}

describe('Git tool window entry — Ctrl/Cmd+C copies the focused commit hash (F-A)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  for (const mod of ['ctrlKey', 'metaKey'] as const) {
    it(`writes the row's hash to the clipboard on ${mod}+C`, () => {
      const captured: string[] = [];
      h = boot(captured);
      const row = h.document.querySelector('.commit-row') as HTMLElement;
      row.dispatchEvent(
        new h.window.KeyboardEvent('keydown', { key: 'c', [mod]: true, bubbles: true })
      );
      assert.deepStrictEqual(captured, [HASH], `${mod}+C must copy the focused row's hash`);
    });
  }

  it('does not copy on a bare "c" (no modifier)', () => {
    const captured: string[] = [];
    h = boot(captured);
    const row = h.document.querySelector('.commit-row') as HTMLElement;
    row.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    assert.deepStrictEqual(captured, [], 'plain "c" must not touch the clipboard');
  });
});

// CopyRevisionNumberAction parity: the action reads the SELECTION (not just
// the focused row), reverses to oldest-first, and joins full hashes with a
// single space ("pass to native client in terminal").
describe('Git tool window entry — Ctrl/Cmd+C acts on the multi-selection (F-A13)', () => {
  const OLDEST = 'a'.repeat(40);
  const MIDDLE = 'b'.repeat(40);
  const NEWEST = 'c'.repeat(40);
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  function bootRows(rows: string, captured: string[]): IWebviewEntryHarness {
    return bootWebviewEntry(ENTRY, {
      bodyHtml: `<div class="graph-panel" aria-multiselectable="true">${rows}</div>`,
      beforeBoot: (window) => {
        Object.defineProperty(window.navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: (text: string): Promise<void> => {
              captured.push(text);
              return Promise.resolve();
            },
          },
        });
      },
    });
  }

  it('copies all selected hashes oldest-first, space-joined', () => {
    const captured: string[] = [];
    // DOM lists newest-first (display order); all three rows selected.
    h = bootRows(
      `<div class="commit-row selected" data-hash="${NEWEST}" tabindex="0"></div>` +
        `<div class="commit-row selected" data-hash="${MIDDLE}" tabindex="0"></div>` +
        `<div class="commit-row selected" data-hash="${OLDEST}" tabindex="0"></div>`,
      captured
    );
    const row = h.document.querySelector(`.commit-row[data-hash="${MIDDLE}"]`) as HTMLElement;
    row.dispatchEvent(
      new h.window.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true })
    );
    assert.deepStrictEqual(
      captured,
      [[OLDEST, MIDDLE, NEWEST].join(' ')],
      'Ctrl+C on a selected row must copy the whole selection oldest-first, space-joined'
    );
  });

  it('falls back to the focused row when it is outside the selection', () => {
    const captured: string[] = [];
    h = bootRows(
      `<div class="commit-row selected" data-hash="${NEWEST}" tabindex="0"></div>` +
        `<div class="commit-row" data-hash="${OLDEST}" tabindex="0"></div>`,
      captured
    );
    const row = h.document.querySelector(`.commit-row[data-hash="${OLDEST}"]`) as HTMLElement;
    row.dispatchEvent(
      new h.window.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true })
    );
    assert.deepStrictEqual(captured, [OLDEST], 'unselected focused row copies just itself');
  });
});

/**
 * Structural guard test for the `selectGraphRow` message-handler's
 * visibility gate.
 *
 * When the user plain-clicks a commit row the webview posts `selectCommit`;
 * the host echoes back a `selectGraphRow` message (messageHandlers.selectCommit)
 * so the host stays the source of truth for selection. The webview's
 * `selectGraphRow` handler re-applies the `.selected` highlight AND scrolls the
 * row into view.
 *
 * The scroll must be GUARDED by the same `fullyVisible` visibility check that
 * `scrollToCommit` uses (ADR-009 section 2 — scroll position is webview-owned
 * ephemeral state). Without the gate, every click re-centers an already-visible
 * row with a smooth animation, so the graph "jerks around" on each selection —
 * the same class of bug as the branch-click "sweep from the top" that
 * `scrollToCommit` was hardened against.
 *
 * After the scroll-math de-dup refactor, both call sites delegate to the shared
 * `scrollRowIntoViewIfNeeded` helper rather than repeating the gate inline. These
 * tests pin:
 *  - the handler calls `scrollRowIntoViewIfNeeded(targetRow)`
 *  - the shared helper contains the `fullyVisible` gate
 *  - the handler itself has no unconditional `scrollIntoView` call before any gate
 */

import '../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** Source of the bundled Git tool-window client entry (the scroll handlers live here). */
const ENTRY_SOURCE =
  fs.readFileSync(
    path.resolve(__dirname, '../../src/git-core/gitToolWindow/webview/gitToolWindow.ts'),
    'utf8'
  ) +
  fs.readFileSync(
    path.resolve(__dirname, '../../src/git-core/gitToolWindow/webview/logSelection.ts'),
    'utf8'
  );

/**
 * Extract a brace-matched block beginning at the first `{` after the header
 * pattern match. Returns the block (inclusive of braces) or null.
 */
function extractBlockAfter(body: string, headerPattern: RegExp): string | null {
  const match = headerPattern.exec(body);
  if (!match) {
    return null;
  }
  const openBraceIdx = body.indexOf('{', match.index);
  if (openBraceIdx === -1) {
    return null;
  }
  let depth = 0;
  for (let i = openBraceIdx; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return body.substring(openBraceIdx, i + 1);
      }
    }
  }
  return null;
}

describe('GitToolWindowProvider - client selectGraphRow scroll visibility guard', () => {
  let handlerBlock: string;
  let helperBlock: string;

  beforeEach(() => {
    const hBlock = extractBlockAfter(ENTRY_SOURCE, /message\.type === 'selectGraphRow'/);
    assert.ok(hBlock, 'rendered client entry must contain a selectGraphRow handler block');
    handlerBlock = hBlock;

    const helper = extractBlockAfter(ENTRY_SOURCE, /function scrollRowIntoViewIfNeeded\s*\(/);
    assert.ok(helper, 'rendered client entry must contain a scrollRowIntoViewIfNeeded helper');
    helperBlock = helper;
  });

  it('handler delegates scroll to the shared scrollRowIntoViewIfNeeded helper', () => {
    const delegateCall = /scrollRowIntoViewIfNeeded\s*\(\s*targetRow\s*\)/;
    assert.ok(
      delegateCall.test(handlerBlock),
      'selectGraphRow handler must call scrollRowIntoViewIfNeeded(targetRow) rather than inlining scroll logic'
    );
  });

  it('shared helper computes a fullyVisible visibility gate', () => {
    const gate =
      /const\s+fullyVisible\s*=\s*rowTop\s*>=\s*viewportTop\s*&&\s*rowBottom\s*<=\s*viewportBottom/;
    assert.ok(
      gate.test(helperBlock),
      'scrollRowIntoViewIfNeeded must compute `fullyVisible = rowTop >= viewportTop && rowBottom <= viewportBottom`'
    );
  });

  it('shared helper guards the scroll behind `if (!fullyVisible)` — not an unconditional re-center', () => {
    const guardedBlock = extractBlockAfter(helperBlock, /if\s*\(\s*!\s*fullyVisible\s*\)/);
    assert.ok(guardedBlock, 'helper must gate the scroll behind an `if (!fullyVisible)` block');
    assert.ok(
      /panel\.scrollTo\s*\(/.test(guardedBlock),
      'scrollRowIntoViewIfNeeded must scroll the graph panel (panel.scrollTo) inside the `if (!fullyVisible)` guard'
    );
  });

  it('scrolls the graph panel alone (no scrollIntoView on the `if (panel)` path)', () => {
    // scrollIntoView also scrolls the outer tab container, pushing the log
    // filter bar behind the tab strip; the panel branch must not use it.
    const panelBlock = extractBlockAfter(helperBlock, /if\s*\(\s*panel\s*\)/);
    assert.ok(panelBlock, 'helper must have an `if (panel)` branch');
    assert.ok(
      !/scrollIntoView\s*\(/.test(panelBlock),
      'the panel branch must scroll via panel.scrollTo, never scrollIntoView'
    );
  });

  it('handler itself has no unconditional scrollIntoView (all scrolling goes through the helper)', () => {
    assert.ok(
      !/scrollIntoView\s*\(/.test(handlerBlock),
      'selectGraphRow handler must not call scrollIntoView directly — only via scrollRowIntoViewIfNeeded'
    );
  });
});

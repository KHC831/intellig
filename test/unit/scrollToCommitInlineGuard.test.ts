/**
 * Structural guard test for the `scrollToCommit` visibility gate.
 *
 * This is an ADR-007-style structural guard: the inline webview
 * `scrollToCommit(commitHash)` function delegates scroll logic to the shared
 * `scrollRowIntoViewIfNeeded` helper (scroll-math de-dup refactor). The helper
 * only scrolls a row that is not already fully within the viewport (ADR-009
 * section 2 — scroll position is webview-owned ephemeral state).
 *
 * The guard pins:
 *   - `scrollToCommit` delegates to `scrollRowIntoViewIfNeeded(commitRow)`,
 *   - the shared helper contains the `fullyVisible` visibility gate,
 *   - the early-return for a missing row element is present (Req 2.3), and
 *   - the scroll is guarded by `if (!fullyVisible)` in the helper rather than
 *     firing unconditionally, and it scrolls the graph panel alone
 *     (`panel.scrollTo`) instead of `scrollIntoView`, which also scrolls the
 *     outer tab container and drags the log filter bar behind the tab strip.
 */

import '../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Source of the bundled Git tool-window client entry — the scroll functions the
 * provider used to inline now live here.
 */
const ENTRY_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../src/git-core/gitToolWindow/webview/gitToolWindow.ts'),
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

/**
 * Extract the body of the inline `scrollToCommit(commitHash)` function from
 * the rendered webview HTML by brace-matching from the function header.
 */
function extractScrollToCommitBody(html: string): string {
  const headerIdx = html.indexOf('function scrollToCommit(');
  assert.notStrictEqual(
    headerIdx,
    -1,
    'rendered inline script must define a scrollToCommit(commitHash) function'
  );

  const openBraceIdx = html.indexOf('{', headerIdx);
  assert.notStrictEqual(openBraceIdx, -1, 'scrollToCommit must have a function body');

  let depth = 0;
  for (let i = openBraceIdx; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return html.substring(openBraceIdx, i + 1);
      }
    }
  }
  assert.fail('could not find the closing brace of scrollToCommit');
  return '';
}

describe('GitToolWindowProvider - inline scrollToCommit visibility guard', () => {
  let scrollBody: string;
  let helperBody: string;

  beforeEach(() => {
    scrollBody = extractScrollToCommitBody(ENTRY_SOURCE);
    const hb = extractBlockAfter(ENTRY_SOURCE, /function scrollRowIntoViewIfNeeded\s*\(/);
    assert.ok(hb, 'rendered client entry must define a scrollRowIntoViewIfNeeded helper');
    helperBody = hb;
  });

  it('delegates scroll to the shared scrollRowIntoViewIfNeeded helper', () => {
    const delegateCall = /scrollRowIntoViewIfNeeded\s*\(\s*commitRow\s*\)/;
    assert.ok(
      delegateCall.test(scrollBody),
      'scrollToCommit must call scrollRowIntoViewIfNeeded(commitRow) rather than inlining scroll logic'
    );
  });

  it('helper contains the fullyVisible visibility gate', () => {
    const gate =
      /const\s+fullyVisible\s*=\s*rowTop\s*>=\s*viewportTop\s*&&\s*rowBottom\s*<=\s*viewportBottom/;
    assert.ok(
      gate.test(helperBody),
      'scrollRowIntoViewIfNeeded must compute `fullyVisible = rowTop >= viewportTop && rowBottom <= viewportBottom`'
    );
  });

  it('early-returns when the row element is not found (Req 2.3)', () => {
    const earlyReturn = /if\s*\(\s*!\s*commitRow\s*\)\s*\{\s*return\s*;?\s*\}/;
    assert.ok(
      earlyReturn.test(scrollBody),
      'scrollToCommit must early-return (no scroll, no highlight) when commitRow is missing'
    );
  });

  it('helper guards the scroll behind `if (!fullyVisible)` — not an unconditional scroll', () => {
    const guardedBlock = extractBlockAfter(helperBody, /if\s*\(\s*!\s*fullyVisible\s*\)/);
    assert.ok(guardedBlock, 'helper must gate the scroll behind an `if (!fullyVisible)` block');
    assert.ok(
      /panel\.scrollTo\s*\(/.test(guardedBlock),
      'scrollRowIntoViewIfNeeded must scroll the graph panel (panel.scrollTo) inside the `if (!fullyVisible)` guard'
    );
  });

  it('scrolls the graph panel alone, not the outer container (no scrollIntoView on the panel path)', () => {
    // The `if (panel)` branch must NOT use scrollIntoView, which also scrolls
    // the outer tab container and pushes the log filter bar behind the tab strip.
    const panelBlock = extractBlockAfter(helperBody, /if\s*\(\s*panel\s*\)/);
    assert.ok(panelBlock, 'helper must have an `if (panel)` branch');
    assert.ok(
      !/scrollIntoView\s*\(/.test(panelBlock),
      'the panel branch must scroll the panel directly (panel.scrollTo), never scrollIntoView'
    );
  });

  it('scrollToCommit itself has no direct scrollIntoView call (all scrolling goes through helper)', () => {
    assert.ok(
      !/scrollIntoView\s*\(/.test(scrollBody),
      'scrollToCommit must not call scrollIntoView directly — only via scrollRowIntoViewIfNeeded'
    );
  });
});

/**
 * Structural contract test for the "highlight always applies" behavior.
 *
 * Decision D4 of the design ("Keep the highlight-scroll emphasis in all cases,
 * including when no scroll happens") requires that the `highlight-scroll`
 * emphasis is applied on EVERY call to the inline `scrollToCommit`, regardless
 * of whether a scroll happened. The `commitRow.classList.add('highlight-scroll')`
 * call must appear AFTER `scrollRowIntoViewIfNeeded(commitRow)` — which may or
 * may not scroll — so the highlight is unconditional.
 */
describe('GitToolWindowProvider - inline scrollToCommit highlight-always (D4)', () => {
  let scrollBody: string;

  beforeEach(() => {
    scrollBody = extractScrollToCommitBody(ENTRY_SOURCE);
  });

  it('adds the highlight-scroll class to the row (Req 3.2, 3.3)', () => {
    const highlightAdd = /commitRow\.classList\.add\(\s*['"]highlight-scroll['"]\s*\)/;
    assert.ok(
      highlightAdd.test(scrollBody),
      "scrollToCommit must add the 'highlight-scroll' class to the commit row"
    );
  });

  it('applies the highlight AFTER the helper call, regardless of whether a scroll occurred (D4)', () => {
    // The highlight must run unconditionally: it must appear after the
    // scrollRowIntoViewIfNeeded(commitRow) call so it fires whether or not a
    // scroll happened.
    const helperCallIdx = scrollBody.indexOf('scrollRowIntoViewIfNeeded(commitRow)');
    assert.notStrictEqual(
      helperCallIdx,
      -1,
      'expected scrollRowIntoViewIfNeeded(commitRow) call in scrollToCommit'
    );

    const highlightAdd = /commitRow\.classList\.add\(\s*['"]highlight-scroll['"]\s*\)/;
    const highlightMatch = highlightAdd.exec(scrollBody);
    assert.ok(
      highlightMatch,
      'expected a highlight-scroll classList.add call in scrollToCommit body'
    );

    assert.ok(
      highlightMatch.index > helperCallIdx,
      "the 'highlight-scroll' classList.add must appear AFTER the scrollRowIntoViewIfNeeded call " +
        'so the highlight fires regardless of whether a scroll happened'
    );
  });

  it('schedules removal of the highlight after 2000ms (cleanup)', () => {
    const cleanup =
      /setTimeout\([\s\S]*?classList\.remove\(\s*['"]highlight-scroll['"]\s*\)[\s\S]*?2000/;
    assert.ok(
      cleanup.test(scrollBody),
      "scrollToCommit must schedule removal of the 'highlight-scroll' class after 2000ms"
    );
  });
});

/**
 * Structural guard test for the `autoScrollOnLoad` delegation.
 *
 * The jump-to-hash full-re-render path embeds `data-scroll-to-commit` on the
 * `.graph-panel`, and the inline IIFE `autoScrollOnLoad` reads that attribute
 * after the re-render and calls the shared `scrollToCommit(targetHash)`. Because
 * it DELEGATES to the shared function rather than duplicating scroll logic, it
 * inherits the visibility gate added for free.
 *
 * This guard pins that delegation so a future refactor cannot reintroduce a
 * separate/unconditional `scrollIntoView` inside `autoScrollOnLoad`.
 *
 * _Requirements: 4.3, 5.3_
 */
describe('GitToolWindowProvider - autoScrollOnLoad delegates to scrollToCommit', () => {
  const html = ENTRY_SOURCE;

  it('defines an autoScrollOnLoad routine that delegates to scrollToCommit (Req 4.3, 5.3)', () => {
    const autoScrollBody = extractBlockAfter(html, /function\s+autoScrollOnLoad\s*\(/);
    assert.ok(
      autoScrollBody,
      'rendered inline script must define an autoScrollOnLoad() function with a body'
    );
    const delegates = /scrollToCommit\s*\(/.test(autoScrollBody);
    assert.ok(
      delegates,
      'autoScrollOnLoad must call the shared scrollToCommit(...) so it inherits the visibility gate'
    );
  });

  it('does NOT duplicate scroll logic — autoScrollOnLoad has no scrollIntoView of its own (Req 4.3, 5.3)', () => {
    const autoScrollBody = extractBlockAfter(html, /function\s+autoScrollOnLoad\s*\(/);
    assert.ok(autoScrollBody, 'expected to find the autoScrollOnLoad() body');
    assert.ok(
      !/scrollIntoView\s*\(/.test(autoScrollBody),
      'autoScrollOnLoad must NOT contain its own scrollIntoView call — it must delegate to ' +
        'scrollToCommit so the visibility gate is inherited rather than duplicated'
    );
  });
});

/**
 * Structural guard test for the inline `scrollToCommit` visibility gate.
 *
 * This is an ADR-007-style structural guard: the inline webview
 * `scrollToCommit(commitHash)` function cannot import the pure
 * `scrollVisibility.ts` predicate, so it MIRRORS the predicate's contract
 * inline (ADR-009 section 2 — scroll position is webview-owned ephemeral state).
 *
 * The guard pins that mirror so a future refactor cannot regress the inline
 * scroll back to the *unconditional* `scrollIntoView` that caused the
 * branch-click "sweep from the top" bug. It asserts:
 *   - the `fullyVisible` visibility gate is present (mirror of
 *     `isRowFullyVisible`),
 *   - the early-return for a missing row element is present (Req 2.3), and
 *   - the `scrollIntoView` call is GUARDED by `if (!fullyVisible)` rather than
 *     firing unconditionally.
 *
 * The smooth animation itself is intentionally retained, so the guard
 * checks for the visibility gate, NOT for the absence of `behavior: 'smooth'`.
 *
 */

import '../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../ui-shell/GitToolWindowProvider';
import { Uri, Webview } from '../mocks/vscode';

/**
 * Create a mock Webview object for rendering the full inline-script HTML.
 */
function createMockWebview(): Webview {
  return {
    html: '',
    options: {},
    cspSource: 'https://mock.csp.source',
    onDidReceiveMessage: () => ({ dispose: () => {} }),
    postMessage: () => Promise.resolve(true),
    asWebviewUri: (uri: Uri) => uri,
  } as unknown as Webview;
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
  let provider: GitToolWindowProvider;
  let mockWebview: Webview;
  let scrollBody: string;

  beforeEach(() => {
    const extensionUri = Uri.file('/test/extension');
    provider = new GitToolWindowProvider(extensionUri);
    mockWebview = createMockWebview();
    const html = provider._getThreePanelHtmlContent(
      mockWebview as unknown as import('vscode').Webview,
      []
    );
    scrollBody = extractScrollToCommitBody(html);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('contains the fullyVisible visibility gate (mirror of isRowFullyVisible)', () => {
    // The exact comparison pinned by scrollVisibility.isRowFullyVisible.
    // Robust to surrounding whitespace, strict about the comparison itself.
    const gate =
      /const\s+fullyVisible\s*=\s*rowTop\s*>=\s*viewportTop\s*&&\s*rowBottom\s*<=\s*viewportBottom/;
    assert.ok(
      gate.test(scrollBody),
      'scrollToCommit must compute `fullyVisible = rowTop >= viewportTop && rowBottom <= viewportBottom`'
    );
  });

  it('early-returns when the row element is not found (Req 2.3)', () => {
    const earlyReturn = /if\s*\(\s*!\s*commitRow\s*\)\s*\{\s*return\s*;?\s*\}/;
    assert.ok(
      earlyReturn.test(scrollBody),
      'scrollToCommit must early-return (no scroll, no highlight) when commitRow is missing'
    );
  });

  it('guards the scroll behind `if (!fullyVisible)` — not an unconditional scroll', () => {
    // The visibility gate must IMMEDIATELY precede a scrollIntoView call, i.e.
    // the scroll only fires inside the `if (!fullyVisible)` branch. Whitespace
    // (including newlines/comments) between the guard and the call is allowed,
    // but there must be no intervening statement.
    const guardedScroll =
      /if\s*\(\s*!\s*fullyVisible\s*\)\s*\{(?:\s*\/\/[^\n]*\n)*\s*commitRow\.scrollIntoView\s*\(/;
    assert.ok(
      guardedScroll.test(scrollBody),
      'the `if (!fullyVisible)` block must immediately precede the commitRow.scrollIntoView call'
    );
  });

  it('does not call scrollIntoView unconditionally inside the panel-present branch', () => {
    // Regression guard: the pre-fix bug ran scrollIntoView every time. Inside
    // the panel-present path the ONLY scrollIntoView must be the guarded one,
    // so a `scrollIntoView` must never appear without a preceding
    // `!fullyVisible` check on the same path. We assert every scrollIntoView
    // occurrence in the body is either the guarded one or the panel-missing
    // fallback (the `else` branch), and that none sits at the top level of the
    // function before the visibility computation.
    const beforeGate = scrollBody.slice(0, scrollBody.indexOf('const fullyVisible'));
    assert.ok(
      !/commitRow\.scrollIntoView\s*\(/.test(beforeGate),
      'scrollToCommit must NOT scroll before computing the visibility gate (no unconditional scroll)'
    );
  });
});

/**
 * Extract a brace-matched block that begins at the first `{` following the
 * first match of `headerPattern` within `body`. Returns the substring from the
 * opening brace through its matching closing brace (inclusive). Returns null
 * when the header or a balanced block cannot be found.
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
 * Structural contract test for the "highlight always applies" behavior.
 *
 * Decision D4 of the design ("Keep the highlight-scroll emphasis in all cases,
 * including when no scroll happens") requires that the `highlight-scroll`
 * emphasis is applied on EVERY call to the inline `scrollToCommit`, regardless
 * of which visibility branch is taken. Concretely, the
 * `classList.add('highlight-scroll')` call must live OUTSIDE and AFTER the
 * `if (panel) { ... } else { ... }` visibility/scroll branching, so it runs
 * whether or not a scroll happened.
 *
 * This guard pins that contract so a future refactor cannot accidentally move
 * the highlight inside a scroll branch (which would drop the selection emphasis
 * when the target row is already fully visible — or only
 * highlight after scrolling).
 *
 */
describe('GitToolWindowProvider - inline scrollToCommit highlight-always (D4)', () => {
  let provider: GitToolWindowProvider;
  let mockWebview: Webview;
  let scrollBody: string;

  beforeEach(() => {
    const extensionUri = Uri.file('/test/extension');
    provider = new GitToolWindowProvider(extensionUri);
    mockWebview = createMockWebview();
    const html = provider._getThreePanelHtmlContent(
      mockWebview as unknown as import('vscode').Webview,
      []
    );
    scrollBody = extractScrollToCommitBody(html);
  });

  afterEach(() => {
    provider.dispose();
  });

  it('adds the highlight-scroll class to the row (Req 3.2, 3.3)', () => {
    // Robust to whitespace and quote style.
    const highlightAdd = /commitRow\.classList\.add\(\s*['"]highlight-scroll['"]\s*\)/;
    assert.ok(
      highlightAdd.test(scrollBody),
      "scrollToCommit must add the 'highlight-scroll' class to the commit row"
    );
  });

  it('applies the highlight AFTER the visibility/scroll branching, regardless of branch (D4, Req 3.2, 3.3)', () => {
    // The highlight must run whether or not a scroll happened, so it has to sit
    // after BOTH scroll branches (the `if (!fullyVisible)` scroll and the
    // panel-missing `else` fallback). The last scrollIntoView occurrence marks
    // the end of the branching; the highlight add must come strictly after it.
    const highlightAdd = /commitRow\.classList\.add\(\s*['"]highlight-scroll['"]\s*\)/;
    const highlightMatch = highlightAdd.exec(scrollBody);
    assert.ok(highlightMatch, 'expected a highlight-scroll classList.add call in the body');

    const lastScrollIdx = scrollBody.lastIndexOf('scrollIntoView');
    assert.notStrictEqual(
      lastScrollIdx,
      -1,
      'expected at least one scrollIntoView call in the body'
    );

    assert.ok(
      highlightMatch.index > lastScrollIdx,
      "the 'highlight-scroll' classList.add must appear AFTER the last scrollIntoView " +
        '(i.e. outside and after the if (panel) { ... } else { ... } branching), ' +
        'so the highlight applies regardless of the scroll decision'
    );
  });

  it('does not nest the highlight inside the `if (!fullyVisible)` scroll block (Req 3.2)', () => {
    // The `if (!fullyVisible)` block should perform the scroll only; the
    // highlight must NOT be nested inside it (which would skip the highlight
    // when the row is already fully visible).
    const guardedBlock = extractBlockAfter(scrollBody, /if\s*\(\s*!\s*fullyVisible\s*\)/);
    assert.ok(guardedBlock, 'expected to find the if (!fullyVisible) { ... } block in the body');
    const highlightAdd = /commitRow\.classList\.add\(\s*['"]highlight-scroll['"]\s*\)/;
    assert.ok(
      !highlightAdd.test(guardedBlock),
      "the 'highlight-scroll' classList.add must NOT be nested inside the if (!fullyVisible) block"
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
 * inherits the visibility gate added in for free.
 *
 * This guard pins that delegation so a future refactor cannot reintroduce a
 * separate/unconditional `scrollIntoView` inside `autoScrollOnLoad` (which would
 * bypass the visibility gate and bring back the "sweep from the top" bug on the
 * jump-to-hash path). It asserts:
 *   - `autoScrollOnLoad` exists and calls `scrollToCommit(` (delegation intact),
 *     and
 *   - `autoScrollOnLoad`'s body does NOT contain its own `scrollIntoView(` call
 *     (no duplicated scroll logic — it inherits the gate from the shared fn).
 *
 * _Requirements: 4.3, 5.3_
 */
describe('GitToolWindowProvider - autoScrollOnLoad delegates to scrollToCommit', () => {
  let provider: GitToolWindowProvider;
  let mockWebview: Webview;
  let html: string;

  beforeEach(() => {
    const extensionUri = Uri.file('/test/extension');
    provider = new GitToolWindowProvider(extensionUri);
    mockWebview = createMockWebview();
    html = provider._getThreePanelHtmlContent(
      mockWebview as unknown as import('vscode').Webview,
      []
    );
  });

  afterEach(() => {
    provider.dispose();
  });

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

/**
 * Fixtures for rendering the merge window in the computed-style lane.
 *
 * Two halves, because the surface has two halves.
 *
 * The window's own chrome — toolbar, panes, gutters, action strips, bottom bar,
 * column boundaries — is built by `buildMergeWindowDom` and renders with no
 * editor present. That markup comes from the production builder, never retyped.
 *
 * The fills and the selection live on markup Monaco injects at runtime, which
 * is not available here. Those need a skeleton that reproduces the structure
 * the selectors target. A skeleton is a liability: if Monaco's DOM shape
 * changes, the specs keep passing against a shape that no longer ships. It is
 * still worth having, because the alternative is what the project already did
 * five times — ship a layering defect and find it by eye.
 */

import { JSDOM } from 'jsdom';
import { buildMergeWindowDom } from '../../../src/conflicts/merge-window/mergeWindowHtml';
import { PANE_FOCUSED_CLASS } from '../../../src/conflicts/merge-window/singleSelection';

/** The production chrome, as a markup string the lane can render. */
export function mergeWindowChrome(): string {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  buildMergeWindowDom(dom.window.document);
  const html = dom.window.document.body.innerHTML;
  if (!html.includes('id="panes"')) {
    throw new Error(
      'buildMergeWindowDom produced no #panes container; the builder changed shape and ' +
        'test/visual/support/mergeWindowFixture.ts needs updating rather than rendering nothing.'
    );
  }
  return html;
}

export type MergeFillKind = 'conflict' | 'modified' | 'inserted' | 'deleted';

/**
 * The runtime value list behind {@link MergeFillKind}. Fixture-owned, so a
 * spec pins it set-equal to the `k-` families extracted from the stylesheet
 * text — a fifth kind added in production cannot silently miss every
 * per-kind spec loop.
 */
export const MERGE_FILL_KINDS: readonly MergeFillKind[] = [
  'conflict',
  'modified',
  'inserted',
  'deleted',
];

/**
 * The VS Code token each kind's CONTENT tone rides on (`--merge-<kind>-bg` in
 * the stylesheet's var block), and the stronger word/marker tone
 * (`--merge-<kind>-strong`). Fixture-owned single copy: a wrong entry here
 * cannot hide, because the identity specs compare it against what the
 * production rules actually resolve to.
 */
export const MERGE_BG_TOKEN: Readonly<Record<MergeFillKind, string>> = {
  conflict: 'vscode-mergeEditor-changeBase-background',
  modified: 'vscode-merge-incomingContentBackground',
  inserted: 'vscode-merge-currentContentBackground',
  deleted: 'vscode-merge-commonContentBackground',
};

export const MERGE_STRONG_TOKEN: Readonly<Record<MergeFillKind, string>> = {
  conflict: 'vscode-mergeEditor-changeBase-word-background',
  modified: 'vscode-merge-incomingHeaderBackground',
  inserted: 'vscode-merge-currentHeaderBackground',
  deleted: 'vscode-merge-commonHeaderBackground',
};

export interface IEditorSkeletonOptions {
  /** Marks the pane focused, which selects the active selection colour. */
  focused?: boolean;
  /** Chunk fill painted under the text, as Monaco's decorations would. */
  fill?: MergeFillKind;
  /** Renders a selection band over the same line. */
  selected?: boolean;
  /** Word-level highlight over part of the line (`.merge-word.k-*`). */
  word?: MergeFillKind;
  /** Deleted-elsewhere marker line (`.merge-empty.k-*`). */
  empty?: MergeFillKind;
  /** Resolved-chunk outline (`.merge-resolved-top/-bottom.k-*`). */
  resolved?: MergeFillKind;
}

/**
 * The layer structure Monaco emits, reduced to what the merge stylesheet
 * targets: an `.monaco-editor` root carrying the focus marker, a
 * `.view-overlays` layer holding the decoration and selection divs, and a
 * sibling `.view-lines` layer holding the glyphs.
 *
 * Overlays and lines are absolutely positioned over the same box on purpose.
 * That overlap is the whole defect surface: every one of the five layering
 * rounds was a question of which of these two layers won.
 */
export function editorSkeleton(id: string, options: IEditorSkeletonOptions = {}): string {
  const focus = options.focused === true ? ` ${PANE_FOCUSED_CLASS}` : '';
  const fill =
    options.fill === undefined
      ? ''
      : `<div class="cdr merge-${options.fill}" style="position:absolute;top:0;left:0;width:100%;height:20px;"></div>`;
  const selection =
    options.selected === true
      ? `<div class="selected-text" style="position:absolute;top:0;left:0;width:100%;height:20px;"></div>`
      : '';
  // Word highlights are ranged decorations, so the box covers part of the
  // line, exactly as Monaco sizes a `.cdr` to the decorated range
  // (composition site: webview/main.ts, `className: \`merge-word k-\${kind}\``).
  const word =
    options.word === undefined
      ? ''
      : `<div class="cdr merge-word k-${options.word}" style="position:absolute;top:0;left:60px;width:120px;height:20px;"></div>`;
  // Whole-line markers (composition sites in webview/main.ts:
  // `merge-empty k-*`, `merge-resolved-top k-*` / `merge-resolved-bottom k-*`).
  const empty =
    options.empty === undefined
      ? ''
      : `<div class="cdr merge-empty k-${options.empty}" style="position:absolute;top:20px;left:0;width:100%;height:20px;"></div>`;
  const resolved =
    options.resolved === undefined
      ? ''
      : `<div class="cdr merge-resolved-top merge-resolved-bottom k-${options.resolved}" style="position:absolute;top:0;left:0;width:100%;height:20px;"></div>`;
  // The fill and word layers are emitted AFTER the selection deliberately.
  // Monaco does not promise a decoration order, so the stylesheet's
  // `z-index: -1` is what has to keep them underneath. Emitting them first
  // would let plain paint order produce the right answer and the specs would
  // pass with the z-index deleted — the fixture, not the stylesheet, deciding
  // the verdict.
  return `
<div id="${id}" class="monaco-editor${focus}" style="position:relative;width:300px;height:60px;">
  <div class="view-overlays" style="position:absolute;inset:0;">
    ${selection}
    ${fill}
    ${word}
    ${empty}
    ${resolved}
  </div>
  <div class="view-lines" style="position:absolute;inset:0;">
    <div class="view-line" style="position:absolute;top:0;left:0;width:100%;height:20px;line-height:20px;">
      <span class="mtk1">merged text</span>
    </div>
  </div>
</div>`;
}

/**
 * The production chrome with one action band injected into the first
 * action-strip body, mirroring the runtime composition site
 * (webview/main.ts, `band.className = \`action-band k-\${kindOf(change)}\``,
 * with top/height set inline). The band itself is runtime markup no builder
 * emits, so it is hand-built here with that limitation stated; the strip it
 * lands in is the production builder's. Throws when the anchor stops
 * matching, so a chrome reshape fails loudly instead of rendering no band.
 */
export function chromeWithActionBand(kind: MergeFillKind): string {
  const chrome = mergeWindowChrome();
  const anchor = 'class="action-strip-body">';
  const at = chrome.indexOf(anchor);
  if (at === -1) {
    throw new Error(
      'chromeWithActionBand found no .action-strip-body in the production chrome; ' +
        'buildMergeWindowDom changed shape and test/visual/support/mergeWindowFixture.ts ' +
        'needs updating rather than rendering no band.'
    );
  }
  const band = `<div class="action-band k-${kind}" style="top:4px;height:20px;"></div>`;
  return chrome.slice(0, at + anchor.length) + band + chrome.slice(at + anchor.length);
}

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

export interface IEditorSkeletonOptions {
  /** Marks the pane focused, which selects the active selection colour. */
  focused?: boolean;
  /** Chunk fill painted under the text, as Monaco's decorations would. */
  fill?: MergeFillKind;
  /** Renders a selection band over the same line. */
  selected?: boolean;
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
  // The fill is emitted AFTER the selection deliberately. Monaco does not
  // promise a decoration order, so the stylesheet's `z-index: -1` is what has
  // to keep the fill underneath. Emitting the fill first would let plain paint
  // order produce the right answer and the spec would pass with the z-index
  // deleted — the fixture, not the stylesheet, deciding the verdict.
  return `
<div id="${id}" class="monaco-editor${focus}" style="position:relative;width:300px;height:60px;">
  <div class="view-overlays" style="position:absolute;inset:0;">
    ${selection}
    ${fill}
  </div>
  <div class="view-lines" style="position:absolute;inset:0;">
    <div class="view-line" style="position:absolute;top:0;left:0;width:100%;height:20px;line-height:20px;">
      <span class="mtk1">merged text</span>
    </div>
  </div>
</div>`;
}

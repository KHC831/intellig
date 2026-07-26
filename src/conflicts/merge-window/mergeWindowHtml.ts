// The merge window's DOM skeleton and styles. The skeleton is built with
// createElement (the repo-wide webview convention — no HTML strings) by the
// webview script at boot; the panel ships an empty body. Shared with the
// jsdom harness so the tested DOM is the shipped DOM.
//
// Layout, per IntelliJ's merge dialog: action toolbar top-left with the
// unresolved counter on its right; three panes separated by two dividers
// that carry ONLY the curved canvas connectors linking each side block to
// its result block. The per-change colored bands and apply/ignore/revert
// icons live in divider-hugging action strips (Monaco cannot mirror a gutter
// the way IntelliJ does); the result editor's glyph margin carries only the
// magic-resolve wand; big Apply/Abort buttons bottom-right.

import { PANE_FOCUSED_CLASS } from './singleSelection';

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: { id?: string; className?: string; title?: string; text?: string; ariaLabel?: string },
  children: readonly HTMLElement[] = []
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (attrs.id !== undefined) {
    node.id = attrs.id;
  }
  if (attrs.className !== undefined) {
    node.className = attrs.className;
  }
  if (attrs.title !== undefined) {
    node.title = attrs.title;
  }
  if (attrs.ariaLabel !== undefined) {
    // Icon-only buttons render their glyph from CSS ::before, so the visible
    // text node is empty; aria-label carries the accessible name.
    node.setAttribute('aria-label', attrs.ariaLabel);
  }
  if (attrs.text !== undefined) {
    node.textContent = attrs.text;
  }
  for (const child of children) {
    node.appendChild(child);
  }
  return node;
}

/** Builds the merge window skeleton into the given document's body. */
export function buildMergeWindowDom(doc: Document): void {
  // IntelliJ's merge toolbar is a compact icon strip. Each button renders its
  // glyph from CSS ::before (codicon font or an inlined IntelliJ diff-icon
  // mask); the visible label lives in the tooltip (title) and the accessible
  // name in aria-label.
  const toolbar = el(doc, 'div', { id: 'toolbar' }, [
    el(doc, 'button', {
      id: 'btn-accept-left',
      title: 'Accept Yours — discard the result and take the whole left version',
      ariaLabel: 'Accept yours (whole left side)',
    }),
    el(doc, 'span', { className: 'spacer' }),
    el(doc, 'button', {
      id: 'btn-prev',
      title: 'Previous unresolved change (conflicts first)',
      ariaLabel: 'Previous change',
    }),
    el(doc, 'button', {
      id: 'btn-next',
      title: 'Next unresolved change (conflicts first)',
      ariaLabel: 'Next change',
    }),
    el(doc, 'span', { className: 'sep' }),
    el(doc, 'button', {
      id: 'btn-nc-left',
      title: 'Apply non-conflicting changes from the left side',
      ariaLabel: 'Apply non-conflicting changes from the left',
    }),
    el(doc, 'button', {
      id: 'btn-nc-all',
      title: 'Apply all non-conflicting changes',
      ariaLabel: 'Apply all non-conflicting changes',
    }),
    el(doc, 'button', {
      id: 'btn-nc-right',
      title: 'Apply non-conflicting changes from the right side',
      ariaLabel: 'Apply non-conflicting changes from the right',
    }),
    el(doc, 'button', {
      id: 'btn-magic-all',
      title: 'Resolve all conflicts whose side changes do not overlap',
      ariaLabel: 'Resolve simple conflicts',
    }),
    el(doc, 'button', {
      id: 'btn-reset',
      title: 'Reset all resolved changes back to unresolved (Cmd/Ctrl+Z undoes the reset)',
      ariaLabel: 'Reset resolved changes',
    }),
    el(doc, 'span', { id: 'counter' }),
    el(doc, 'span', { className: 'spacer' }),
    el(doc, 'button', {
      id: 'btn-accept-right',
      title: 'Accept Theirs — discard the result and take the whole right version',
      ariaLabel: 'Accept theirs (whole right side)',
    }),
  ]);

  const pane = (titleId: string | undefined, titleText: string, editorId: string): HTMLElement =>
    el(doc, 'div', { className: 'pane' }, [
      el(doc, 'div', { id: titleId, className: 'pane-title', text: titleText }),
      el(doc, 'div', { id: editorId, className: 'editor' }),
    ]);

  const gutter = (bodyId: string, canvasId: string): HTMLElement =>
    el(doc, 'div', { className: 'gutter' }, [
      el(doc, 'div', { className: 'pane-title' }),
      el(doc, 'div', { id: bodyId, className: 'gutter-body' }, [
        el(doc, 'canvas', { id: canvasId }),
      ]),
    ]);

  // Divider-hugging icon columns, standing in for IntelliJ's mirrored editor
  // gutters: the left editor's actions sit at its right edge, the right
  // editor's at its left edge, both against the connector dividers.
  const actionStrip = (bodyId: string): HTMLElement =>
    el(doc, 'div', { className: 'action-strip' }, [
      el(doc, 'div', { className: 'pane-title' }),
      el(doc, 'div', { id: bodyId, className: 'action-strip-body' }),
    ]);

  const panes = el(doc, 'div', { id: 'panes' }, [
    pane('left-title', '', 'left-editor'),
    actionStrip('action-left'),
    gutter('gutter-left', 'connector-left'),
    pane(undefined, 'Result', 'result-editor'),
    gutter('gutter-right', 'connector-right'),
    actionStrip('action-right'),
    pane('right-title', '', 'right-editor'),
  ]);

  const bottombar = el(doc, 'div', { id: 'bottombar' }, [
    el(doc, 'span', { id: 'banner' }),
    el(doc, 'span', { className: 'spacer' }),
    el(doc, 'button', {
      id: 'btn-apply',
      className: 'primary',
      title: 'Save the result, stage the file, and close',
      text: 'Apply',
    }),
    el(doc, 'button', {
      id: 'btn-abort',
      title: 'Close without saving; the conflict stays unresolved',
      text: 'Abort',
    }),
  ]);

  doc.body.appendChild(toolbar);
  doc.body.appendChild(panes);
  doc.body.appendChild(bottombar);
}

// IntelliJ diff toolbar glyphs, inlined as CSS masks so they take the theme's
// icon color (only the alpha channel — the stroke — matters; the source
// stroke color is recolored to white here). Paths are the verbatim geometry
// from platform/icons/src/expui/diff/*.svg.
const REVERT_ICON_MASK =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' ` +
  `viewBox='0 0 14 14' fill='none'%3E%3Cpath d='M4.66659 12.5H9.45825C11.6444 12.5 13.4166 ` +
  `10.7278 13.4166 8.54167V8.54167C13.4166 6.35554 11.6444 4.58333 9.45825 4.58333H0.5M0.5 ` +
  `4.58333L4.5 0.5M0.5 4.58333L4.5 8.5' stroke='%23fff' stroke-linecap='round' ` +
  `stroke-linejoin='round'/%3E%3C/svg%3E")`;

// applyNotConflictsLeft.svg — chevrons pointing right (apply the left side's
// non-conflicting changes into the result).
const APPLY_NC_LEFT_MASK =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' ` +
  `viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M8.5 12.5L13 8L8.5 3.5M3.5 12.5L8 8L3.5 3.5' ` +
  `stroke='%23fff' stroke-linecap='round'/%3E%3C/svg%3E")`;

// applyNotConflicts.svg — chevrons from both sides (apply every side's
// non-conflicting changes).
const APPLY_NC_ALL_MASK =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' ` +
  `viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M4.5 2.5L7.5 5.5L4.5 8.5M0.5 8.5L3.5 5.5L0.5 ` +
  `2.5' stroke='%23fff' stroke-linecap='round'/%3E%3Cpath d='M11.5 13.5L8.5 10.5L11.5 7.5M15.5 ` +
  `7.5L12.5 10.5L15.5 13.5' stroke='%23fff' stroke-linecap='round'/%3E%3C/svg%3E")`;

// applyNotConflictsRight.svg — chevrons pointing left (apply the right side's
// non-conflicting changes into the result).
const APPLY_NC_RIGHT_MASK =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' ` +
  `viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M7.5 3.5L3 8L7.5 12.5M12.5 3.5L8 8L12.5 12.5' ` +
  `stroke='%23fff' stroke-linecap='round'/%3E%3C/svg%3E")`;

/**
 * Opacity every change fill is painted at: the in-editor row band, the
 * action-strip band, and the canvas connector between panes.
 *
 * The fills must be translucent so Monaco's selection — which paints BENEATH
 * the decoration layer — stays visible through them (see
 * mergeWindowSelectionVisible.test.ts). They must also share ONE value, because
 * pane band, strip band, and connector are meant to read as a single continuous
 * channel across the window; giving the editor band alone an alpha made the
 * channel look broken at every pane boundary. CSS reads it through the
 * percentage below; the canvas reads it as `globalAlpha`.
 */
export const MERGE_FILL_ALPHA = 0.6;

/** {@link MERGE_FILL_ALPHA} as the percentage `color-mix()` wants. */
const FILL_PCT = `${Math.round(MERGE_FILL_ALPHA * 100)}%`;

/** Word-level emphasis rides on top of a chunk band, so it stays a touch stronger. */
export const MERGE_WORD_ALPHA = 0.7;

/** {@link MERGE_WORD_ALPHA} as the percentage `color-mix()` wants. */
const WORD_PCT = `${Math.round(MERGE_WORD_ALPHA * 100)}%`;

export function mergeWindowStyles(): string {
  return `
:root {
  /* IntelliJ diff semantics (green = inserted, blue = modified, red =
     conflict, grey = deleted), each riding a VS Code merge theme token so
     every theme works: inserted/modified/deleted take the merge view's
     content/header tones, conflict takes the merge editor's changed-base tone
     (--vscode-mergeEditor-changeBase-background / -word-background). Fallbacks
     are the built-in dark-theme defaults for those tokens. */
  --merge-inserted-bg: var(--vscode-merge-currentContentBackground, #2f5e52);
  --merge-inserted-strong: var(--vscode-merge-currentHeaderBackground, #3a7565);
  --merge-modified-bg: var(--vscode-merge-incomingContentBackground, #284e6e);
  --merge-modified-strong: var(--vscode-merge-incomingHeaderBackground, #2d6596);
  --merge-conflict-bg: var(--vscode-mergeEditor-changeBase-background, #4b1818);
  --merge-conflict-strong: var(--vscode-mergeEditor-changeBase-word-background, #6f1313);
  --merge-deleted-bg: var(--vscode-merge-commonContentBackground, rgba(112, 118, 124, 0.28));
  --merge-deleted-strong: var(--vscode-merge-commonHeaderBackground, rgba(112, 118, 124, 0.55));
}
html, body { height: 100%; margin: 0; padding: 0; }
body { display: flex; flex-direction: column; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
#toolbar { display: flex; align-items: center; gap: 2px; padding: 4px 8px; flex: none; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
/* Flat icon buttons (IntelliJ toolbar): no button box, glyph from ::before,
   a subtle hover highlight. The glyph is either a codicon or an inlined
   IntelliJ diff-icon mask (below). */
#toolbar button { background: none; color: var(--vscode-icon-foreground, #c5c5c5); border: none; min-width: 26px; height: 24px; padding: 0 4px; cursor: pointer; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; }
#toolbar button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31)); }
#toolbar button:disabled { opacity: 0.4; cursor: default; }
#btn-prev::before, #btn-next::before, #btn-accept-left::before, #btn-accept-right::before, #btn-magic-all::before { font-family: codicon; font-size: 16px; line-height: 1; display: inline-block; }
#btn-accept-left::before { content: '\\eab5'; }
#btn-prev::before { content: '\\eaa1'; }
#btn-next::before { content: '\\ea9a'; }
#btn-magic-all::before { content: '\\ec10'; color: var(--vscode-charts-yellow, #d8a03d); }
#btn-accept-right::before { content: '\\eab6'; }
#btn-nc-left::before, #btn-nc-all::before, #btn-nc-right::before, #btn-reset::before { content: ''; display: inline-block; width: 16px; height: 16px; background-color: var(--vscode-icon-foreground, #c5c5c5); }
#btn-nc-left::before { -webkit-mask: ${APPLY_NC_LEFT_MASK} center / 16px 16px no-repeat; mask: ${APPLY_NC_LEFT_MASK} center / 16px 16px no-repeat; }
#btn-nc-all::before { -webkit-mask: ${APPLY_NC_ALL_MASK} center / 16px 16px no-repeat; mask: ${APPLY_NC_ALL_MASK} center / 16px 16px no-repeat; }
#btn-nc-right::before { -webkit-mask: ${APPLY_NC_RIGHT_MASK} center / 16px 16px no-repeat; mask: ${APPLY_NC_RIGHT_MASK} center / 16px 16px no-repeat; }
#btn-reset::before { -webkit-mask: ${REVERT_ICON_MASK} center / 14px 14px no-repeat; mask: ${REVERT_ICON_MASK} center / 14px 14px no-repeat; }
#toolbar .sep { width: 1px; height: 18px; background: var(--vscode-panel-border); margin: 0 5px; }
.spacer { flex: 1; }
#counter { margin: 0 8px; opacity: 0.85; white-space: nowrap; }
#panes { display: flex; flex: 1; min-height: 0; }
/* One boundary per column, running the FULL height so the header and the body
   agree on where each column starts. Bordering only the gutter's title cell
   drew the sole visible boundaries in the 22px header, around the 30px gutter —
   while the apply/ignore buttons live in the neighbouring action strip, so the
   header lines marked a different column than the buttons sat in and the two
   read as misaligned. */
#panes > * { box-sizing: border-box; }
#panes > * + * { border-left: 1px solid var(--vscode-panel-border); }
.pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.pane-title { flex: none; height: 22px; line-height: 22px; padding: 0 8px; font-size: 0.85em; opacity: 0.85; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; }
.editor { flex: 1; min-height: 0; }
.gutter { flex: none; width: 30px; display: flex; flex-direction: column; }
.gutter .pane-title { padding: 0; }
.gutter-body { flex: 1; position: relative; overflow: hidden; min-height: 0; }
.gutter-body canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.action-strip { flex: none; width: 34px; display: flex; flex-direction: column; background: var(--vscode-editor-background); }
.action-strip .pane-title { padding: 0; }
.action-strip-body { flex: 1; position: relative; overflow: hidden; min-height: 0; }
.action-band { position: absolute; left: 0; right: 0; pointer-events: none; }
.action-band.k-conflict { background: var(--merge-conflict-bg); background: color-mix(in srgb, var(--merge-conflict-bg) ${FILL_PCT}, transparent); }
.action-band.k-modified { background: var(--merge-modified-bg); background: color-mix(in srgb, var(--merge-modified-bg) ${FILL_PCT}, transparent); }
.action-band.k-inserted { background: var(--merge-inserted-bg); background: color-mix(in srgb, var(--merge-inserted-bg) ${FILL_PCT}, transparent); }
.action-band.k-deleted { background: var(--merge-deleted-bg); background: color-mix(in srgb, var(--merge-deleted-bg) ${FILL_PCT}, transparent); }
.action-btn { position: absolute; z-index: 1; width: 16px; height: 18px; line-height: 18px; text-align: center; border: none; background: none; cursor: pointer; padding: 0; color: var(--vscode-icon-foreground, #c5c5c5); }
.action-btn::before { font-family: codicon; font-size: 14px; display: inline-block; }
.action-btn:hover { filter: brightness(1.4); }
.action-btn.apply { left: 0; }
.action-btn.apply.toward-result-right::before { content: '\\ea9c'; }
.action-btn.apply.toward-result-left::before { content: '\\ea9b'; }
.action-btn.ignore { right: 0; }
.action-btn.ignore::before { content: '\\ea76'; }
.action-btn.revert { left: 0; right: 0; margin: 0 auto; background-color: var(--vscode-icon-foreground, #c5c5c5); -webkit-mask: ${REVERT_ICON_MASK} center / 14px 14px no-repeat; mask: ${REVERT_ICON_MASK} center / 14px 14px no-repeat; }
#bottombar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; flex: none; border-top: 1px solid var(--vscode-panel-border); }
#banner { color: var(--vscode-charts-green, #4cbf6a); font-weight: 600; visibility: hidden; }
#banner.visible { visibility: visible; }
#bottombar button { border: none; padding: 6px 18px; font-size: 1.05em; cursor: pointer; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
#bottombar button.primary { background: var(--vscode-button-background, #2f7bd6); color: var(--vscode-button-foreground, #ffffff); }
#bottombar button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #3f8be6); }
#bottombar button:disabled { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-disabledForeground, #888888); opacity: 0.6; cursor: default; }
/* Monaco paints the selection (SelectionsOverlay) BEFORE line decorations
   (DecorationsOverlay) inside the same per-line overlay container, so a chunk
   fill sits ON TOP of the selection highlight: selecting inside a conflict
   showed the selection colour seen THROUGH the fill, which reads muddy rather
   than as the theme's selection colour.

   Fixed by sinking the fills BELOW the selection — deliberately not by lifting
   the selection. A positive z-index on .selected-text escapes .view-overlays
   (position:absolute, z-index:auto, so not a stacking context) and paints the
   selection over the sibling .view-lines glyphs, making selected text
   unreadable. Sending the fills DOWN cannot reach the glyphs whatever happens.
   .view-overlays is isolated so the negative z-index stays inside it and the
   fills keep painting above the editor background instead of behind it.

   The fills stay translucent so the pane band, action-strip band and canvas
   connector read as one continuous channel (see MERGE_FILL_ALPHA). The plain
   background is declared first so an engine without color-mix still gets a
   visible fill. */
.monaco-editor .view-overlays { isolation: isolate; }
.merge-conflict, .merge-modified, .merge-inserted, .merge-deleted,
.merge-word.k-conflict, .merge-word.k-modified, .merge-word.k-inserted, .merge-word.k-deleted { z-index: -1; }
/* Active-pane selection colour. Monaco ships
   ".monaco-editor .focused .selected-text" for this, but that is a DESCENDANT
   selector while its own focus class lands on the .monaco-editor element, so it
   never matches and every selection falls through to the inactive grey. The
   focused pane is marked by wireFocusedPaneClass instead, which depends on
   Monaco's focus EVENTS rather than its class name. Colours carry literal
   fallbacks: a var() that does not resolve drops the whole declaration, which
   would silently land back on the grey rule. */
.monaco-editor.${PANE_FOCUSED_CLASS} .selected-text { background-color: var(--vscode-editor-selectionBackground, #264f78); }
.monaco-editor:not(.${PANE_FOCUSED_CLASS}) .selected-text { background-color: var(--vscode-editor-inactiveSelectionBackground, #3a3d41); }
.merge-conflict { background: var(--merge-conflict-bg); background: color-mix(in srgb, var(--merge-conflict-bg) ${FILL_PCT}, transparent); }
.merge-modified { background: var(--merge-modified-bg); background: color-mix(in srgb, var(--merge-modified-bg) ${FILL_PCT}, transparent); }
.merge-inserted { background: var(--merge-inserted-bg); background: color-mix(in srgb, var(--merge-inserted-bg) ${FILL_PCT}, transparent); }
.merge-deleted { background: var(--merge-deleted-bg); background: color-mix(in srgb, var(--merge-deleted-bg) ${FILL_PCT}, transparent); }
.merge-empty { border-top: 2px solid var(--merge-deleted-strong); background: transparent; }
.merge-empty.k-conflict { border-top-color: var(--merge-conflict-strong); }
.merge-empty.k-modified { border-top-color: var(--merge-modified-strong); }
.merge-empty.k-inserted { border-top-color: var(--merge-inserted-strong); }
/* Word-level emphasis rides on top of the chunk fill, so it stays translucent
   too — same reason, and it keeps the two tones distinguishable when they
   compose. */
.merge-word.k-conflict { background: var(--merge-conflict-strong); background: color-mix(in srgb, var(--merge-conflict-strong) ${WORD_PCT}, transparent); }
.merge-word.k-modified { background: var(--merge-modified-strong); background: color-mix(in srgb, var(--merge-modified-strong) ${WORD_PCT}, transparent); }
.merge-word.k-inserted { background: var(--merge-inserted-strong); background: color-mix(in srgb, var(--merge-inserted-strong) ${WORD_PCT}, transparent); }
.merge-word.k-deleted { background: var(--merge-deleted-strong); background: color-mix(in srgb, var(--merge-deleted-strong) ${WORD_PCT}, transparent); }
.merge-resolved-top.k-conflict { border-top: 1px dotted var(--merge-conflict-strong); }
.merge-resolved-top.k-modified { border-top: 1px dotted var(--merge-modified-strong); }
.merge-resolved-top.k-inserted { border-top: 1px dotted var(--merge-inserted-strong); }
.merge-resolved-top.k-deleted { border-top: 1px dotted var(--merge-deleted-strong); }
.merge-resolved-bottom.k-conflict { border-bottom: 1px dotted var(--merge-conflict-strong); }
.merge-resolved-bottom.k-modified { border-bottom: 1px dotted var(--merge-modified-strong); }
.merge-resolved-bottom.k-inserted { border-bottom: 1px dotted var(--merge-inserted-strong); }
.merge-resolved-bottom.k-deleted { border-bottom: 1px dotted var(--merge-deleted-strong); }
.merge-glyph-magic::before { font-family: codicon; content: '\\ec10'; color: var(--vscode-charts-yellow, #d8a03d); cursor: pointer; display: inline-block; width: 100%; text-align: center; }`;
}

/** IntelliJ diff semantics for coloring a change. */
export type MergeChangeKind = 'conflict' | 'modified' | 'inserted' | 'deleted';

/**
 * Connector color per change kind: the CSS variable to read at runtime (so
 * canvas fills match the theme-derived highlight colors exactly) and the
 * fallback used when the variable does not resolve (jsdom harness). Uses the
 * row-highlight (-bg) tone so pane band, strip band, and connector read as
 * one continuous channel; word-level emphasis keeps the -strong tone.
 */
export const MERGE_KIND_CONNECTOR_COLORS: Record<
  MergeChangeKind,
  { cssVar: string; fallback: string }
> = {
  conflict: { cssVar: '--merge-conflict-bg', fallback: '#4b1818' },
  modified: { cssVar: '--merge-modified-bg', fallback: '#284e6e' },
  inserted: { cssVar: '--merge-inserted-bg', fallback: '#2f5e52' },
  deleted: { cssVar: '--merge-deleted-bg', fallback: 'rgba(112, 118, 124, 0.28)' },
};

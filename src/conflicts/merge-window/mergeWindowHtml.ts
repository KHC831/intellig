// The merge window's DOM skeleton and styles. The skeleton is built with
// createElement (the repo-wide webview convention — no HTML strings) by the
// webview script at boot; the panel ships an empty body. Shared with the
// jsdom harness so the tested DOM is the shipped DOM.
//
// Layout, per IntelliJ's merge dialog: action toolbar top-left with the
// unresolved counter on its right; three panes separated by two dividers
// that carry ONLY the curved canvas connectors linking each side block to
// its result block. The per-change apply/ignore/revert icons live in
// divider-hugging action strips (Monaco cannot mirror a gutter the way
// IntelliJ does); the result editor's glyph margin carries only the
// magic-resolve wand; big Apply/Abort buttons bottom-right.

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: { id?: string; className?: string; title?: string; text?: string },
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
  if (attrs.text !== undefined) {
    node.textContent = attrs.text;
  }
  for (const child of children) {
    node.appendChild(child);
  }
  return node;
}

const UP = String.fromCharCode(0x25b2);
const DOWN = String.fromCharCode(0x25bc);

/** Builds the merge window skeleton into the given document's body. */
export function buildMergeWindowDom(doc: Document): void {
  const toolbar = el(doc, 'div', { id: 'toolbar' }, [
    el(doc, 'button', {
      id: 'btn-accept-left',
      title: 'Discard the result and take the whole left version',
      text: 'Accept Yours',
    }),
    el(doc, 'span', { className: 'spacer' }),
    el(doc, 'button', { id: 'btn-prev', title: 'Previous unresolved change', text: UP }),
    el(doc, 'button', { id: 'btn-next', title: 'Next unresolved change', text: DOWN }),
    el(doc, 'span', { className: 'sep' }),
    el(doc, 'button', {
      id: 'btn-reset',
      title: 'Reset all resolved changes back to unresolved (Cmd/Ctrl+Z undoes the reset)',
      text: 'Reset',
    }),
    el(doc, 'span', { id: 'counter' }),
    el(doc, 'span', { className: 'spacer' }),
    el(doc, 'button', {
      id: 'btn-accept-right',
      title: 'Discard the result and take the whole right version',
      text: 'Accept Theirs',
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

// IntelliJ's Diff.Revert icon (expui/diff/revert@14x14.svg), inlined as a CSS
// mask so it takes the theme's icon color. Only the alpha channel matters.
const REVERT_ICON_MASK =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' ` +
  `viewBox='0 0 14 14' fill='none'%3E%3Cpath d='M4.66659 12.5H9.45825C11.6444 12.5 13.4166 ` +
  `10.7278 13.4166 8.54167V8.54167C13.4166 6.35554 11.6444 4.58333 9.45825 4.58333H0.5M0.5 ` +
  `4.58333L4.5 0.5M0.5 4.58333L4.5 8.5' stroke='%23fff' stroke-linecap='round' ` +
  `stroke-linejoin='round'/%3E%3C/svg%3E")`;

export function mergeWindowStyles(): string {
  return `
:root {
  /* IntelliJ diff semantics (green = inserted, blue = modified, red =
     conflict, grey = deleted) in the tones of VS Code's own conflict
     decorations. Fallbacks are sampled from the built-in view on the default
     dark theme. */
  --merge-inserted-bg: var(--vscode-merge-currentContentBackground, #2f5e52);
  --merge-inserted-strong: var(--vscode-merge-currentHeaderBackground, #3a7565);
  --merge-modified-bg: var(--vscode-merge-incomingContentBackground, #284e6e);
  --merge-modified-strong: var(--vscode-merge-incomingHeaderBackground, #2d6596);
  --merge-conflict-bg: #6b2e35;
  --merge-conflict-strong: #a03d49;
  --merge-deleted-bg: var(--vscode-merge-commonContentBackground, rgba(112, 118, 124, 0.28));
  --merge-deleted-strong: var(--vscode-merge-commonHeaderBackground, rgba(112, 118, 124, 0.55));
}
html, body { height: 100%; margin: 0; padding: 0; }
body { display: flex; flex-direction: column; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
#toolbar { display: flex; align-items: center; gap: 4px; padding: 5px 8px; flex: none; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
#toolbar button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; cursor: pointer; border-radius: 3px; }
#toolbar button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
#toolbar button:disabled { opacity: 0.45; cursor: default; }
#toolbar .sep { width: 1px; height: 18px; background: var(--vscode-panel-border); margin: 0 5px; }
.spacer { flex: 1; }
#counter { margin: 0 8px; opacity: 0.85; white-space: nowrap; }
#panes { display: flex; flex: 1; min-height: 0; }
.pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.pane-title { flex: none; height: 22px; line-height: 22px; padding: 0 8px; font-size: 0.85em; opacity: 0.85; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; }
.editor { flex: 1; min-height: 0; }
.gutter { flex: none; width: 30px; display: flex; flex-direction: column; border-left: 1px solid var(--vscode-panel-border); border-right: 1px solid var(--vscode-panel-border); }
.gutter .pane-title { padding: 0; }
.gutter-body { flex: 1; position: relative; overflow: hidden; min-height: 0; }
.gutter-body canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.action-strip { flex: none; width: 34px; display: flex; flex-direction: column; background: var(--vscode-editor-background); }
.action-strip .pane-title { padding: 0; }
.action-strip-body { flex: 1; position: relative; overflow: hidden; min-height: 0; }
.action-btn { position: absolute; width: 16px; height: 18px; line-height: 18px; text-align: center; border: none; background: none; cursor: pointer; padding: 0; }
.action-btn::before { font-family: codicon; font-size: 14px; display: inline-block; }
.action-btn:hover { filter: brightness(1.4); }
.action-btn.apply { left: 0; color: var(--vscode-charts-green, #73c991); }
.action-btn.apply.toward-result-right::before { content: '\\ea9c'; }
.action-btn.apply.toward-result-left::before { content: '\\ea9b'; }
.action-btn.ignore { right: 0; color: var(--vscode-editorError-foreground, #f14c4c); }
.action-btn.ignore::before { content: '\\ea76'; }
.action-btn.revert { left: 0; right: 0; margin: 0 auto; background-color: var(--vscode-icon-foreground, #c5c5c5); -webkit-mask: ${REVERT_ICON_MASK} center / 14px 14px no-repeat; mask: ${REVERT_ICON_MASK} center / 14px 14px no-repeat; }
#bottombar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; flex: none; border-top: 1px solid var(--vscode-panel-border); }
#banner { color: var(--vscode-charts-green, #4cbf6a); font-weight: 600; visibility: hidden; }
#banner.visible { visibility: visible; }
#bottombar button { border: none; padding: 6px 18px; font-size: 1.05em; cursor: pointer; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
#bottombar button.primary { background: var(--vscode-button-background, #2f7bd6); color: var(--vscode-button-foreground, #ffffff); }
#bottombar button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #3f8be6); }
#bottombar button:disabled { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-disabledForeground, #888888); opacity: 0.6; cursor: default; }
.merge-conflict { background: var(--merge-conflict-bg); }
.merge-modified { background: var(--merge-modified-bg); }
.merge-inserted { background: var(--merge-inserted-bg); }
.merge-deleted { background: var(--merge-deleted-bg); }
.merge-empty { border-top: 2px solid var(--merge-deleted-strong); background: transparent; }
.merge-word.k-conflict { background: var(--merge-conflict-strong); }
.merge-word.k-modified { background: var(--merge-modified-strong); }
.merge-word.k-inserted { background: var(--merge-inserted-strong); }
.merge-word.k-deleted { background: var(--merge-deleted-strong); }
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
 * fallback used when the variable does not resolve (jsdom harness).
 */
export const MERGE_KIND_CONNECTOR_COLORS: Record<
  MergeChangeKind,
  { cssVar: string; fallback: string }
> = {
  conflict: { cssVar: '--merge-conflict-strong', fallback: '#a03d49' },
  modified: { cssVar: '--merge-modified-strong', fallback: '#2d6596' },
  inserted: { cssVar: '--merge-inserted-strong', fallback: '#3a7565' },
  deleted: { cssVar: '--merge-deleted-strong', fallback: 'rgba(112, 118, 124, 0.55)' },
};

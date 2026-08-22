/// <reference lib="dom" />
// The Commit Tool Window's inline diff-preview pane: a persistent element the
// entry builds once, reset to a placeholder when nothing is selected and
// refilled from the host's `updateDiffPreview` messages.
//
// Nodes are built with createElement (no innerHTML with interpolated content)
// so a hostile path or diff line can't inject markup.

import type { IDiff, IHunk, IDiffLine } from '../../git-core/interfaces/gitModels';

/** Persistent diff-preview pane, born with the placeholder. */
export function buildDiffPreviewPane(): HTMLDivElement {
  const pane = document.createElement('div');
  pane.className = 'ctw-diff-preview';
  pane.setAttribute('data-diff-preview', '');
  resetPreviewPane(pane);
  return pane;
}

export function resetPreviewPane(pane: Element): void {
  while (pane.firstChild) {
    pane.removeChild(pane.firstChild);
  }
  const placeholder = document.createElement('div');
  placeholder.className = 'ctw-diff-preview-empty';
  placeholder.textContent = 'Select a file to preview changes';
  pane.appendChild(placeholder);
}

export function renderDiffPreview(
  pane: Element,
  path: string | undefined,
  diff: IDiff | undefined,
  error: string | undefined
): void {
  while (pane.firstChild) {
    pane.removeChild(pane.firstChild);
  }
  const head = document.createElement('div');
  head.className = 'ctw-diff-preview-head';
  head.textContent = path || '';
  pane.appendChild(head);
  if (error) {
    const err = document.createElement('div');
    err.className = 'ctw-diff-preview-empty';
    err.textContent = 'Failed to load diff: ' + error;
    pane.appendChild(err);
    return;
  }
  if (!diff || diff.binary || !diff.hunks || diff.hunks.length === 0) {
    const note = document.createElement('div');
    note.className = 'ctw-diff-preview-empty';
    note.textContent = diff && diff.binary ? 'Binary file' : 'No changes';
    pane.appendChild(note);
    return;
  }
  const body = document.createElement('pre');
  body.className = 'ctw-diff-preview-body';
  (diff.hunks || []).forEach((hunk: IHunk) => {
    const h = document.createElement('div');
    h.className = 'ctw-diff-hunk-header';
    h.textContent = hunk.header || '';
    body.appendChild(h);
    (hunk.lines || []).forEach((line: IDiffLine) => {
      const rowDiv = document.createElement('div');
      const t = line.type === 'add' ? 'add' : line.type === 'delete' ? 'del' : 'ctx';
      rowDiv.className = 'ctw-diff-line ctw-diff-' + t;
      const prefix = t === 'add' ? '+' : t === 'del' ? '-' : ' ';
      rowDiv.textContent = prefix + (line.content ?? '');
      body.appendChild(rowDiv);
    });
  });
  pane.appendChild(body);
}

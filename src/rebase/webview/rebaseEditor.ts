/// <reference lib="dom" />
// Webview entry for the interactive Rebase Editor (bundled into
// media/webview/rebaseEditor.js). Reads init from the host's `data-init` island,
// builds the draggable commit list + per-row action selects + reword/squash
// message editors, and posts protocol-typed reorder/updateAction/updateMessage/
// execute/cancel. The host updates by re-rendering the whole HTML, so scroll
// position is persisted through a WebviewStateSlot and restored across renders.

import type {
  IRebaseEditorCommit,
  IRebaseEditorInit,
  RebaseEditorInbound,
} from '../rebaseEditor.protocol';
import type { RebaseAction } from '../../git-core/interfaces/rebaseAction';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../utils/webviewInit';
import {
  loadWebviewState,
  saveWebviewState,
  type IWebviewStateApi,
  type IWebviewStateSlot,
} from '../../utils/webviewStateSlot';

declare function acquireVsCodeApi(): IWebviewStateApi & {
  postMessage(message: unknown): void;
};

const vscodeApi = acquireVsCodeApi();

function post(message: RebaseEditorInbound): void {
  vscodeApi.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props ?? {});
}

/** Commit-list scroll position, restored across the host's full re-renders. */
const SCROLL_SLOT: IWebviewStateSlot<number> = {
  key: 'rebaseScroll',
  version: 1,
  validate: (raw) => (typeof raw === 'number' && raw >= 0 ? raw : undefined),
};

const LEGEND: [string, string][] = [
  ['pick', 'pick - use commit'],
  ['reword', 'reword - edit message'],
  ['edit', 'edit - stop for amending'],
  ['squash', 'squash - meld into commit above'],
  ['fixup', 'fixup - meld into above, drop message'],
  ['drop', 'drop - remove commit'],
];

function render(init: IRebaseEditorInit): void {
  const root = document.getElementById('rebase-root');
  if (!root) {
    return;
  }

  const updateAction = (hash: string, action: RebaseAction): void => {
    post({ type: 'updateAction', hash, action });
  };
  const updateMessage = (hash: string, message: string): void => {
    post({ type: 'updateMessage', hash, message });
  };

  // Build a reword/squash message box; used by the initial render AND the
  // in-place action switch so both produce an identically-wired textarea.
  const buildMessageEditor = (
    hash: string,
    action: RebaseAction,
    value: string
  ): HTMLDivElement => {
    const editor = el('div', { className: 'reword-message-editor' });
    const ta = el('textarea', {
      className: 'reword-message-input',
      rows: 3,
      placeholder: init.placeholders[action] ?? '',
    });
    ta.setAttribute('data-hash', hash);
    ta.value = value;
    ta.addEventListener('input', () => updateMessage(hash, ta.value));
    editor.append(ta);
    return editor;
  };

  // ── Header ──────────────────────────────────────────────────────────────
  const header = el('div', { className: 'header' });
  header.append(el('h2', { textContent: 'Interactive Rebase' }));
  const info = el('div', { className: 'rebase-info' });
  const infoItem = (label: string, value: string | number): HTMLSpanElement => {
    const span = el('span', { className: 'info-item' });
    span.append(
      el('span', { className: 'info-label', textContent: label }),
      el('span', { className: 'info-value', textContent: String(value) })
    );
    return span;
  };
  info.append(
    infoItem('Rebasing:', init.originalBranch),
    infoItem('Onto:', init.onto),
    infoItem('Commits:', init.commitCount)
  );
  header.append(info);
  const instructions = el('div', { className: 'instructions' });
  instructions.append(
    el('p', { textContent: 'Drag commits to reorder. Select an action for each commit.' }),
    el('p', {
      className: 'hint',
      textContent:
        'Order: oldest at the top, newest at the bottom — commits are applied top to bottom.',
    }),
    el('p', {
      className: 'hint',
      textContent:
        'squash and fixup meld a commit into the one directly above it (the previous, older commit).',
    })
  );
  header.append(instructions);
  root.append(header);

  // ── Commit list ─────────────────────────────────────────────────────────
  if (init.commits.length === 0) {
    const empty = el('div', { className: 'commit-list empty' });
    empty.append(el('p', { className: 'empty-message', textContent: 'No commits to rebase' }));
    root.append(empty);
  } else {
    const list = el('div', { className: 'commit-list', id: 'commit-list' });
    init.commits.forEach((commit, index) => {
      const item = el('div', { className: 'commit-item ' + commit.actionClass, draggable: true });
      item.setAttribute('data-hash', commit.hash);
      item.setAttribute('data-index', String(index));
      item.append(
        el('div', { className: 'drag-handle', title: 'Drag to reorder', textContent: '⋮⋮' })
      );

      const selector = el('div', { className: 'action-selector' });
      const select = el('select', { className: 'action-dropdown' });
      select.setAttribute('data-hash', commit.hash);
      for (const a of init.actions) {
        const opt = el('option', { value: a.value, title: a.description, textContent: a.label });
        opt.selected = a.value === commit.action;
        select.append(opt);
      }
      selector.append(select);
      item.append(selector);

      item.append(
        el('div', { className: 'commit-hash', title: commit.hash, textContent: commit.shortHash }),
        el('div', {
          className: 'commit-message',
          title: commit.message,
          textContent: commit.message,
        })
      );

      if (commit.showMessageEditor) {
        item.append(buildMessageEditor(commit.hash, commit.action, commit.rewordValue));
      }
      list.append(item);
    });
    root.append(list);
    wireScroll(list);
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  const footer = el('div', { className: 'footer' });
  const legend = el('div', { className: 'action-legend' });
  for (const [cls, text] of LEGEND) {
    legend.append(el('span', { className: 'legend-item ' + cls, textContent: text }));
  }
  footer.append(legend);
  const buttonRow = el('div', { className: 'button-row' });
  const cancelBtn = el('button', { className: 'button cancel-button', textContent: 'Cancel' });
  cancelBtn.setAttribute('data-action', 'cancel');
  const executeBtn = el('button', {
    className: 'button execute-button',
    textContent: 'Start Rebase',
  });
  executeBtn.setAttribute('data-action', 'execute');
  buttonRow.append(cancelBtn, executeBtn);
  footer.append(buttonRow);
  root.append(footer);

  // Persist + restore the commit-list scroll across the host's full re-renders.
  function wireScroll(list: HTMLElement): void {
    list.addEventListener('scroll', () => {
      saveWebviewState(vscodeApi, SCROLL_SLOT, list.scrollTop);
    });
    if (!init.preserveScroll) {
      saveWebviewState(vscodeApi, SCROLL_SLOT, 0);
      return;
    }
    const saved = loadWebviewState(vscodeApi, SCROLL_SLOT);
    if (typeof saved !== 'number' || saved <= 0) {
      return;
    }
    // Apply now AND once on the next frame: the Electron webview can clamp a
    // synchronous scrollTop set before its first layout pass. Exactly one retry.
    list.scrollTop = saved;
    if (typeof requestAnimationFrame === 'function') {
      // async-guard-exempt: a single scrollTop write on an element captured above.
      requestAnimationFrame(() => {
        list.scrollTop = saved;
      });
    }
  }

  // Apply an action change to a single row in place (host does NOT re-render on
  // updateAction): swap the color class and show/hide the reword/squash box.
  function applyActionToItem(item: HTMLElement | null, hash: string, action: RebaseAction): void {
    if (!item) {
      return;
    }
    Array.from(item.classList).forEach((cls) => {
      if (cls.indexOf('action-') === 0) {
        item.classList.remove(cls);
      }
    });
    item.classList.add('action-' + action);

    const showEditor = action === 'reword' || action === 'squash';
    const editor = item.querySelector('.reword-message-editor');
    // Reword seeds with the commit's own message (edit it in place); squash
    // seeds EMPTY — blank means "auto-combine both messages" (the git squash
    // rule), and a typed value overrides the whole fold's message. The host
    // clears any typed message on an action change, so an existing box is
    // reseeded here rather than keeping a value whose meaning changed.
    const orig = init.commits.find((c: IRebaseEditorCommit) => c.hash === hash);
    const seed = action === 'reword' && orig ? orig.message : '';
    if (showEditor && !editor) {
      item.append(buildMessageEditor(hash, action, seed));
    } else if (showEditor && editor) {
      const ta = editor.querySelector<HTMLTextAreaElement>('.reword-message-input');
      if (ta) {
        ta.placeholder = init.placeholders[action] ?? '';
        ta.value = seed;
      }
    } else if (editor) {
      editor.remove();
    }
  }

  // ── Drag and drop ─────────────────────────────────────────────────────────
  let draggedElement: HTMLElement | null = null;
  let draggedIndex = -1;

  const initDragAndDrop = (): void => {
    const commitList = document.getElementById('commit-list');
    if (!commitList) {
      return;
    }
    commitList.querySelectorAll<HTMLElement>('.commit-item').forEach((item) => {
      item.addEventListener('dragstart', handleDragStart);
      item.addEventListener('dragend', handleDragEnd);
      item.addEventListener('dragover', handleDragOver);
      item.addEventListener('dragenter', handleDragEnter);
      item.addEventListener('dragleave', handleDragLeave);
      item.addEventListener('drop', handleDrop);
    });
  };

  function handleDragStart(e: DragEvent): void {
    draggedElement = (e.target as HTMLElement).closest('.commit-item');
    draggedIndex = parseInt(draggedElement?.dataset.index ?? '-1', 10);
    draggedElement?.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedIndex.toString());
    }
  }
  function handleDragEnd(): void {
    draggedElement?.classList.remove('dragging');
    document.querySelectorAll('.commit-item').forEach((item) => item.classList.remove('drag-over'));
    draggedElement = null;
    draggedIndex = -1;
  }
  function handleDragOver(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  }
  function handleDragEnter(e: DragEvent): void {
    e.preventDefault();
    const target = (e.target as HTMLElement).closest('.commit-item');
    if (target && target !== draggedElement) {
      target.classList.add('drag-over');
    }
  }
  function handleDragLeave(e: DragEvent): void {
    const target = (e.target as HTMLElement).closest('.commit-item');
    if (target) {
      target.classList.remove('drag-over');
    }
  }
  function handleDrop(e: DragEvent): void {
    e.preventDefault();
    const target = (e.target as HTMLElement).closest<HTMLElement>('.commit-item');
    if (!target || target === draggedElement) {
      return;
    }
    const toIndex = parseInt(target.dataset.index ?? '-1', 10);
    if (draggedIndex !== -1 && toIndex !== draggedIndex) {
      post({ type: 'reorder', fromIndex: draggedIndex, toIndex });
    }
    target.classList.remove('drag-over');
  }

  // Wire the action dropdowns + footer buttons (reword textareas wire their own
  // input handler in buildMessageEditor).
  const initControls = (): void => {
    document.querySelectorAll<HTMLSelectElement>('.action-dropdown').forEach((sel) => {
      sel.addEventListener('change', () => {
        const hash = sel.dataset.hash ?? '';
        const action = sel.value as RebaseAction;
        updateAction(hash, action);
        applyActionToItem(sel.closest<HTMLElement>('.commit-item'), hash, action);
      });
    });
    document.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!target) {
        return;
      }
      if (target.dataset.action === 'cancel') {
        post({ type: 'cancel' });
      } else if (target.dataset.action === 'execute') {
        post({ type: 'execute' });
      }
    });
  };

  initDragAndDrop();
  initControls();
}

// Plain panels self-boot: the bundle runs this on load (no inline caller).
function boot(): void {
  const island = document.getElementById(INIT_ELEMENT_ID);
  const init = parseInitIsland<IRebaseEditorInit>(island?.getAttribute('data-init'));
  render(init);
}

boot();

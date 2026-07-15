/// <reference lib="dom" />
// Webview entry for the Commit dialog (bundled into media/webview/commitDialog.js).
// Reads init from the host's `data-init` island, builds the message + files +
// diff-preview + footer via createElement, and posts protocol-typed messages
// (commit/cancel/stage/unstage/hunk + line partial-staging + author/gear/recent).
// The host updates by re-rendering the whole HTML, so there is no host→webview
// message handling (outbound is `never`).

import type {
  CommitDialogInbound,
  ICommitDialogInit,
  ICommitDialogFileItem,
  ICommitDialogDiffHunk,
} from '../commitDialog.protocol';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../utils/webviewInit';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscodeApi = acquireVsCodeApi();

function post(message: CommitDialogInbound): void {
  vscodeApi.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props ?? {});
}

function setData<T extends Element>(node: T, attrs: Record<string, string>): T {
  for (const k in attrs) {
    node.setAttribute(k, attrs[k]);
  }
  return node;
}

function render(INIT: ICommitDialogInit): void {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }

  // ── Message section ─────────────────────────────────────────────────────
  const messageSection = el('div', { className: 'section message-section' });
  const msgHeader = el('div', { className: 'section-header' });
  msgHeader.append(el('span', { className: 'section-title', textContent: 'Commit Message' }));
  const headerActions = el('div', { className: 'section-header-actions' });
  const recentBtn = el('button', {
    id: 'recent-messages-btn',
    className: 'header-action-button',
    type: 'button',
    title: INIT.recentBtnTitle,
    textContent: '∨',
  });
  setData(recentBtn, { 'data-action': 'openRecentMessages' });
  recentBtn.disabled = !INIT.hasRecent;
  const gearBtn = el('button', {
    id: 'gear-btn',
    className: 'header-action-button',
    type: 'button',
    title: 'Commit options',
    textContent: '⚙',
  });
  setData(gearBtn, { 'data-action': 'openGearMenu' });
  headerActions.append(recentBtn, gearBtn);
  msgHeader.append(headerActions);
  messageSection.append(msgHeader);
  const textarea = el('textarea', {
    id: 'commit-message',
    className: 'commit-message-input',
    placeholder: 'Enter commit message...',
  });
  textarea.value = INIT.message;
  messageSection.append(textarea);
  // Author section
  const authorSection = el('div', { className: 'author-section' });
  authorSection.append(
    el('label', {
      htmlFor: 'commit-author',
      className: 'author-label',
      textContent: 'Author (optional):',
    })
  );
  const authorInput = el('input', {
    id: 'commit-author',
    className: 'author-input',
    type: 'text',
    placeholder: 'Name <email@example.com>',
  });
  authorInput.value = INIT.author;
  authorSection.append(authorInput);
  if (INIT.authorError) {
    const errDiv = el('div', { className: 'author-error', textContent: INIT.authorError });
    errDiv.setAttribute('role', 'alert');
    authorSection.append(errDiv);
  }
  messageSection.append(authorSection);
  if (INIT.noVerify) {
    const badge = el('div', { className: 'no-verify-badge' });
    badge.setAttribute('role', 'note');
    badge.append(
      '⚠ Git hooks will be skipped (',
      el('code', { textContent: '--no-verify' }),
      '). Open the gear menu to turn this off.'
    );
    messageSection.append(badge);
  }

  // ── Files section ───────────────────────────────────────────────────────
  const filesSection = el('div', { className: 'section files-section' });
  const filesHeader = el('div', { className: 'section-header' });
  filesHeader.append(el('span', { className: 'section-title', textContent: 'Changes' }));
  const refreshBtn = el('button', {
    className: 'refresh-button',
    title: 'Refresh',
    textContent: '↻',
  });
  setData(refreshBtn, { 'data-action': 'refresh' });
  filesHeader.append(refreshBtn);
  filesSection.append(filesHeader);
  const filesList = el('div', { className: 'files-list' });
  const buildFileItem = (f: ICommitDialogFileItem): HTMLDivElement => {
    const item = el('div', { className: 'file-item' + (f.isSelected ? ' selected' : '') });
    setData(item, { 'data-path': f.path, 'data-action': 'selectFile' });
    const cb = el('input', { type: 'checkbox', className: 'file-checkbox' });
    cb.checked = f.selected;
    setData(cb, { 'data-action': 'toggleFile', 'data-path': f.path });
    const status = el('span', { className: 'file-status', textContent: f.statusChar });
    status.style.color = f.statusColor;
    const stageBtn = f.staged
      ? setData(
          el('button', { className: 'stage-button unstage', title: 'Unstage', textContent: '−' }),
          {
            'data-action': 'unstageFile',
            'data-path': f.path,
          }
        )
      : setData(
          el('button', { className: 'stage-button stage', title: 'Stage', textContent: '+' }),
          {
            'data-action': 'stageFile',
            'data-path': f.path,
          }
        );
    item.append(
      cb,
      status,
      el('span', { className: 'file-path', textContent: f.fileName }),
      el('span', { className: 'file-dir', textContent: f.fileDir }),
      stageBtn
    );
    return item;
  };
  const fileGroup = (label: string, files: ICommitDialogFileItem[]): HTMLDivElement => {
    const group = el('div', { className: 'file-group' });
    group.append(
      el('div', { className: 'file-group-header', textContent: label + ' (' + files.length + ')' })
    );
    for (const f of files) {
      group.append(buildFileItem(f));
    }
    return group;
  };
  if (INIT.stagedFiles.length > 0) {
    filesList.append(fileGroup('Staged Changes', INIT.stagedFiles));
  }
  if (INIT.unstagedFiles.length > 0) {
    filesList.append(fileGroup('Unstaged Changes', INIT.unstagedFiles));
  }
  if (INIT.stagedFiles.length === 0 && INIT.unstagedFiles.length === 0) {
    filesList.append(
      el('div', { className: 'empty-message', textContent: 'No changes to commit' })
    );
  }
  filesSection.append(filesList);

  // ── Diff preview section ────────────────────────────────────────────────
  const diff = INIT.diff;
  const buildHunk = (hunk: ICommitDialogDiffHunk): HTMLDivElement => {
    const h = el('div', { className: 'diff-hunk' });
    const headerRow = el('div', { className: 'hunk-header-row' });
    headerRow.append(el('div', { className: 'hunk-header', textContent: hunk.header }));
    const hunkControls = el('div', { className: 'hunk-controls' });
    if (hunk.isStaged) {
      hunkControls.append(
        setData(
          el('button', {
            className: 'hunk-button unstage-hunk',
            title: 'Unstage this hunk',
            textContent: '− Unstage Hunk',
          }),
          { 'data-action': 'unstageHunk', 'data-hunk-index': String(hunk.hunkIndex) }
        )
      );
    } else {
      hunkControls.append(
        setData(
          el('button', {
            className: 'hunk-button stage-hunk',
            title: 'Stage this hunk',
            textContent: '+ Stage Hunk',
          }),
          { 'data-action': 'stageHunk', 'data-hunk-index': String(hunk.hunkIndex) }
        ),
        setData(
          el('button', {
            className: 'hunk-button revert-hunk',
            title: "Discard this hunk's changes",
            textContent: '↶ Revert Hunk',
          }),
          { 'data-action': 'revertHunk', 'data-hunk-index': String(hunk.hunkIndex) }
        )
      );
    }
    headerRow.append(hunkControls);
    h.append(headerRow);
    if (diff && diff.partialStagingMode) {
      const lsc = el('div', { className: 'line-selection-controls' });
      lsc.append(
        setData(
          el('button', {
            className: 'hunk-button select-all',
            title: 'Select all changed lines',
            textContent: 'Select All',
          }),
          { 'data-action': 'selectAllLinesInHunk', 'data-hunk-index': String(hunk.hunkIndex) }
        ),
        setData(
          el('button', {
            className: 'hunk-button deselect-all',
            title: 'Deselect all lines',
            textContent: 'Deselect All',
          }),
          { 'data-action': 'deselectAllLinesInHunk', 'data-hunk-index': String(hunk.hunkIndex) }
        )
      );
      if (hunk.hasSelectedLines && !hunk.isStaged) {
        lsc.append(
          setData(
            el('button', {
              className: 'hunk-button stage-selected',
              title: 'Stage selected lines',
              textContent:
                '+ Stage ' + hunk.selectedCount + ' Line' + (hunk.selectedCount !== 1 ? 's' : ''),
            }),
            { 'data-action': 'stageSelectedLines', 'data-hunk-index': String(hunk.hunkIndex) }
          )
        );
      }
      h.append(lsc);
    }
    for (const line of hunk.lines) {
      const lineEl = el('div', { className: line.lineClass });
      if (line.selectable) {
        setData(lineEl, {
          'data-action': 'toggleLine',
          'data-hunk-index': String(line.selectable.hunkIndex),
          'data-line-number': String(line.selectable.lineNumber),
          'data-line-type': line.selectable.lineType,
        });
      }
      if (line.checkbox) {
        lineEl.append(el('span', { className: 'line-checkbox', textContent: line.checkbox }));
      }
      lineEl.append(
        el('span', { className: 'line-num old', textContent: line.oldNum }),
        el('span', { className: 'line-num new', textContent: line.newNum }),
        el('span', { className: 'line-prefix', textContent: line.prefix }),
        el('span', { className: 'line-content', textContent: line.content })
      );
      h.append(lineEl);
    }
    return h;
  };
  const diffSection = el('div', { className: 'section diff-section' });
  const diffHeader = el('div', { className: 'section-header' });
  if (!diff) {
    diffHeader.append(el('span', { className: 'section-title', textContent: 'Diff Preview' }));
    diffSection.append(diffHeader);
    const dc = el('div', { className: 'diff-content empty' });
    dc.append(
      el('div', { className: 'empty-message', textContent: 'Select a file to preview changes' })
    );
    diffSection.append(dc);
  } else {
    diffHeader.append(
      el('span', { className: 'section-title', textContent: 'Diff: ' + diff.fileName })
    );
    const ctrls = el('div', { className: 'diff-header-controls' });
    const toggle = el('button', {
      className: 'partial-staging-toggle' + (diff.partialStagingMode ? ' active' : ''),
      title: diff.partialStagingMode
        ? 'Exit line selection mode'
        : 'Enable line selection for partial staging',
      textContent: diff.partialStagingMode ? '✓ Line Selection' : '☐ Line Selection',
    });
    setData(toggle, { 'data-action': 'togglePartialStagingMode' });
    ctrls.append(toggle);
    diffHeader.append(ctrls);
    diffSection.append(diffHeader);
    const dc = el('div', { className: 'diff-content' });
    if (diff.binary) {
      dc.append(el('div', { className: 'binary-file', textContent: 'Binary file' }));
    } else if (diff.empty) {
      dc.append(el('div', { className: 'empty-message', textContent: 'No changes' }));
    } else {
      for (const hunk of diff.hunks) {
        dc.append(buildHunk(hunk));
      }
    }
    diffSection.append(dc);
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  const footer = el('div', { className: 'commit-footer' });
  const options = el('div', { className: 'options-section' });
  const optionLabel = (id: string, checked: boolean, text: string): HTMLLabelElement => {
    const label = el('label', { className: 'option-label' });
    const input = el('input', { type: 'checkbox', id });
    input.checked = checked;
    label.append(input, el('span', { textContent: text }));
    return label;
  };
  options.append(
    optionLabel('amend-checkbox', INIT.amendMode, 'Amend'),
    optionLabel('signoff-checkbox', INIT.signOffMode, 'Sign-off')
  );
  const buttons = el('div', { className: 'buttons-section' });
  const cancelBtn = setData(
    el('button', { className: 'button cancel-button', textContent: 'Cancel' }),
    {
      'data-action': 'cancel',
    }
  );
  const commitBtn = setData(
    el('button', { className: 'button commit-button', textContent: INIT.commitLabel }),
    {
      'data-action': 'commit',
    }
  );
  commitBtn.disabled = INIT.selectedCount === 0;
  buttons.append(cancelBtn, commitBtn);
  footer.append(options, buttons);

  // ── Layout ──────────────────────────────────────────────────────────────
  const main = el('div', { className: 'commit-main' });
  const left = el('div', { className: 'commit-left' });
  left.append(messageSection, filesSection);
  const right = el('div', { className: 'commit-right' });
  right.append(diffSection);
  main.append(left, right);
  root.append(main, footer);

  wireControls();
}

// ── Message senders ─────────────────────────────────────────────────────────
function handleMessageChange(value: string): void {
  post({ type: 'updateMessage', message: value });
}
function selectFile(path: string): void {
  post({ type: 'selectFile', path });
}
function toggleFile(path: string): void {
  post({ type: 'toggleFile', path });
}
function toggleAmend(checked: boolean): void {
  post({ type: 'toggleAmend', amend: checked });
}
function toggleSignOff(checked: boolean): void {
  post({ type: 'toggleSignOff', signOff: checked });
}
function stageFile(path: string): void {
  post({ type: 'stageFile', path });
}
function unstageFile(path: string): void {
  post({ type: 'unstageFile', path });
}
function refresh(): void {
  post({ type: 'refresh' });
}
function stageHunk(hunkIndex: number): void {
  post({ type: 'stageHunk', hunkIndex });
}
function unstageHunk(hunkIndex: number): void {
  post({ type: 'unstageHunk', hunkIndex });
}
function revertHunk(hunkIndex: number): void {
  post({ type: 'revertHunk', hunkIndex });
}
function toggleLine(hunkIndex: number, lineNumber: number, lineType: string): void {
  post({ type: 'toggleLine', hunkIndex, lineNumber, lineType });
}
function stageSelectedLines(hunkIndex: number): void {
  post({ type: 'stageSelectedLines', hunkIndex });
}
function togglePartialStagingMode(): void {
  post({ type: 'togglePartialStagingMode' });
}
function selectAllLinesInHunk(hunkIndex: number): void {
  post({ type: 'selectAllLinesInHunk', hunkIndex });
}
function deselectAllLinesInHunk(hunkIndex: number): void {
  post({ type: 'deselectAllLinesInHunk', hunkIndex });
}
function handleAuthorChange(value: string): void {
  post({ type: 'authorChange', author: value });
}
function openRecentMessages(): void {
  post({ type: 'openRecentMessages' });
}
function openGearMenu(): void {
  post({ type: 'openGearMenu' });
}
function commit(): void {
  const messageEl = document.getElementById('commit-message') as HTMLTextAreaElement | null;
  const message = messageEl ? messageEl.value : '';
  post({ type: 'commit', message });
}
function cancel(): void {
  post({ type: 'cancel' });
}

// Wire events after the DOM is built. Dynamic values reach the DOM through
// data-* attributes read via the delegated dispatcher, never interpolated into
// a JS string — a filename with any character stays inert (the nonce-only CSP
// also forbids inline handlers, so every control routes through here).
function wireControls(): void {
  document.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) {
      return;
    }
    const action = target.dataset.action;
    const path = target.dataset.path ?? '';
    const hunkIndex = target.dataset.hunkIndex;
    const handlers: Record<string, () => void> = {
      selectFile: () => selectFile(path),
      toggleFile: () => {
        e.stopPropagation();
        toggleFile(path);
      },
      stageFile: () => {
        e.stopPropagation();
        stageFile(path);
      },
      unstageFile: () => {
        e.stopPropagation();
        unstageFile(path);
      },
      stageHunk: () => stageHunk(Number(hunkIndex)),
      unstageHunk: () => unstageHunk(Number(hunkIndex)),
      revertHunk: () => revertHunk(Number(hunkIndex)),
      stageSelectedLines: () => stageSelectedLines(Number(hunkIndex)),
      selectAllLinesInHunk: () => selectAllLinesInHunk(Number(hunkIndex)),
      deselectAllLinesInHunk: () => deselectAllLinesInHunk(Number(hunkIndex)),
      toggleLine: () =>
        toggleLine(
          Number(hunkIndex),
          Number(target.dataset.lineNumber),
          target.dataset.lineType ?? ''
        ),
      openRecentMessages: () => openRecentMessages(),
      openGearMenu: () => openGearMenu(),
      refresh: () => refresh(),
      togglePartialStagingMode: () => togglePartialStagingMode(),
      cancel: () => cancel(),
      commit: () => commit(),
    };
    const handler = action ? handlers[action] : undefined;
    if (handler) {
      handler();
    }
  });

  const msgEl = document.getElementById('commit-message');
  if (msgEl) {
    msgEl.addEventListener('input', (e) =>
      handleMessageChange((e.target as HTMLTextAreaElement).value)
    );
  }
  const authorEl = document.getElementById('commit-author');
  if (authorEl) {
    authorEl.addEventListener('input', (e) =>
      handleAuthorChange((e.target as HTMLInputElement).value)
    );
  }
  const amendEl = document.getElementById('amend-checkbox');
  if (amendEl) {
    amendEl.addEventListener('change', (e) => toggleAmend((e.target as HTMLInputElement).checked));
  }
  const signoffEl = document.getElementById('signoff-checkbox');
  if (signoffEl) {
    signoffEl.addEventListener('change', (e) =>
      toggleSignOff((e.target as HTMLInputElement).checked)
    );
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
}

// Plain panels self-boot: the bundle runs this on load (no inline caller).
function boot(): void {
  const island = document.getElementById(INIT_ELEMENT_ID);
  const init = parseInitIsland<ICommitDialogInit>(island?.getAttribute('data-init'));
  render(init);
}

boot();

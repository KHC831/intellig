/// <reference lib="dom" />
// Webview entry for the Rebase Progress view (bundled into
// media/webview/rebaseProgressView.js). Reads init from the host's `data-init`
// island and builds the status/progress/conflict/actions DOM. The host updates
// by re-rendering the whole HTML (which reloads this bundle against fresh init),
// so there is no host→webview message channel.

import type {
  IRebaseProgressViewInit,
  RebaseProgressViewInbound,
} from '../rebaseProgressView.protocol';
import { INIT_ELEMENT_ID, parseInitIsland } from '../../utils/webviewInit';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscodeApi = acquireVsCodeApi();

function post(message: RebaseProgressViewInbound): void {
  vscodeApi.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]>
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props ?? {});
}

function render(init: IRebaseProgressViewInit): void {
  const root = document.getElementById('progress-root');
  if (!root) {
    return;
  }

  const header = el('div', { className: 'header' });
  header.append(el('h2', { textContent: 'Rebase in Progress' }));
  header.append(
    el('div', { className: 'status-badge ' + init.statusClass, textContent: init.statusText })
  );
  root.append(header);

  const progressSection = el('div', { className: 'progress-section' });
  if (!init.hasSession || !init.progress) {
    progressSection.append(
      el('p', { className: 'no-session', textContent: 'No active rebase session found.' })
    );
  } else {
    const p = init.progress;
    const info = el('div', { className: 'rebase-info' });
    const infoRow = (label: string, value: string): HTMLDivElement => {
      const row = el('div', { className: 'info-row' });
      row.append(
        el('span', { className: 'info-label', textContent: label }),
        el('span', { className: 'info-value branch-name', textContent: value })
      );
      return row;
    };
    info.append(infoRow('Rebasing:', p.originalBranch), infoRow('Onto:', p.onto));
    progressSection.append(info);

    const barContainer = el('div', { className: 'progress-bar-container' });
    barContainer.append(
      el('div', {
        className: 'progress-label',
        textContent: 'Step ' + (p.currentStep + 1) + ' of ' + p.totalSteps,
      })
    );
    const bar = el('div', { className: 'progress-bar' });
    const fill = el('div', { className: 'progress-fill' });
    fill.style.width = p.progressPercent + '%';
    bar.append(fill);
    barContainer.append(
      bar,
      el('div', { className: 'progress-percent', textContent: p.progressPercent + '%' })
    );
    progressSection.append(barContainer);

    const commitInfo = (c: {
      shortHash: string;
      action: string;
      message: string;
    }): HTMLDivElement => {
      const info2 = el('div', { className: 'commit-info' });
      info2.append(
        el('span', { className: 'commit-hash', textContent: c.shortHash }),
        el('span', { className: 'commit-action action-' + c.action, textContent: c.action }),
        el('span', { className: 'commit-message', textContent: c.message })
      );
      return info2;
    };
    if (p.currentCommit) {
      const cur = el('div', { className: 'current-commit' });
      cur.append(
        el('div', { className: 'commit-label', textContent: 'Current Commit:' }),
        commitInfo(p.currentCommit)
      );
      progressSection.append(cur);
    }

    const commitsList = el('div', { className: 'commits-list' });
    commitsList.append(
      el('div', { className: 'commits-header', textContent: 'Commits to Rebase:' })
    );
    if (p.commits.length === 0) {
      commitsList.append(el('p', { className: 'empty-commits', textContent: 'No commits' }));
    } else {
      for (const c of p.commits) {
        const item = el('div', { className: 'commit-item ' + c.statusClass });
        item.append(
          el('span', { className: 'commit-status', textContent: c.statusIcon }),
          el('span', { className: 'commit-hash', textContent: c.shortHash }),
          el('span', { className: 'commit-action action-' + c.action, textContent: c.action }),
          el('span', { className: 'commit-message', textContent: c.message })
        );
        commitsList.append(item);
      }
    }
    progressSection.append(commitsList);
  }
  root.append(progressSection);

  if (init.isConflict) {
    const section = el('div', { className: 'conflict-section' });
    const ch = el('div', { className: 'conflict-header' });
    ch.append(
      el('span', { className: 'conflict-warning-icon', textContent: '⚠️' }),
      el('span', { className: 'conflict-title', textContent: 'Conflicts Detected' })
    );
    section.append(ch);
    const instr = el('div', { className: 'conflict-instructions' });
    instr.append(
      el('p', {
        textContent: 'The following files have conflicts that need to be resolved:',
      })
    );
    section.append(instr);
    const files = el('div', { className: 'conflict-files' });
    if (init.conflictFiles.length === 0) {
      files.append(el('p', { className: 'no-conflicts', textContent: 'No specific files listed' }));
    } else {
      for (const f of init.conflictFiles) {
        const cf = el('div', { className: 'conflict-file' });
        cf.append(
          el('span', { className: 'conflict-icon', textContent: '⚠' }),
          el('span', { className: 'conflict-path', textContent: f })
        );
        files.append(cf);
      }
    }
    section.append(files);

    const help = el('div', { className: 'conflict-help' });
    const li = (text: string): HTMLLIElement => el('li', { textContent: text });
    if (init.rebaseInProgress) {
      const lead = el('p');
      lead.append(el('strong', { textContent: 'To resolve conflicts:' }));
      help.append(lead);
      const ol = el('ol');
      const li2 = el('li');
      li2.append('Stage the resolved files using ', el('code', { textContent: 'git add' }));
      const li3 = el('li');
      li3.append(
        'Click ',
        el('strong', { textContent: 'Continue' }),
        ' to proceed with the rebase'
      );
      ol.append(li('Open each conflicted file and resolve the merge conflicts'), li2, li3);
      help.append(ol);
      const alt = el('p');
      alt.append(
        'Alternatively, click ',
        el('strong', { textContent: 'Skip' }),
        ' to skip this commit or ',
        el('strong', { textContent: 'Abort' }),
        ' to cancel the rebase.'
      );
      help.append(alt);
    } else {
      const lead = el('p');
      lead.append(
        el('strong', { textContent: 'The rebase already completed' }),
        ', but re-applying your stashed changes conflicted. To resolve:'
      );
      help.append(lead);
      const ol = el('ol');
      const li2 = el('li');
      li2.append('Stage the resolved files using ', el('code', { textContent: 'git add' }));
      ol.append(li('Open each conflicted file and resolve the merge conflicts'), li2);
      help.append(ol);
      help.append(
        el('p', { textContent: 'Do not continue or abort — there is no rebase in progress.' })
      );
    }
    section.append(help);
    root.append(section);
  }

  const actionsSection = el('div', { className: 'actions-section' });
  const buttonRow = el('div', { className: 'button-row' });
  const actionBtn = (
    cls: string,
    action: string,
    title: string,
    text: string
  ): HTMLButtonElement => {
    const b = el('button', { className: 'button ' + cls, title, textContent: text });
    b.setAttribute('data-action', action);
    return b;
  };
  if (init.showAbort) {
    buttonRow.append(
      actionBtn(
        'abort-button',
        'abort',
        'Abort the rebase and restore the repository to its pre-rebase state',
        'Abort Rebase'
      )
    );
  }
  if (init.showSkip) {
    buttonRow.append(
      actionBtn(
        'skip-button',
        'skip',
        'Skip this commit and continue with the next one',
        'Skip Commit'
      )
    );
  }
  if (init.showContinue) {
    buttonRow.append(
      actionBtn(
        'continue-button',
        'continueRebase',
        'Continue the rebase after resolving conflicts',
        'Continue'
      )
    );
  }
  actionsSection.append(buttonRow);
  const refreshRow = el('div', { className: 'refresh-row' });
  refreshRow.append(
    actionBtn('refresh-button', 'refresh', 'Refresh the rebase status', '↻ Refresh')
  );
  actionsSection.append(refreshRow);
  root.append(actionsSection);

  // Delegated click dispatcher (nonce-only CSP forbids inline onclick).
  const handlers: Record<string, () => void> = {
    abort: () => post({ type: 'abort' }),
    skip: () => post({ type: 'skip' }),
    continueRebase: () => post({ type: 'continue' }),
    refresh: () => post({ type: 'refresh' }),
  };
  document.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('[data-action]');
    if (!target) {
      return;
    }
    const handler = handlers[target.getAttribute('data-action') ?? ''];
    if (handler) {
      handler();
    }
  });
}

// Plain panels self-boot: the bundle runs this on load (no inline caller).
function boot(): void {
  const island = document.getElementById(INIT_ELEMENT_ID);
  const init = parseInitIsland<IRebaseProgressViewInit>(island?.getAttribute('data-init'));
  render(init);
}

boot();

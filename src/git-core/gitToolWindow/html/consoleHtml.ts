/**
 * Console tab body — the IntelliJ Version Control Console analog inside the
 * tabbed Git tool window. Renders the git commands captured by ConsoleService
 * (timestamp + command line + output), mirroring the `IntelliG Git Console`
 * OutputChannel surface in a scrollable in-window panel.
 */

import { escapeHtml } from '../provider/htmlBuilders';
import type { IConsoleEntry } from '../../interfaces/IGitToolWindowProvider';

/** Format a timestamp as `HH:mm:ss.SSS`, matching ConsoleService._formatTimestamp. */
function formatTimestamp(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`
  );
}

function renderEntry(entry: IConsoleEntry): string {
  const errorClass = entry.isError ? ' console-entry-error' : '';
  const timestamp = escapeHtml(formatTimestamp(entry.timestamp));
  const command = escapeHtml(entry.command);
  const output = entry.output
    ? `<pre class="console-output">${escapeHtml(entry.output)}</pre>`
    : '';
  return `
    <div class="console-entry${errorClass}">
      <div class="console-command-line">
        <span class="console-timestamp">${timestamp}</span>
        <span class="console-command">${command}</span>
      </div>
      ${output}
    </div>`;
}

/**
 * Render the Console tab body. With no entries, shows an empty state that still
 * points at the raw `Output` panel channel; otherwise renders every captured
 * command in array order (oldest first).
 */
export function renderConsoleTabBody(entries: IConsoleEntry[]): string {
  if (entries.length === 0) {
    return `
    <div class="intellig-tab-stub" role="status">
      <h3>Console</h3>
      <p>No git commands have run yet. Commands run by IntelliG will appear here.</p>
      <p class="intellig-tab-stub-hint">
        You can also follow raw git output in the <em>Output</em> panel
        (<kbd>View → Output</kbd>, channel “IntelliG Git Console”).
      </p>
    </div>`;
  }

  return `
    <div class="console-log" role="log" aria-label="Git command console">
      ${entries.map(renderEntry).join('')}
    </div>`;
}

/** Styles for the Console tab body. Folded into the tool window's extraStyles. */
export function consoleTabStyles(): string {
  return `
    .console-log {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 12px);
      padding: 6px 8px;
    }
    .console-entry {
      margin-bottom: 6px;
      word-break: break-word;
    }
    .console-command-line {
      color: var(--vscode-foreground, inherit);
    }
    .console-timestamp {
      color: var(--vscode-descriptionForeground, #888);
      margin-right: 6px;
    }
    .console-command {
      color: var(--vscode-textLink-foreground, #3794ff);
    }
    .console-output {
      margin: 2px 0 0 0;
      font: inherit;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--vscode-foreground, inherit);
    }
    .console-entry-error .console-command,
    .console-entry-error .console-output {
      color: var(--vscode-errorForeground, #f48771);
    }
  `;
}

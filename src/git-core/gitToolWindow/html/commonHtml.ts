/**
 * Shared chrome for the tabbed Git tool window.
 *
 * Only the tab strip + wrapper ship here. The repository selector and gear
 * menu continue to be rendered by the monolithic Log-tab HTML (extracting them
 * would risk breaking the embedded `acquireVsCodeApi` script handling called
 * out as a hotspot in REVIEW §7 / design §3.6 line 1571).
 *
 * All exports are pure string builders — no side effects, no DOM/Webview APIs
 * touched. Safe for unit tests.
 */

import { TAB_IDS, type TabId } from '../tabRouter';

const TAB_LABELS: Record<TabId, string> = {
  log: 'Log',
  console: 'Console',
  incoming: 'Incoming',
  updateInfo: 'Update Info',
  history: 'History',
};

/**
 * Render the horizontal tab strip. Returns raw HTML; the caller is responsible
 * for placing it inside the <body> and for binding click → `tabChange` in the
 * page script (see {@link tabStripBehaviorScript}).
 */
export function renderTabStrip(activeTab: TabId): string {
  const tabs = TAB_IDS.map((tab) => {
    const label = escapeHtml(TAB_LABELS[tab]);
    const isActive = tab === activeTab;
    const classes = ['intellig-tab', isActive ? 'intellig-tab-active' : '']
      .filter(Boolean)
      .join(' ');
    return `<button type="button" class="${classes}" data-tab="${tab}" role="tab" aria-selected="${isActive ? 'true' : 'false'}">${label}</button>`;
  }).join('');

  return `<div class="intellig-tab-strip" role="tablist" aria-label="Git Tool Window tabs">${tabs}</div>`;
}

/**
 * Render the per-tab panel shells. Each tab is a sibling <div>; only the
 * active one is visible (inline style). `logBodyHtml` is injected verbatim
 * for the Log tab and is expected to be the pre-refactor HTML.
 */
export function renderTabPanels(input: {
  activeTab: TabId;
  logBodyHtml: string;
  consoleBodyHtml: string;
  incomingBodyHtml: string;
  updateInfoBodyHtml: string;
  historyBodyHtml: string;
}): string {
  const {
    activeTab,
    logBodyHtml,
    consoleBodyHtml,
    incomingBodyHtml,
    updateInfoBodyHtml,
    historyBodyHtml,
  } = input;

  const tabToBody: Record<TabId, string> = {
    log: logBodyHtml,
    console: consoleBodyHtml,
    incoming: incomingBodyHtml,
    updateInfo: updateInfoBodyHtml,
    history: historyBodyHtml,
  };

  return TAB_IDS.map((tab) => {
    const display = tab === activeTab ? 'block' : 'none';
    return `<div class="intellig-tab-panel" data-tab-panel="${tab}" role="tabpanel" aria-hidden="${tab === activeTab ? 'false' : 'true'}" style="display:${display};">${tabToBody[tab]}</div>`;
  }).join('');
}

/**
 * Wrap a Log body + stub bodies into the full tabbed layout, including the
 * click wiring script.
 *
 * @param input.logBodyHtml        HTML for the Log tab's <body>-content (no
 *                                 outer <body> wrapper — the caller already
 *                                 emits the document-level shell).
 * @param input.stubBodies         Bodies for the four non-Log tabs.
 * @param input.activeTab          Currently active tab.
 * @param input.nonce              CSP nonce for the wiring script.
 */
export function wrapTabbedBody(input: {
  activeTab: TabId;
  logBodyHtml: string;
  consoleBodyHtml: string;
  incomingBodyHtml: string;
  updateInfoBodyHtml: string;
  historyBodyHtml: string;
  nonce: string;
}): string {
  const strip = renderTabStrip(input.activeTab);
  const panels = renderTabPanels(input);
  return `${strip}${panels}<script nonce="${input.nonce}">${tabStripBehaviorScript()}</script>`;
}

/**
 * Inline script: clicks on the tab strip post a `tabChange` message.
 *
 * The provider receives `tabChange` via the existing `onDidReceiveMessage` and
 * routes it through `TabRouter.dispatch` which re-renders the HTML. Because
 * inactive panels are `display:none`, focus jumps back to the fresh active
 * panel on re-render; no DOM recycling.
 */
export function tabStripBehaviorScript(): string {
  return `
    (function () {
      const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : undefined;
      const strip = document.querySelector('.intellig-tab-strip');
      if (!strip || !vscode) return;
      strip.addEventListener('click', function (event) {
        const btn = event.target && event.target.closest ? event.target.closest('[data-tab]') : null;
        if (!btn) return;
        const tab = btn.getAttribute('data-tab');
        if (!tab) return;
        vscode.postMessage({ type: 'tabChange', tab: tab });
      });
    })();
  `;
}

/** CSS for the tab strip. Emitted alongside the existing provider styles. */
export function tabStripStyles(): string {
  return `
    .intellig-tab-strip {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
      background: var(--vscode-editor-background, transparent);
      padding: 0 4px;
      user-select: none;
    }
    .intellig-tab {
      appearance: none;
      background: transparent;
      color: var(--vscode-foreground, inherit);
      border: none;
      border-bottom: 2px solid transparent;
      padding: 6px 12px;
      font: inherit;
      cursor: pointer;
      outline-offset: -2px;
    }
    .intellig-tab:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15));
    }
    .intellig-tab-active {
      border-bottom-color: var(--vscode-focusBorder, #0078d4);
      font-weight: 600;
    }
    .intellig-tab-panel {
      flex: 1 1 auto;
      overflow: auto;
    }
  `;
}

/** HTML-escape a string for safe interpolation in attribute values / text. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

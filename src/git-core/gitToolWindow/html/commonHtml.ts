/**
 * Shared chrome for the tabbed Git tool window.
 *
 * Only the tab strip + wrapper ship here. The repository selector and gear
 * menu continue to be rendered by the monolithic Log-tab HTML (extracting them
 * would risk breaking the embedded `acquireVsCodeApi` script handling called
 * out as a hotspot in design section 3.6).
 *
 * All exports are pure string builders — no side effects, no DOM/Webview APIs
 * touched. Safe for unit tests.
 */

import { TAB_IDS, type TabId } from '../tabRouter';
import { escapeHtml } from '../../../utils/escapeHtml';

const TAB_LABELS: Record<TabId, string> = {
  log: 'Log',
  console: 'Console',
  incoming: 'Incoming',
  updateInfo: 'Update Info',
  history: 'History',
};

/**
 * Render the horizontal tab strip. Returns raw HTML; the caller places it in
 * the <body>. The click → `tabChange` wiring is owned by the bundled
 * `gitToolWindow.js` entry (it delegates off `.intellig-tab-strip`).
 */
export function renderTabStrip(activeTab: TabId): string {
  const tabs = TAB_IDS.map((tab) => {
    const label = escapeHtml(TAB_LABELS[tab]);
    const isActive = tab === activeTab;
    const classes = ['intellig-tab', isActive ? 'intellig-tab-active' : '']
      .filter(Boolean)
      .join(' ');
    // Roving tabindex + aria-controls/id pairing per the WAI-ARIA tabs pattern:
    // only the active tab is in the tab order, arrow keys move between them.
    return `<button type="button" class="${classes}" data-tab="${tab}" id="intellig-tab-${tab}" role="tab" aria-selected="${isActive ? 'true' : 'false'}" aria-controls="intellig-tabpanel-${tab}" tabindex="${isActive ? '0' : '-1'}">${label}</button>`;
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
    return `<div class="intellig-tab-panel" data-tab-panel="${tab}" id="intellig-tabpanel-${tab}" role="tabpanel" aria-labelledby="intellig-tab-${tab}" aria-hidden="${tab === activeTab ? 'false' : 'true'}" style="display:${display};">${tabToBody[tab]}</div>`;
  }).join('');
}

/**
 * Wrap a Log body + stub bodies into the full tabbed layout. The tab-strip
 * click wiring (posts `tabChange`) lives in the bundled `gitToolWindow.js`
 * entry, so this only emits the strip + panel markup.
 *
 * @param input.logBodyHtml        HTML for the Log tab's <body>-content (no
 *                                 outer <body> wrapper — the caller already
 *                                 emits the document-level shell).
 * @param input.stubBodies         Bodies for the four non-Log tabs.
 * @param input.activeTab          Currently active tab.
 */
export function wrapTabbedBody(input: {
  activeTab: TabId;
  logBodyHtml: string;
  consoleBodyHtml: string;
  incomingBodyHtml: string;
  updateInfoBodyHtml: string;
  historyBodyHtml: string;
}): string {
  const strip = renderTabStrip(input.activeTab);
  const panels = renderTabPanels(input);
  // One bounded flex column: the strip keeps its natural height and each panel
  // scrolls inside the remaining space. As plain flow siblings, tall tab content
  // grew the page instead and the body scroll carried the strip out of view.
  return `<div class="intellig-tabbed">${strip}${panels}</div>`;
}

/** CSS for the tab strip. Emitted alongside the existing provider styles. */
export function tabStripStyles(): string {
  return `
    .intellig-tabbed {
      display: flex;
      flex-direction: column;
      height: 100vh;
      min-height: 0;
    }
    .intellig-tab-strip {
      flex: 0 0 auto;
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
      min-height: 0;
      overflow: auto;
    }
    .intellig-tab-stub {
      padding: 16px;
      color: var(--vscode-descriptionForeground);
    }
    .intellig-tab-stub h3 {
      margin: 0 0 8px 0;
      font-size: 13px;
      font-weight: 600;
      color: var(--vscode-foreground, inherit);
    }
    .intellig-tab-stub p {
      margin: 0 0 6px 0;
    }
    .intellig-tab-stub-hint {
      font-size: 0.9em;
    }
  `;
}

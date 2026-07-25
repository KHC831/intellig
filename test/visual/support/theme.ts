/**
 * VS Code theme token sets for the computed-style lane.
 *
 * Webview CSS is written entirely against `var(--vscode-*)` tokens that the
 * host injects at runtime. A plain browser page has none of them, so every
 * themed rule would collapse to its fallback and the lane would measure
 * nothing. These sets stand in for the host injection: approximate Dark
 * Modern / Light Modern values, chosen so a rule that fails to match is
 * visibly distinguishable from one that applies.
 *
 * Values track VS Code's defaults closely enough for match/override/contrast
 * assertions. They are NOT a pixel-parity reference: this lane asserts that a
 * rule applied and resolved sanely, never that a colour is byte-exact.
 */

export type ThemeName = 'dark' | 'light';

const DARK: Readonly<Record<string, string>> = {
  'vscode-foreground': '#cccccc',
  'vscode-editor-background': '#1f1f1f',
  'vscode-editor-foreground': '#cccccc',
  'vscode-sideBar-background': '#181818',
  'vscode-descriptionForeground': '#9d9d9d',
  'vscode-focusBorder': '#0078d4',
  'vscode-dropdown-background': '#313131',
  'vscode-dropdown-foreground': '#cccccc',
  'vscode-dropdown-border': '#3c3c3c',
  'vscode-dropdown-listBackground': '#1f1f1f',
  'vscode-button-background': '#0078d4',
  'vscode-button-foreground': '#ffffff',
  'vscode-button-hoverBackground': '#026ec1',
  'vscode-input-background': '#313131',
  'vscode-input-foreground': '#cccccc',
  'vscode-input-border': '#3c3c3c',
  'vscode-toolbar-hoverBackground': '#2a2d2e',
  'vscode-menu-background': '#1f1f1f',
  'vscode-menu-foreground': '#cccccc',
  'vscode-menu-border': '#454545',
  'vscode-menu-selectionBackground': '#0078d4',
  'vscode-menu-selectionForeground': '#ffffff',
  'vscode-menu-separatorBackground': '#454545',
  'vscode-list-hoverBackground': '#2a2d2e',
  'vscode-list-activeSelectionBackground': '#04395e',
  'vscode-list-activeSelectionForeground': '#ffffff',
  'vscode-panel-border': '#2b2b2b',
  'vscode-inputValidation-errorBackground': '#5a1d1d',
  'vscode-inputValidation-errorBorder': '#be1100',
  'vscode-editor-font-family': 'monospace',
  'vscode-editor-font-size': '13px',
};

const LIGHT: Readonly<Record<string, string>> = {
  'vscode-foreground': '#3b3b3b',
  'vscode-editor-background': '#ffffff',
  'vscode-editor-foreground': '#3b3b3b',
  'vscode-sideBar-background': '#f8f8f8',
  'vscode-descriptionForeground': '#3b3b3b',
  'vscode-focusBorder': '#005fb8',
  'vscode-dropdown-background': '#ffffff',
  'vscode-dropdown-foreground': '#3b3b3b',
  'vscode-dropdown-border': '#cecece',
  'vscode-dropdown-listBackground': '#ffffff',
  'vscode-button-background': '#005fb8',
  'vscode-button-foreground': '#ffffff',
  'vscode-button-hoverBackground': '#0258a8',
  'vscode-input-background': '#ffffff',
  'vscode-input-foreground': '#3b3b3b',
  'vscode-input-border': '#cecece',
  'vscode-toolbar-hoverBackground': '#b8b8b850',
  'vscode-menu-background': '#ffffff',
  'vscode-menu-foreground': '#3b3b3b',
  'vscode-menu-border': '#cecece',
  'vscode-menu-selectionBackground': '#005fb8',
  'vscode-menu-selectionForeground': '#ffffff',
  'vscode-menu-separatorBackground': '#d4d4d4',
  'vscode-list-hoverBackground': '#f2f2f2',
  'vscode-list-activeSelectionBackground': '#005fb8',
  'vscode-list-activeSelectionForeground': '#ffffff',
  'vscode-panel-border': '#e5e5e5',
  'vscode-inputValidation-errorBackground': '#f2dede',
  'vscode-inputValidation-errorBorder': '#be1100',
  'vscode-editor-font-family': 'monospace',
  'vscode-editor-font-size': '13px',
};

const THEMES: Readonly<Record<ThemeName, Readonly<Record<string, string>>>> = {
  dark: DARK,
  light: LIGHT,
};

/** The raw token value, for asserting a computed style resolved to it. */
export function themeToken(theme: ThemeName, token: string): string {
  const key = token.replace(/^--/, '');
  const value = THEMES[theme][key];
  if (value === undefined) {
    throw new Error(
      `Unknown theme token '${token}' for '${theme}'. Add it to test/visual/support/theme.ts ` +
        `rather than hardcoding a colour at the call site.`
    );
  }
  return value;
}

/**
 * The `:root` block the host would inject. Font family is pinned to a generic
 * so text metrics stay stable across machines: layout assertions in this lane
 * must not depend on which fonts happen to be installed.
 */
export function themeRootCss(theme: ThemeName): string {
  const decls = Object.entries(THEMES[theme])
    .map(([name, value]) => `      --${name}: ${value};`)
    .join('\n');
  return `    :root {\n${decls}\n    }\n`;
}

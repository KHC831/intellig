/**
 * VS Code theme token fixtures for the computed-style lane.
 *
 * Webview CSS is written entirely against `var(--vscode-*)` tokens the host
 * injects at runtime. A plain browser page has none, so every themed rule would
 * collapse to its fallback and the lane would measure nothing.
 *
 * There are two fixtures because the lane asks two different questions, and one
 * palette cannot answer both:
 *
 * - **sentinel** (default) — every token gets a GUARANTEED-UNIQUE colour, so
 *   `assertResolvesToToken` is really testing token identity. With realistic
 *   values it is not: VS Code's own palette collides heavily (in Dark Modern
 *   `menu-background`, `editor-background` and `dropdown-listBackground` are all
 *   `#1f1f1f`; in Light Modern eight tokens are `#ffffff`), so swapping a rule
 *   to a wrong-but-adjacent token resolves to an identical RGB and passes. A
 *   wrong-but-adjacent token is the likeliest theming mistake there is.
 * - **realistic** — the actual Dark/Light Modern values, for contrast and
 *   readability assertions, where the real relationship between two tokens is
 *   the whole point and sentinels would be meaningless.
 *
 * Neither is a pixel-parity reference. This lane asserts that a rule applied
 * and resolved sanely, never that a colour is byte-exact.
 */

export type ThemeName = 'dark' | 'light';

/** Every token the fixtures define. Order fixes the sentinel assignment. */
const TOKENS = [
  'vscode-foreground',
  'vscode-editor-background',
  'vscode-editor-foreground',
  'vscode-sideBar-background',
  'vscode-descriptionForeground',
  'vscode-focusBorder',
  'vscode-dropdown-background',
  'vscode-dropdown-foreground',
  'vscode-dropdown-border',
  'vscode-dropdown-listBackground',
  'vscode-button-background',
  'vscode-button-foreground',
  'vscode-button-hoverBackground',
  'vscode-input-background',
  'vscode-input-foreground',
  'vscode-input-border',
  'vscode-toolbar-hoverBackground',
  'vscode-menu-background',
  'vscode-menu-foreground',
  'vscode-menu-border',
  'vscode-menu-selectionBackground',
  'vscode-menu-selectionForeground',
  'vscode-menu-separatorBackground',
  'vscode-list-hoverBackground',
  'vscode-list-activeSelectionBackground',
  'vscode-list-activeSelectionForeground',
  'vscode-panel-border',
  'vscode-inputValidation-errorBackground',
  'vscode-inputValidation-errorBorder',
  // Appended, never inserted: sentinelFor keys off the index, so reordering
  // this list silently changes every sentinel value.
  'vscode-icon-foreground',
  'vscode-charts-yellow',
  'vscode-charts-green',
  'vscode-disabledForeground',
  'vscode-button-secondaryBackground',
  'vscode-button-secondaryForeground',
  'vscode-editor-selectionBackground',
  'vscode-editor-inactiveSelectionBackground',
  'vscode-merge-currentContentBackground',
  'vscode-merge-currentHeaderBackground',
  'vscode-merge-incomingContentBackground',
  'vscode-merge-incomingHeaderBackground',
  'vscode-merge-commonContentBackground',
  'vscode-merge-commonHeaderBackground',
  'vscode-mergeEditor-changeBase-background',
  'vscode-mergeEditor-changeBase-word-background',
] as const;

const REALISTIC: Readonly<Record<ThemeName, Readonly<Record<string, string>>>> = {
  dark: {
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
    'vscode-icon-foreground': '#c5c5c5',
    'vscode-charts-yellow': '#d8a03d',
    'vscode-charts-green': '#89d185',
    'vscode-disabledForeground': '#7f7f7f',
    'vscode-button-secondaryBackground': '#3a3d41',
    'vscode-button-secondaryForeground': '#ffffff',
    'vscode-editor-selectionBackground': '#264f78',
    'vscode-editor-inactiveSelectionBackground': '#3a3d41',
    'vscode-merge-currentContentBackground': '#2f5e52',
    'vscode-merge-currentHeaderBackground': '#3a7565',
    'vscode-merge-incomingContentBackground': '#284e6e',
    'vscode-merge-incomingHeaderBackground': '#2d6596',
    'vscode-merge-commonContentBackground': '#4a4d51',
    'vscode-merge-commonHeaderBackground': '#5f6367',
    'vscode-mergeEditor-changeBase-background': '#4b1818',
    'vscode-mergeEditor-changeBase-word-background': '#6f1313',
  },
  light: {
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
    'vscode-icon-foreground': '#424242',
    'vscode-charts-yellow': '#b89500',
    'vscode-charts-green': '#388a34',
    'vscode-disabledForeground': '#8a8a8a',
    'vscode-button-secondaryBackground': '#5f6a79',
    'vscode-button-secondaryForeground': '#ffffff',
    'vscode-editor-selectionBackground': '#add6ff',
    'vscode-editor-inactiveSelectionBackground': '#e5ebf1',
    'vscode-merge-currentContentBackground': '#c8e6c9',
    'vscode-merge-currentHeaderBackground': '#a5d6a7',
    'vscode-merge-incomingContentBackground': '#bbdefb',
    'vscode-merge-incomingHeaderBackground': '#90caf9',
    'vscode-merge-commonContentBackground': '#e0e0e0',
    'vscode-merge-commonHeaderBackground': '#c6c6c6',
    'vscode-mergeEditor-changeBase-background': '#ffcccc',
    'vscode-mergeEditor-changeBase-word-background': '#ffa3a3',
  },
};

/**
 * Unique by construction: the red channel carries the token's index, so no two
 * tokens can collide however the list grows. Dark and light differ in the low
 * bit of blue so a theme mix-up is visible too.
 *
 * The index is offset by one so no sentinel is `#000000`. An element with no
 * background at all computes to `rgba(0, 0, 0, 0)`, and a sentinel of black
 * would make "the rule resolved to this token" and "the rule is missing
 * entirely" the same measurement for whichever token landed at index 0.
 */
function sentinelFor(index: number, theme: ThemeName): string {
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  const red = index + 1;
  return `#${hex(red)}${hex((red * 7) % 256)}${hex(((red * 13) % 254) + (theme === 'dark' ? 0 : 1))}`;
}

const SENTINEL: Readonly<Record<ThemeName, Readonly<Record<string, string>>>> = {
  dark: Object.fromEntries(TOKENS.map((t, i) => [t, sentinelFor(i, 'dark')])),
  light: Object.fromEntries(TOKENS.map((t, i) => [t, sentinelFor(i, 'light')])),
};

// The sentinel palette's entire value is its uniqueness; assert it rather than
// trusting the generator, since a future edit to sentinelFor could collide
// silently and quietly restore the collision blindness this fixture exists to
// remove. Black is rejected for the same reason: it is what an absent rule
// computes to, so a black sentinel cannot be told apart from no rule at all.
for (const theme of ['dark', 'light'] as const) {
  const values = Object.values(SENTINEL[theme]);
  if (new Set(values).size !== values.length) {
    throw new Error(
      `Sentinel palette for '${theme}' has duplicate values; sentinelFor must be injective`
    );
  }
  if (values.includes('#000000')) {
    throw new Error(
      `Sentinel palette for '${theme}' contains #000000, which an element with no background ` +
        `resolves to; sentinelFor must never produce black`
    );
  }
}

if (TOKENS.length > 255) {
  throw new Error(
    'sentinelFor encodes the token index in one byte, offset by one; split the palette before exceeding 255 tokens'
  );
}

export interface IThemeOptions {
  /** Use the real VS Code palette. Required for contrast/readability specs. */
  realistic?: boolean;
}

function paletteFor(theme: ThemeName, options: IThemeOptions): Readonly<Record<string, string>> {
  return options.realistic === true ? REALISTIC[theme] : SENTINEL[theme];
}

/** The raw token value, for asserting a computed style resolved to it. */
export function themeToken(theme: ThemeName, token: string, options: IThemeOptions = {}): string {
  const key = token.replace(/^--/, '');
  const value = paletteFor(theme, options)[key];
  if (value === undefined) {
    throw new Error(
      `Unknown theme token '${token}'. Add it to TOKENS in test/visual/support/theme.ts ` +
        `rather than hardcoding a colour at the call site.`
    );
  }
  return value;
}

/**
 * The `:root` block the host would inject.
 *
 * Font family and size are set directly, not left to a production alias: the
 * host injects both, and a lane whose text metrics depend on which fonts a
 * machine happens to have installed becomes flaky the first time it asserts
 * anything about layout.
 */
export function themeRootCss(theme: ThemeName, options: IThemeOptions = {}): string {
  const palette = paletteFor(theme, options);
  const decls = Object.entries(palette)
    .map(([name, value]) => `      --${name}: ${value};`)
    .join('\n');
  return (
    `    :root {\n${decls}\n` +
    `      --vscode-font-family: monospace;\n` +
    `      --vscode-font-size: 13px;\n` +
    `      --vscode-editor-font-family: monospace;\n` +
    `      --vscode-editor-font-size: 13px;\n` +
    `    }\n`
  );
}

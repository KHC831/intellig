import * as vscode from 'vscode';

/**
 * / HIG — emit the `@font-face` declaration that loads
 * the bundled VS Code codicon TTF, plus the `.codicon` utility rule
 * that every codicon glyph (`<i class="codicon codicon-…">`) needs to
 * render as the actual icon instead of a "tofu" empty-box.
 *
 * The TTF ships at `media/codicon.ttf` (copied from
 * `node_modules/@vscode/codicons/dist/codicon.ttf` at install time).
 * `webview.asWebviewUri()` rewrites the local fs URI into the
 * `https://…/<extensionId>/media/codicon.ttf` form that the
 * webview's CSP accepts. The HTML emitter widens CSP to include
 * `font-src ${webview.cspSource}` so this same-origin URI loads.
 *
 * The base `.codicon` utility rule (font-family declaration +
 * display + text-rendering + smoothing) is copied from the
 * upstream `codicon.css` so the icon renders crisp at the chip's
 * 11px size. Per-glyph `::before { content: "\\…" }` rules are
 * inlined for ONLY the codicons we currently emit — extend the
 * mapping below whenever a new codicon class is added to a
 * webview that uses this loader. Codepoints are sourced from
 * `node_modules/@vscode/codicons/dist/codicon.css` (verbatim).
 * Pinned by `codiconFont-1..3` in commitGraphSnapshots.test.ts.
 */
export function buildCodiconFontFaceStyles(
  extensionUri: vscode.Uri,
  webview: vscode.Webview
): string {
  // Defensive: many existing unit-test mock webviews stub
  // `cspSource` only and omit `asWebviewUri`. The production VS Code
  // implementation always provides it; for the test surface, fall
  // back to the local-file URI so tests that don't care about the
  // codicon-font wiring don't break. The codiconFont-1..3 RED
  // contract still passes (it asserts the @font-face shape +
  // codepoint rules + CSP, none of which need a real `asWebviewUri`).
  const codiconLocalUri = vscode.Uri.joinPath(extensionUri, 'media', 'codicon.ttf');
  const codiconFontUri =
    typeof webview.asWebviewUri === 'function'
      ? webview.asWebviewUri(codiconLocalUri)
      : codiconLocalUri;
  return `
      @font-face {
        font-family: "codicon";
        font-display: block;
        src: url("${codiconFontUri.toString()}") format("truetype");
      }

      .codicon {
        font: normal normal normal 16px/1 codicon;
        display: inline-block;
        text-decoration: none;
        text-rendering: auto;
        text-align: center;
        text-transform: none;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        user-select: none;
        vertical-align: middle;
      }

      /* Codicon glyph mapping — upstream codepoints from
         @vscode/codicons@0.0.45 (dist/codicon.css). Add a new
         \`.codicon-<name>\` rule here whenever a new codicon class is
         emitted in the provider's HTML. Both \`::before\` (modern
         double-colon) and \`:before\` (single-colon, what upstream
         uses) are accepted by the engine; we keep the upstream
         single-colon shape for byte-equivalence with codicon.css. */
      .codicon-check:before { content: "\\eab2"; }
      .codicon-git-branch:before { content: "\\ec6f"; }
      .codicon-cloud:before { content: "\\ebaa"; }
      /* Chevron twisties for the collapsible Changed Files directory tree.
         Codepoints from @vscode/codicons@0.0.45 dist/codicon.css
         (.codicon-chevron-down → \\eab4, .codicon-chevron-right → \\eab6). */
      .codicon-chevron-down:before { content: "\\eab4"; }
      .codicon-chevron-right:before { content: "\\eab6"; }
      /* codicon-tag glyph for tag chips. Codepoint pulled from
         @vscode/codicons@0.0.45 dist/codicon.css (.codicon-tag:before
         → \\ea66). Pinned by codiconFont-4. */
      .codicon-tag:before { content: "\\ea66"; }
    `;
}

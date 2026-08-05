/**
 * The Git tool window's document shell: the tab-sheet CSS concat and the
 * three-panel HTML document envelope. Pure functions over already-computed
 * parts — the provider's render path assembles the parts (state reads,
 * one-shot consumes, tab bodies) and this module owns the document text.
 */

import { tabStripStyles } from '../html/commonHtml';
import { consoleTabStyles } from '../html/consoleHtml';
import { historyTabStyles } from '../html/historyHtml';
import { incomingTabStyles } from '../html/incomingHtml';
import { updateInfoTabStyles } from '../html/updateInfoHtml';

/** The five tab sheets in emit order. The visual fixture renders this same concat, so the cascade a spec measures cannot drift from the one the document ships. */
export function toolWindowTabStyles(): string {
  return `${tabStripStyles()}\n${historyTabStyles()}\n${consoleTabStyles()}\n${updateInfoTabStyles()}\n${incomingTabStyles()}`;
}

/** Pre-rendered fragments the document envelope stitches together. */
export interface IThreePanelDocumentParts {
  csp: string;
  nonce: string;
  codiconFontCss: string;
  threePanelStyles: string;
  extraStyles: string;
  bodyMarkup: string;
  initIslandHtml: string;
  bundleUri: string;
}

/** The complete three-panel HTML document (the `webview.html` payload). */
export function buildThreePanelDocument(parts: IThreePanelDocumentParts): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${parts.csp}">
  <title>Git Tool Window</title>
  <style>
    ${parts.codiconFontCss}
    ${parts.threePanelStyles}
    ${parts.extraStyles}
  </style>
</head>
<body>
${parts.bodyMarkup}
${parts.initIslandHtml}

  <script nonce="${parts.nonce}" src="${parts.bundleUri}"></script>
</body>
</html>`;
}

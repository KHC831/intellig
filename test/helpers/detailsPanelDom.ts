/**
 * Test harness for the client-side Details Panel builder.
 *
 * The Details Panel is built in the webview via `scriptBuilder.buildDetailsPanelDom`
 * (createElement, no host-side HTML string). These helpers extract that real
 * builder from the inline script, run it in jsdom against a host render-model,
 * and expose the result so tests can assert on the rendered DOM (or its
 * serialized `outerHTML` — the same surface the old `_getDetailsPanelHtml`
 * string was).
 */

import { JSDOM } from 'jsdom';
import { buildInlineScript } from '../../src/git-core/gitToolWindow/provider/scriptBuilder';
import type { DetailsPanelModel } from '../../src/git-core/gitToolWindow/provider/detailsPanelModel';

/** Brace-match a named function declaration out of the inline-script source. */
function extractFn(src: string, name: string): string {
  const start = src.indexOf('function ' + name + '(');
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') {
      depth++;
    } else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error('buildDetailsPanelDom not found in inline script');
}

const BUILD_DETAILS_FN_SRC = extractFn(buildInlineScript(), 'buildDetailsPanelDom');

/** Build the Details Panel from a model in jsdom; return the panel Element. */
export function renderDetailsPanel(model: DetailsPanelModel): Element {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    runScripts: 'outside-only',
  });
  const { window } = dom;
  (window as unknown as { eval: (s: string) => void }).eval(
    BUILD_DETAILS_FN_SRC + '\nwindow.__buildDetailsPanelDom = buildDetailsPanelDom;'
  );
  return (
    window as unknown as { __buildDetailsPanelDom: (m: DetailsPanelModel) => Element }
  ).__buildDetailsPanelDom(model);
}

/** Build the Details Panel from a model; return its serialized HTML. */
export function renderDetailsPanelHtml(model: DetailsPanelModel): string {
  return renderDetailsPanel(model).outerHTML;
}

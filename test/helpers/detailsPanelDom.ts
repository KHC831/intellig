/**
 * Test harness for the client-side Details Panel builder.
 *
 * The Details Panel is built in the webview by `webview/detailsPanelDom`
 * (createElement, no host-side HTML string). These helpers run that real builder
 * in jsdom against a host render-model and expose the result so tests can assert
 * on the rendered DOM (or its serialized `outerHTML` — the same surface the old
 * `_getDetailsPanelHtml` string was).
 */

import { JSDOM } from 'jsdom';
import { buildDetailsPanelDom } from '../../src/git-core/gitToolWindow/webview/detailsPanelDom';
import type { DetailsPanelModel } from '../../src/git-core/gitToolWindow/provider/detailsPanelModel';

/** Build the Details Panel from a model in jsdom; return the panel Element. */
export function renderDetailsPanel(model: DetailsPanelModel): Element {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const savedDocument = (global as Record<string, unknown>).document;
  (global as Record<string, unknown>).document = dom.window.document;
  try {
    return buildDetailsPanelDom(model);
  } finally {
    (global as Record<string, unknown>).document = savedDocument;
  }
}

/** Build the Details Panel from a model; return its serialized HTML. */
export function renderDetailsPanelHtml(model: DetailsPanelModel): string {
  return renderDetailsPanel(model).outerHTML;
}

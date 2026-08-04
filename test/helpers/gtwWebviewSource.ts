/**
 * Concatenated TypeScript source of the Git tool window webview client — the
 * entry plus every sibling module esbuild bundles into
 * media/webview/gitToolWindow.js. Source-shape guards read THIS so an
 * extraction that moves code between the entry and its modules never blinds a
 * fence: the assertion surface is the shipped bundle's source, not one file.
 */

import * as fs from 'fs';
import * as path from 'path';

const WEBVIEW_DIR = path.resolve(__dirname, '../../src/git-core/gitToolWindow/webview');

export function readGtwWebviewSource(): string {
  return fs
    .readdirSync(WEBVIEW_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => fs.readFileSync(path.join(WEBVIEW_DIR, f), 'utf8'))
    .join('\n');
}

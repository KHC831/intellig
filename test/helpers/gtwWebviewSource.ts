/**
 * Concatenated TypeScript source of the Git tool window webview client — the
 * entry, every sibling module, and the shared webview-common modules esbuild
 * bundles into media/webview/gitToolWindow.js. Source-shape guards read THIS
 * so an extraction that moves code between the entry and its modules never
 * blinds a fence: the assertion surface is the shipped bundle's source, not
 * one file.
 *
 * src/webview-common is in the corpus because it is in the BUNDLE. A guard
 * asserting over the entry directory alone would go quiet the moment code it
 * watches moved into the shared widget.
 */

import * as fs from 'fs';
import * as path from 'path';

const BUNDLED_DIRS = [
  path.resolve(__dirname, '../../src/git-core/gitToolWindow/webview'),
  path.resolve(__dirname, '../../src/webview-common'),
];

function readDirSource(dir: string): string {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

export function readGtwWebviewSource(): string {
  return BUNDLED_DIRS.map(readDirSource).join('\n');
}

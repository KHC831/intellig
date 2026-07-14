#!/usr/bin/env node
/**
 * build-webview — bundles every webview client entry with esbuild.
 *
 * Two shapes share one build step:
 *   - The merge window keeps its own output (media/mergeWindow.js) and
 *     `--global-name` so Monaco's AMD `require(['vs/...'])` boot can reach it.
 *   - Every plain panel bundles to media/webview/<panel>.js (IIFE, self-booting).
 *     Add a port by appending one `{ in, out }` member to PANEL_ENTRIES.
 *
 * Flags: `--minify` (prepublish), `--watch` (dev). Mirrors the CLI esbuild lines
 * the extension-host and sequence-editor bundles still use.
 */
import { build, context } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const minify = process.argv.includes('--minify');
const watch = process.argv.includes('--watch');

const COMMON = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  logLevel: 'warning',
  minify,
};

/** Plain panel entries → media/webview/<out>.js. One line per ported panel. */
const PANEL_ENTRIES = [
  { in: join(root, 'src/shelf/webview/main.ts'), out: 'shelveDialog' },
  { in: join(root, 'src/branches/webview/main.ts'), out: 'newBranchDialog' },
  { in: join(root, 'src/conflicts/webview/main.ts'), out: 'mergeDialog' },
  { in: join(root, 'src/commits/webview/commitMessageDialog.ts'), out: 'commitMessageDialog' },
  { in: join(root, 'src/ui-shell/webview/resetDialog.ts'), out: 'resetDialog' },
  { in: join(root, 'src/rebase/webview/rebaseDialog.ts'), out: 'rebaseDialog' },
  { in: join(root, 'src/patches/webview/applyPatchDialog.ts'), out: 'applyPatchDialog' },
  {
    in: join(root, 'src/conflicts/webview/resolveConflictsDialog.ts'),
    out: 'resolveConflictsDialog',
  },
  { in: join(root, 'src/sync/webview/pushDialog.ts'), out: 'pushDialog' },
  { in: join(root, 'src/rebase/webview/rebaseProgressView.ts'), out: 'rebaseProgressView' },
];

const configs = [
  {
    ...COMMON,
    entryPoints: [join(root, 'src/conflicts/merge-window/webview/main.ts')],
    outfile: join(root, 'media/mergeWindow.js'),
    globalName: 'intelligMergeWindow',
  },
  {
    ...COMMON,
    entryPoints: PANEL_ENTRIES,
    outdir: join(root, 'media/webview'),
  },
];

if (watch) {
  const ctxs = await Promise.all(configs.map((c) => context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[build:webview] watching…');
} else {
  await Promise.all(configs.map((c) => build(c)));
}

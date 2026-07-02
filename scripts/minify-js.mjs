// Minifies the compiled extension JS in `out/` in place (comments stripped,
// whitespace collapsed, identifiers mangled) ahead of packaging. Runs as the
// last step of `vscode:prepublish` so dev builds (`compile`/`watch`) stay
// readable; each file is transformed individually (no bundling), preserving
// the CommonJS module graph vsce ships. The webview bundle is minified
// separately by `build:webview -- --minify` in the `minify:js` script.
import { build } from 'esbuild';
import { readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');

async function collectJs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJs(full)));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

const entryPoints = await collectJs(outDir);
if (entryPoints.length === 0) {
  console.error('minify-js: no .js files under out/ — run `npm run compile` first');
  process.exit(1);
}

await build({
  entryPoints,
  outdir: outDir,
  outbase: outDir,
  allowOverwrite: true,
  bundle: false,
  minify: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  logLevel: 'warning',
});

console.log(`minify-js: minified ${entryPoints.length} files in out/`);

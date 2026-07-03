// Copies the Monaco AMD build the merge window loads at runtime from the
// monaco-editor package into media/monaco/vs, so the .vsix ships it as a
// plain media asset and node_modules never needs to be packaged. Skipped
// when media/monaco/.version already matches the installed monaco-editor
// version (a full copy is ~13 MB / hundreds of files).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const targetDir = path.join(root, 'media', 'monaco', 'vs');
const versionMarker = path.join(root, 'media', 'monaco', '.version');

const monacoVersion = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules', 'monaco-editor', 'package.json'), 'utf8')
).version;

if (!fs.existsSync(sourceDir)) {
  console.error(`copy-monaco-assets: ${sourceDir} not found — run npm install first`);
  process.exit(1);
}

const upToDate =
  fs.existsSync(versionMarker) &&
  fs.readFileSync(versionMarker, 'utf8').trim() === monacoVersion &&
  fs.existsSync(path.join(targetDir, 'loader.js'));
if (upToDate) {
  console.log(`copy-monaco-assets: media/monaco/vs already at ${monacoVersion}`);
  process.exit(0);
}

fs.rmSync(path.join(root, 'media', 'monaco'), { recursive: true, force: true });
fs.cpSync(sourceDir, targetDir, { recursive: true });
fs.writeFileSync(versionMarker, `${monacoVersion}\n`);
console.log(`copy-monaco-assets: copied monaco-editor@${monacoVersion} min/vs → media/monaco/vs`);

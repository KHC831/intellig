#!/usr/bin/env node
/*
 * check-watcher-families-registered.mjs — TL-91 / R1 M2 structural guard.
 *
 * ADR-007 § "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: a contributor adds a new watcher-family field to
 *    `GitService` (e.g. `private _myNewWatchers: Map<string,
 *    vscode.Disposable[]>`) but forgets to call
 *    `this._watcherMaps.push(this._myNewWatchers)` in the constructor.
 *    The whole point of the watcher-families registry (ADR-008) is
 *    "future families add a single line." Without this guard, forgetting
 *    that one line silently leaks watchers across window reloads.
 *
 * 2. Heuristic + how it scales: regex-parse `src/services/GitService.ts`.
 *    Find field declarations whose name matches `_<word>Watchers` and
 *    whose type is `Map<string, vscode.Disposable[]>` or
 *    `Map<string, vscode.FileSystemWatcher[]>` (or any structurally-
 *    compatible array-of-disposable signature). Then count constructor
 *    `this._watcherMaps.push(this._<word>Watchers)` calls and pair them
 *    up. Mismatches fail the build. Scales linearly with the number of
 *    watcher-family fields (today 2; expected ceiling ~6–8).
 *
 * 3. Known false-positive cases: today, none. A private field named
 *    `_metaWatchers` whose map-value isn't actually a Disposable[] (e.g.
 *    a `Map<string, MetaInfo>` — bookkeeping only) is excluded by the
 *    regex's value-type requirement. If a future family chooses a
 *    structurally-different value type, document why in ADR-008.
 *
 * 4. Known false-negative cases: a field declared via a type alias
 *    (`type WatcherMap = Map<string, vscode.Disposable[]>; private _x:
 *    WatcherMap`). Today no such alias exists; if introduced, update
 *    the regex. The guard also doesn't catch a field that's correctly
 *    declared and pushed but whose VALUE TYPE was widened to a
 *    non-Disposable subtype — that's a TS error, not a regex match.
 *
 * 5. Retirement criteria: when a TS-AST guard or stricter type lands
 *    that statically requires every watcher-family field to participate
 *    in the registry (e.g. via a generic `WatcherFamily<T>` mixin), this
 *    regex guard is redundant and can be removed.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_FILE = resolve(__dirname, '..', 'src', 'services', 'GitService.ts');

const source = readFileSync(TARGET_FILE, 'utf8');

// Strip block comments AND line comments so commented-out code (e.g.
// `// this._watcherMaps.push(this._x)`) doesn't get counted as an
// active registration. Note: this is a heuristic; a JSDoc that
// happened to write a string with `//` could lose content, but
// no such pattern exists in GitService.ts today.
const sourceNoBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
const sourceClean = sourceNoBlockComments
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

/** Discover field declarations of the watcher-family shape. */
const fieldRegex =
  /^\s*private(?:\s+readonly)?\s+(_[A-Za-z][A-Za-z0-9]*Watchers)\s*:\s*Map<\s*string\s*,\s*(?:readonly\s+)?(?:vscode\.)?(?:Disposable|FileSystemWatcher)\s*\[\s*\]\s*>/gm;

const declaredFields = new Set();
for (const match of sourceClean.matchAll(fieldRegex)) {
  declaredFields.add(match[1]);
}

if (declaredFields.size === 0) {
  console.error(
    '[check:watcher-families] FAIL: zero watcher-family fields detected in GitService.ts. ' +
      'The regex may be stale or the registry was removed; investigate before merging.'
  );
  process.exit(1);
}

/** Discover `this._watcherMaps.push(this._XXXWatchers)` calls. */
const pushRegex =
  /this\._watcherMaps\.push\(\s*this\.(_[A-Za-z][A-Za-z0-9]*Watchers)\s*\)/g;

const registeredFields = new Set();
for (const match of sourceClean.matchAll(pushRegex)) {
  registeredFields.add(match[1]);
}

const missing = [];
for (const field of declaredFields) {
  if (!registeredFields.has(field)) {
    missing.push(field);
  }
}

if (missing.length > 0) {
  console.error(
    '[check:watcher-families] FAIL — the following watcher-family field(s) are declared on GitService\n' +
      'but never registered with the cleanup registry via `this._watcherMaps.push(this.<field>)`:\n' +
      missing.map((f) => `  - ${f}`).join('\n') +
      '\n\nADR-008 § "Register every watcher family in `_watcherMaps` at construction" requires every\n' +
      'watcher-family field to push its map onto `_watcherMaps` so the shared cleanup walker\n' +
      'disposes its handles on workspace-folder removal AND on `dispose()`. Without registration,\n' +
      'watchers leak silently across window reloads.\n\n' +
      'Fix: in the GitService constructor, immediately after the existing pushes, add a line:\n' +
      missing.map((f) => `  this._watcherMaps.push(this.${f});`).join('\n')
  );
  process.exit(1);
}

const extras = [];
for (const field of registeredFields) {
  if (!declaredFields.has(field)) {
    extras.push(field);
  }
}

if (extras.length > 0) {
  console.error(
    '[check:watcher-families] FAIL — the following push targets reference watcher-family\n' +
      'field names that do NOT exist as declared private fields on GitService:\n' +
      extras.map((f) => `  - ${f}`).join('\n') +
      '\n\nThis usually means a field was renamed/removed but the constructor push call still\n' +
      'references the old name (TypeScript would catch this at compile if the field was\n' +
      'tracked, but the registry is `unknown`-loose to keep the type signature simple).'
  );
  process.exit(1);
}

const list = [...declaredFields].sort();
console.log(
  `[check:watcher-families] OK — ${list.length} watcher-family field(s) declared and registered: ${list.join(', ')}.`
);

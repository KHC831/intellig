# ADR-015: Bundle the extension host with esbuild; ship no node_modules

Status: Accepted (2026-07-03)

## Context

The extension shipped tsc-compiled per-file CJS from `out/` plus its
production `node_modules` inside the .vsix. That design produced a
recurring packaging bug class:

- 0.2.3/0.2.4 were activation-dead on install: a blanket
  `node_modules/**` exclude in `.vscodeignore` dropped `neverthrow`, and
  nothing failed until a user installed the package.
- 0.2.10 shipped 35 MB of c8 `coverage/` output unnoticed.
- An earlier `!out/**/*.js` re-include shipped the entire test JS tree
  and agent coordination notes.

Every instance came from the same root: the .vsix content was an
open-ended set ("everything not excluded"), so correctness depended on a
hand-maintained ignore file whose ordering semantics are subtle. The
`check:vsix-clean` guard fenced the known instances but could not make
the class unwritable. Loading hundreds of small files through Node's
resolver also taxes activation, and VS Code's own guidance is to bundle
published extensions.

Two constraints shaped the design:

- The merge window loads Monaco's prebuilt AMD build at runtime via
  `asWebviewUri` — a file-tree asset, not a `require()` dependency, so a
  host-code bundle alone cannot cover it.
- The Electron test lanes reach the activated extension's module-level
  singletons by `require()`ing the exact artifact the host loaded
  (module identity). Under a bundle, internal modules no longer exist as
  separate requireable files.

## Decision

- `npm run compile` builds two esbuild CJS bundles: `dist/extension.js`
  from `src/extension.ts` (every runtime dependency inlined, `vscode`
  external, node18 target, sourcemapped) and `dist/rebaseTodoEditor.js`
  from `src/git-core/rebaseTodoEditor.ts` — the GIT_SEQUENCE_EDITOR
  entry that `RebaseService` spawns as a subprocess, resolved as a
  `__dirname` sibling of the host bundle. `tsc` remains the type-checker
  (`noEmit`); the test tree still compiles separately to `out-test/`.
- Monaco's `min/vs` AMD build is copied to `media/monaco/vs` at compile
  time (`scripts/copy-monaco-assets.mjs`, cached by a version marker)
  and loaded from there, exactly like the existing `media/codicon.ttf`.
- package.json declares **no production dependencies**: `neverthrow` is
  compiled into the bundle; `monaco-editor` and `@vscode/codicons` are
  build-time asset sources. vsce therefore has nothing to package from
  `node_modules`, and `.vscodeignore` excludes `node_modules/**` and
  `out/**` wholesale with no re-includes.
- `check:vsix-clean` asserts both directions: the forbidden-pattern net
  (now including `^node_modules/` and `^out/`) AND a required runtime
  manifest (`dist/extension.js`, `dist/rebaseTodoEditor.js`,
  `media/mergeWindow.js`, `media/codicon.ttf`,
  `media/monaco/vs/loader.js`). A package that
  would be activation-dead or feature-dead fails the gate instead of
  the install.
- Module-identity seam: the host activates `dist/extension.js`, so the
  Electron-lane bridges (`test/e2e/support/activatedExtension.ts`,
  ext-host suites 01/09) `require()` that one file. Singletons a bridge
  needs (logger, output channel) are re-exported from `src/extension.ts`;
  requiring any other compiled copy yields a separate, never-populated
  instance. The e2e/ext-host lanes consequently exercise the exact
  artifact users run.
- Minification happens only at packaging (`minify:js` = the same esbuild
  bundles rebuilt with `--minify`), replacing the per-file `out/`
  minifier.

## Alternatives considered

- **Keep shipping node_modules, tighten the guard.** Rejected: fences
  the instances, keeps the class. The ignore file stays load-bearing for
  correctness, and each new runtime dep re-opens the 0.2.3 hole.
- **Bundle host code but keep Monaco under node_modules with targeted
  re-includes.** Rejected: preserves the negation-ordering minefield the
  header of `.vscodeignore` warns about, for one dependency.
- **webpack instead of esbuild.** Rejected: esbuild is already in the
  toolchain (webview bundle) and needs no loader configuration.
- **`ext.exports`-based test API instead of requiring the bundle.**
  Workable, but a larger refactor of every bridge call site for no
  added safety; the single-file `require` keeps the established
  pattern and stays fully typed via `import type`.

## Consequences

- The packaging bug class ("runtime file missing from the .vsix" /
  "internal file leaked into it") is structurally gone: the shipped set
  is closed (dist + media + manifest/docs), and the guard verifies the
  runtime manifest positively.
- .vsix drops from shipping a `node_modules` tree to 133 files
  (~3.4 MB), most of which are Monaco AMD assets; activation loads one
  JS file.
- `out/` no longer exists; anything that needs compiled host JS must use
  the bundle. New singletons needed by Electron-lane tests must be
  re-exported from `src/extension.ts` (the bridges' comments say so).
- Code the extension runs as a SUBPROCESS (like the sequence editor)
  cannot live inside the host bundle — it needs its own esbuild entry,
  emitted into `dist/` and added to the guard's runtime manifest. The
  squash real-git unit test caught exactly this during the migration.
- A packaging run leaves `dist/` minified until the next compile (same
  trap as before, relocated from `out/`).
- esbuild does not type-check; `tsc --noEmit` in `compile` remains a
  required gate lane before the bundle step.

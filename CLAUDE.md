# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

IntelliG is a VS Code extension bringing IntelliJ's git tooling (`git4idea`) to VS Code. IntelliJ is a behavioral reference, not a spec: when you lean on its behavior, read the actual source at `~/Documents/workspace/intellij-community/plugins/git4idea` and cite the path — never guess.

Read next: `docs/ARCHITECTURE.md` (what the code is), `docs/AGENT-HANDBOOK.md` (how to work on it — golden rules, locked product decisions, every trap already hit), `docs/testing.md` (test layers), `docs/adr/` (14 decision records — check before re-deciding anything structural).

## Commands

- **The gate** (run before any merge): `npm test` = eslint `--max-warnings 0` → `compile` → `check:all` (structural guard scripts) → unit → property. Fully headless.
- **Compile**: `npm run compile` (tsc + esbuild webview bundle). `npm run watch` is tsc-only — it does NOT rebuild `media/mergeWindow.js`; run `npm run watch:webview` alongside, or use F5.
- **Single test file**: `npx mocha --require ts-node/register test/unit/path/to/file.test.ts` (add `--timeout 60000` for property tests). A mocha "Cannot find module" error usually masks a TypeScript error — run `npx tsc -p tsconfig.test.json --noEmit` to see the real one.
- **Electron lanes** (real VS Code host, not part of `npm test`): `npm run test:ext-host` (activation/registration invariants), `npm run test:e2e` (real git fixtures). `npm run gate:full` runs everything.
- **Lint only**: `npm run lint`. Husky pre-commit runs prettier + eslint `--fix --max-warnings 0` on staged files (it stashes — the "Backing up original state" lines are normal).

## Non-negotiable workflow rules

- **Never `git push`, never open PRs, never `reset --hard origin/main`.** The user reviews local `main` and owns every push.
- **Local main is linear.** One short-lived `dev/<slug>` branch per task off latest local `main`; land with `git merge --squash` + one commit; delete with `git branch -D` (squash merges never read as merged).
- **TDD.** Bug fixes start with a reproducing failing test; prove the red fails for the right reason before implementing.
- **Commit with explicit paths** — never `git add -A`/`.`. Messages say what/why; no finding IDs, task IDs, or SHAs in comments or messages.
- **Every review/audit finding gets fixed, regardless of severity label.** Clean = zero findings.
- **A class-level fix ships with a fence**: site fixes + red-first test + a `check:all` guard (see `scripts/check-*.sh|.mjs`, ADR-007 maintenance-contract header, justification-comment escape hatch).
- **Comments describe the current code only** — no history lessons, no "fixed bug N".
- UI work is not done until the user F5s it; say explicitly when F5 is still owed.
- Temp/scratch dirs in tests go under `workspace-notes/tmp/`, never `os.tmpdir()` or the repo root. `workspace-notes/` is gitignored (plans, audit notes, trackers).

## Architecture (big picture)

Strict four-layer stack — higher layers never spawn git; lower layers never import vscode UI:

1. **Plumbing** (`src/git-core/`): `gitCli.ts` is the ONLY place a git process spawns (timeouts, output caps, `buildGitArgs` argv-injection defense with `--end-of-options`); `gitParser.ts` parses all porcelain output; `gitError.ts` owns sanitization (`formatActionFailureToast` is the single toast seam; use `combinedGitErrorText` — conflict markers land on stdout).
2. **ops/**: stateless per-domain classes (StagingOps, BranchOps, RemoteOps…) returning `ResultAsync<T, GitError>` (neverthrow). Destructive-path infra: `worktree/restoreToHead.ts` (the one sanctioned recursive delete), `ops/preservedChanges.ts` (stash bracket — pin by SHA, `stash@{0}` is not stable).
3. **GitService** (`src/git-core/GitService.ts`): the facade every feature uses. Repo discovery + `.git` watchers (narrow allow-list — watching `objects/**` = infinite refresh loop), `withIndexLock` for index-mutating sequences (NOT re-entrant), and the absorb-vs-forward error boundary (passive views absorb + degrade; user actions forward for the caller to toast — each method documents which). The `IGitService` composite interface is frozen (ADR-001).
4. **Features/UI**: `gitToolWindow` (log + layered graph pipeline: DAG → printModel → dumb painter, ADR-013), dialogs, conflicts, blame, linestatus, changelists, shelf, branches, sync, rebase.

Separate pure libraries (no vscode imports): `src/diff-engine/` (IntelliJ `platform/util/diff` port) and `src/conflicts/merge-model/`. Both carry ported upstream test suites; all engine/model text is LF-only (EOL handling at the host boundary).

### The command spine

New commands register through `src/commands/registration/commandSpine.ts` — `registerSelectionCommand` / `registerFileCommand` / `registerRepoCommand` / `registerBareCommand`. The spine owns the services guard, the `(clickedUri, selectedUris[])` selection contract, repo resolution, repo-relative paths, failure toasts, and refresh-on-success; handler bodies own only outcome logic. Hand-rolled `registerLoggedCommand`/`commands.registerCommand` calls in registration modules fail `check:spine-registration` unless annotated `// spine-exempt: <reason>`. More broadly: when a plan calls for N similar handlers/views, design one skeleton + N thin bodies (handbook rule 10).

### Webviews

All webview DOM is built via `createElement` — HTML-string skeletons are banned. `BaseWebviewPanel`/`BaseWebviewView` own the document envelope (CSP, nonce, escaping, message routing); subclasses produce body parts only. Webview state ownership: ADR-009.

### Coding style guidelines

Follow these rules for all code changes in this repository:

- Try to match existing code style.
- Code should be self-documenting and self-explanatory.
- Keep comments and docstrings minimal and concise.
- Assume the reader is familiar with git and vs code.

## Known traps (short list — full list in the handbook, section 5)

- The extension is tsc-only, NOT bundled: production `node_modules` must ship in the vsix. Never blanket-exclude `node_modules` in `.vscodeignore`; after any change run `npm run check:vsix-clean`.
- A green mock-only unit test can hide a production bug (mocked `getRepository` masked a real "No repository found"). Command wiring needs real-git e2e; runtime lanes gate UI changes.
- Rebase (and unstash/unshelve) reverse ours/theirs — route side selection through the existing reversal inference in `src/conflicts/`.
- Read `.git/` marker files for in-progress state, never parse `git status` prose (localization).
- Reaching private state from tests: use the named `TestSurface` interface idiom or `__*ForTest` exports (docs/testing.md, sections 2–3).

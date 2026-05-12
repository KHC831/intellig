# Contributing to IntelliG

Thanks for your interest in contributing to IntelliG.

## Prerequisites

- Node.js 20+
- VS Code 1.85+
- Git installed and available on PATH

## Setup

```bash
npm install
```

## Build

```bash
# Compile TypeScript to JavaScript (output in out/)
npm run compile

# Watch mode — recompiles on file changes
npm run watch
```

## Lint & Format

```bash
npm run lint          # Run ESLint
npm run lint:fix      # ESLint with auto-fix
npm run format:check  # Check formatting (Prettier)
npm run format        # Fix formatting
```

CI enforces zero errors and zero warnings (`npm run lint -- --max-warnings 0`).
Drift from that baseline blocks merge.

### Suppressing a lint rule

Lint rules in this repo aren't cosmetic — see
[`docs/testing.md` §6](docs/testing.md#6-lint-rules-that-catch-real-bugs)
for the class of production bugs they've caught. Before reaching for a
disable, check whether the rule is pointing at something real. When a
disable is genuinely the right call, follow these conventions so every
suppression is reviewable on its own.

- **Preferred shape: `eslint-disable-next-line` with a rationale.** The
  disable applies to exactly one line and the rationale lives on the
  same line, right after a `--` separator:

  ```ts
  // eslint-disable-next-line @typescript-eslint/no-floating-promises -- fire-and-forget timer; rejection logged to OutputChannel
  setTimeout(() => this._refresh(), 300);
  ```

  The `--` form is readable in diffs, greppable by rule name, and
  explicit about *why* the rule doesn't apply here.

- **File-level `/* eslint-disable <rule> */`** — reserved for files
  where the rule genuinely doesn't apply at all (generated code, test
  scaffolding with an intentional structural shape the rule rejects).
  Requires a JSDoc-style rationale comment at the top of the file
  explaining the scope:

  ```ts
  /* eslint-disable @typescript-eslint/require-await --
   * Test stub factories synthesise IShelfService implementations
   * whose method signatures return Promise<T>; the no-await stub
   * bodies are intentional to match the interface contract.
   */
  ```

- **Blanket `/* eslint-disable */`** — don't. If more than one rule is
  genuinely noise for a file, list them by name in a file header so the
  next reader sees which rules you meant to silence and can reconsider
  each one independently.

- **Review expectation.** Every new disable is a reviewer finding. The
  reviewer either accepts the rationale or asks you to rewrite the code
  so the rule passes. Code that silently introduces disables under the
  radar regresses the lint baseline — we've spent several phases
  cleaning it up and the zero-warning gate exists so the work stays
  done.

#### Pre-approved disables

A narrow set of disables is already accepted in this repo and does not
need per-PR review. Reviewers may still push back, but the onus is on
the reviewer to justify tightening — the patterns below have been
audited and land the "disable is cheaper than rewrite" way.

- **`@typescript-eslint/require-await` on interface-contract methods
  whose body is legitimately synchronous.** Several `ChangelistService`
  entry points (`setActiveChangelist`, `getActiveChangelist`,
  `getChangelistForFile`) return `Promise<T>` because the interface
  contract commits to an async shape even though the current
  implementation resolves synchronously — a future cache-miss path
  (deferred storage read, lazy revalidation) will actually await, and
  the public signature should not churn when that lands. Any symmetric
  `ShelfService` / other service method with the same interface-first
  rationale qualifies. Use `eslint-disable-next-line` with a rationale
  naming the interface contract.

- **File-level `require-await` disable for test-stub factory files that
  follow the variadic-`unknown[]` `throwError` pattern
  (see [`docs/testing.md` §3](docs/testing.md#3-the-testsurface-idiom)).**
  Those factories synthesise service implementations whose method
  signatures return `Promise<T>`; the no-await stub bodies are
  intentional because the whole point is that every method throws. A
  JSDoc-style file-header disable with a pointer to the pattern doc is
  the right shape.

### Upgrading `@typescript-eslint`

Each `@typescript-eslint` minor/major bump ships new rules. We treat
rule adoption as a deliberate engineering decision, not a default, so
the bump goes through a triage pass:

1. **Must-adopt.** The new rule catches a bug class we've seen in
   production, or tightens type safety on a hot path (e.g. a rule that
   would have caught `no-floating-promises`-style bugs before they
   shipped). Enable it in `.eslintrc.json`. Fix the call sites. Update
   [`docs/testing.md` §6](docs/testing.md#6-lint-rules-that-catch-real-bugs)
   with a one-paragraph "why this rule" note.

2. **Opt-in.** Cosmetic but improves grep/readability (e.g.
   `consistent-type-imports`, `prefer-nullish-coalescing`). Enable at
   the cost of one focused refactor phase; don't mix with unrelated
   work.

3. **Skip.** Requires widespread rewrites for ambiguous benefit, or the
   rule is known-buggy on a shape we rely on. Document the skip reason
   with a line comment in `.eslintrc.json`:

   ```jsonc
   // Skipped: would require rewriting ~200 call sites with no
   //         observed bug class; revisit if the team grows past ~10.
   "@typescript-eslint/prefer-readonly-parameter-types": "off",
   ```

4. **Process (single rule / small bump).** Open a task per rule
   decision (must-adopt, opt-in, or skip-with-rationale). Adopt each
   must-adopt / opt-in rule in a focused phase — the Phase 1-4 lint
   cleanups (no-floating-promises, require-await, no-unsafe-*,
   residuals) are the exemplar. Each phase lands with a senior +
   tech-lead review; the CI gate moves to zero-warnings once all
   must-adopt rules are clean.

5. **Process (bulk bump, 5+ new rules).** One task per rule is noise.
   Instead open one *parent* triage task with a must-adopt / opt-in /
   skip table covering every new rule in the bump. Spawn sub-tasks
   only for the must-adopt and opt-in rows — each of those still gets
   its own focused phase + review. Skip-with-rationale entries land
   inline as line comments in `.eslintrc.json` directly from the
   parent task, no sub-task needed.

6. **Optional: quarterly skip revisit.** Skipped rules can age into
   must-adopt (the team grows, the hot path shifts, a bug class the
   rule catches shows up in production). A quarterly pass over the
   `.eslintrc.json` skip list — re-checking each rationale against the
   current codebase shape — is cheap and keeps the skip list from
   calcifying. No rule is permanently skipped; the comment explains
   *why today* it's skipped, not *why forever*.

## Tests

Unit tests use mocha with ts-node and run directly from TypeScript source. Property-based tests (fast-check) run from compiled JS.

```bash
# Unit tests (uses .mocharc.json — runs from src/)
npx mocha

# Unit tests — single file
npx mocha --grep "GitService"

# Property-based tests (compile first, run from out/)
npm run compile
npx mocha --no-config --require out/test/setup.js 'out/test/property/**/*.property.test.js' --timeout 60000 --exit

# Property-based tests — single file
npm run compile
npx mocha --no-config --require out/test/setup.js 'out/test/property/stashRoundTrip.property.test.js' --timeout 60000 --exit

# All tests together (unit + property)
npm run compile
npx mocha --timeout 60000
npx mocha --no-config --require out/test/setup.js 'out/test/property/**/*.property.test.js' --timeout 60000 --exit

# VS Code integration tests (launches Extension Host)
npm test
```

## Local Development

```bash
# 1. Compile the extension
npm run compile

# 2. Open this folder in VS Code, then press F5
#    This launches the Extension Development Host with the extension loaded.

# Or use watch mode for continuous compilation:
npm run watch
# Then press F5 in VS Code to launch the Extension Development Host.
```

## Release Dogfood

Before declaring an extension change done, press F5 (see [Local Development](#local-development)) to launch the Extension Development Host and verify each of the following. Automated tests do not cover runtime behavior like idle-loop detection, CPU usage, or UX regressions.

1. **Activation is silent.** Open a workspace with a git repo. Wait 60 seconds. The dev-host console and the Git Output channel must show activation messages only once and stay quiet afterward. Repeating subprocess spam (`Git: status`, `Git: log` cycling) indicates a refresh loop — do not ship.

2. **CPU settles.** After activation, switch to the dev host and do nothing for 30 seconds. Check Activity Monitor / Task Manager for the extension host process. CPU should drop to near-zero when idle.

3. **Golden-path features work.** Run one command from each major area:
   - Log tab: open the Git tool window; commits render.
   - Branch menu: right-click a branch → "Show Diff with Working Tree" opens diff tabs.
   - Commit tool window (if `intellig.useCommitToolWindow` is on): Local Changes + Shelf tabs render.
   - Push/pull: `IntelliG: Push` and `IntelliG: Pull` work against a test remote.
   - Rebase: interactive rebase of the last 2 commits opens the editor; pick/squash succeed.
   - Stash: `IntelliG: Stash Changes`, then `IntelliG: Show Shelf List`.
   - Conflicts: create a merge conflict (`git merge <conflicting-branch>`); the resolve dialog opens; "Accept Yours" / "Accept Theirs" / "Abort" each succeed.

4. **Flags toggle cleanly.** Toggle `intellig.useCommitToolWindow` and `intellig.useTabbedGitToolWindow` off → on → off. Views rebind without activation errors or stale state.

5. **Deactivation is clean.** Close the dev host. It exits within ~2 seconds. No orphaned `node` processes in Activity Monitor.

If any of the above fails: do not ship.

## Packaging

```bash
# Install vsce if you don't have it
npm install -g @vscode/vsce

# Package as .vsix
npx vsce package

# Install the .vsix in VS Code:
#   Extensions panel → ⋯ → Install from VSIX...
```

## Project Structure

```
src/
├── commands/          # Command handlers (branch context menus, etc.)
├── services/          # Core service implementations
│   └── interfaces/    # TypeScript interfaces for all services
├── utils/             # Shared utilities (git CLI, parsers, cache, graphs)
├── extension.ts       # Extension entry point
└── test/
    ├── mocks/         # VS Code API mock for testing outside Extension Host
    ├── unit/          # Unit tests (mocha + assert)
    ├── property/      # Property-based tests (mocha + fast-check)
    └── suite/         # VS Code integration tests
```

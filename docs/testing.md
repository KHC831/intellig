# Testing

IntelliG has five distinct test layers plus a small set of test-infra
directories. This document is the canonical reference for where a new
test or test helper belongs, and how to reach into private state from
a test without rotting the production API.

## section 1. Test layers

| Layer    | Path               | CI lane                                    | VS Code host? | Real git? | Driver           | Approx. count |
| -------- | ------------------ | ------------------------------------------ | ------------- | --------- | ---------------- | ------------: |
| Unit     | `test/unit/**`     | `test:unit`                                | no            | no        | Mocha            |          2542 |
| Property | `test/property/**` | `test:property` (+ `test:property:stress`) | no            | no        | fast-check       |          3158 |
| Ext-host | `test/ext-host/**` | `test:ext-host`                            | yes           | no        | Mocha            |            22 |
| E2E      | `test/e2e/**`      | `test:e2e`                                 | yes           | yes       | Mocha            |            36 |
| Visual   | `test/visual/**`   | `test:visual`                              | no            | no        | Mocha + Chromium |           202 |

- **Unit** — everything mocked; no VS Code host, no git subprocess. Fast,
  deterministic. Use for service-level logic, command handlers, parsers,
  error paths.
- **Property** — same runtime as unit; fast-check drives inputs. Use for
  idempotence, round-trip, and invariant properties. Each property has a
  pinned regression `it()` for any counterexample the stress harness
  surfaces.
- **Ext-host** — real VS Code extension host (the extension is activated
  inside a Code test instance), but no git fixtures. Use for activation +
  command-registration invariants, URI-scheme coherence, post-activate
  idle invariants. These are the only tests that can catch
  "extension.activate() threw silently in the host."
- **E2E** — real VS Code host **and** real temp-dir git fixtures.
  Per-test isolated via `test/e2e/support/gitFixture.ts` +
  `workspaceHelper.ts`. Use for command flows that exercise real git
  state transitions. These are slow; budget carefully.
- **Visual** — production CSS and production markup rendered in headless
  Chromium; assertions read **computed styles**, never pixels. This is the
  only lane with a cascade and a layout engine: jsdom has neither, so a rule
  that is present in the CSS text but never matches, loses on specificity, or
  is overpainted is invisible everywhere else. Use for theming (a token
  actually resolved), readability (WCAG contrast against the real backdrop),
  stacking (`elementFromPoint` says the element is on top), and overlap.
  Helpers in `test/visual/support/`; see also ADR-010, which rejected pixel
  diffing and is not superseded by this lane.

  Two limits worth stating plainly: it renders in Chrome, not the Electron
  host, so a host-version-specific rendering bug still escapes; and layout
  assertions are kept coarse (visible / not-overlapping / contrast) because
  exact offsets depend on font metrics that vary by machine.

  **The assertions are themselves tested.** `harness.visual.test.ts` renders
  deliberate defects and requires each helper to report them, because a helper
  that cannot tell a correct render from a broken one reports green forever and
  nothing inside the lane would notice. It also pins the reason the harness
  forces `pointer-events`: the stacking and readability helpers ask what
  _paints_ at a point, `elementFromPoint` answers what would receive a _click_,
  and the two disagree on exactly the overlay layers those helpers exist for.

  **How much it covers.** `check:visual-coverage` classifies every stylesheet
  producer — a function, arrow-const or method whose name contains `Styles` and
  is annotated to return `string` or `Promise<string>`, which includes the
  private `_getStyles()` every dialog declares — as `tested` or `backlog`, and
  fails on an unclassified one. It currently reports **13 of 33 tested**; the
  rest print every run as named debt. A `tested` claim is
  verified, not taken on trust: the producer must be rendered by a spec,
  interpolated by one that is, or forwarded to by its own body. Classification
  is per producer rather than per file, because a file-level status let a
  partly-covered file (one builder rendered, another not) read as fully
  covered.

  **Seeing what it measured.** `npm run test:visual:shots` writes a PNG per
  spec to `workspace-notes/visual-shots/` (gitignored), clipped to the
  rendered content and named from the spec, so both themes sit side by side in
  one directory listing. `npm run test:visual:headed` runs a visible browser
  with a slow-motion delay (`INTELLIG_VISUAL_SLOWMO`, default 250ms) for
  poking at one surface with devtools. A **failing** spec always writes a
  `--FAILED` shot whether or not shots are enabled: a contrast ratio in an
  assertion message is hard to picture, and the image makes it obvious. The
  directory is emptied at the start of every run, so everything in it belongs to
  the run that just finished — a `--FAILED` image from a spec fixed weeks ago is
  otherwise indistinguishable from one written seconds ago, and the directory
  reads as a list of current failures. The
  fixture pins a monospace font for stable metrics, so shots read as the right
  colours and layout in the wrong typeface — they are a debugging aid, never
  compared against a golden image.

### The test surface is the CI lanes

The complete CI test surface is the six lanes below:

- `test:unit` — the Unit layer (in-process, `vscode` mock).
- `test:property` — the Property layer (in-process, `vscode` mock).
- `test:property:stress` — re-runs the Property layer N times to shake
  out flakey counterexamples.
- `test:ext-host` — the Ext-host layer (real Extension Host).
- `test:e2e` — the E2E layer (real Extension Host + real git fixtures).
- `test:visual` — the Visual layer (headless Chromium, computed styles).

For test coverage — the `npm run coverage` report, the patch-coverage PR
gate, and how to make that gate airtight by merging coverage across these
lanes — see [coverage.md](./coverage.md).

These are exactly the lanes `.github/workflows/ci.yml` runs
(`test:ext-host` and `test:e2e` under `xvfb-run -a`; `test:visual` against a
Chromium pinned to the `playwright-core` version, so a runner base-image bump
cannot change what the assertions measure). Each Electron lane
(`test:ext-host`, `test:e2e`) launches with
`--disable-extensions --disable-workspace-trust` so it runs fully
unattended — no workspace-trust modal, no extension-recommendations
prompt.

**A seventh runnable lane sits outside CI: mutations.** `npm run
check:mutations` neuters each defence named in
`scripts/mutation-manifest.json` — applying the entry's own mutation to
the exact code fragment it names, in a throwaway git worktree — and
requires the entry's own named test to die (fail) under that mutation; an
entry whose test still passes is an unfenced regression detector. It runs
real Mocha specs against real production code, so it belongs to the
runnable test surface in every sense except CI enforcement:
`.github/workflows/ci.yml` never invokes `check:mutations`, and `npm run
gate:full` is the only aggregate that does. Whether it should join CI is
a scope decision for the user, not a documentation gap; until decided,
run it locally before landing a change to a fenced defence.

**Decision (Option B + compatibility alias): the aggregate _harness_ is
retired, but `npm test` survives as a thin alias.** The legacy aggregate
host — the old `test` script's `node ./out/test/runTest.js` entry point,
its launcher `test/runTest.ts`, and its recursive Mocha loader
`test/suite/index.ts` — has been **removed**. It booted a real
Extension Host with no launch args (so it stalled on the workspace-trust
modal) and dragged the mock-`vscode` unit/property suites into that host;
CI never invoked it, and its only host spec was already covered by the
`test:ext-host` `01.activate.test.ts` smoke suite.

To avoid breaking the muscle-memory `npm test` command, the `test` script
is **retained as an alias** over the in-process lanes plus lint rather
than removed:

```
test = lint (--max-warnings 0) → compile → check:all → test:unit → test:property
```

`npm test` therefore runs the fast, headless, in-process gates (the same
ones the pre-commit checks and CI run) and never boots an Extension Host,
so it stays fully unattended. The two Electron lanes (`test:ext-host`,
`test:e2e`) and the browser lane (`test:visual`) are intentionally **not**
part of the alias — run them explicitly when you need a real host or a real
cascade. `npm run gate:full` chains all of them. There is no longer any
single command that runs everything in one process; that is by design.

### Local-CI parity gate (per-PR)

`npm test` alone is **not sufficient** to ratify a PR. The two Electron
lanes (`test:ext-host`, `test:e2e`) and the browser lane (`test:visual`)
live outside the `npm test` alias,
and historical flakes (T50 createPatch / checkoutRevision e2e flake,
T51 spawn-git ENOENT) were Linux-only — local macOS / Windows runs
cannot surface them. Before opening a PR for any phase of the Git
tool window redesign (and as a general pre-PR discipline):

1. **On Linux**, run `npm run test:ext-host` locally and verify it
   passes. The lane is fast (≈ 22 specs); a green local run rules out
   the activation / URI-scheme / post-activate-idle drift class that
   the unit + property lanes can't see.
2. **On macOS / Windows**, defer to CI for the Electron lanes — the
   lanes assume `xvfb-run -a` and a Linux-flavored Code test harness.
   Do **not** skip the Electron lanes; verify the CI matrix
   (`.github/workflows/ci.yml`) completes the `test:ext-host` and
   `test:e2e` jobs green before merge.
3. **The CI matrix is the source of truth.** Full Linux-CI on every
   developer machine is out of scope. Reviewers MUST check the matrix
   completion, not just the `test:unit` / `test:property` lanes that
   `npm test` runs.

This gate is enforced by convention (PR checklist + reviewer
discipline), not by an automated lint. The cost of a missed Electron
flake is high — silent activation failures bypass every in-process
guard — and the cost of running `test:ext-host` once per PR on Linux
is low.

## section 2. Test-infra locations

```
test/
├── mocks/         ← module-resolution substitutes (resolved at build time)
├── typed/         ← typed accessors for unit + property suites
├── helpers/       ← DOM / webview test harness helpers
├── e2e/support/   ← E2E fixtures, stubs, workspace helper
├── unit/          ← unit suites
├── property/      ← property suites
├── ext-host/      ← extension-host smoke suites
├── e2e/           ← end-to-end suites
└── visual/        ← computed-style suites (+ visual/support/ harness)
```

- **`test/mocks/`** — module-resolution substitutes. `vscode.ts` is
  hoisted by the test runner to replace `import * as vscode` in the
  graph. Anything that an import statement resolves to, for test
  purposes, lives here.
- **`test/typed/`** — typed bridges into private state (e.g.
  `writableWindow` for casting to a `vscode.window` override surface,
  `invokePrivateHandler` for driving a tree-view's private command
  dispatcher). Used by unit + property suites.
- **`test/helpers/`** — DOM / webview test harness helpers
  (`webviewHarness`, `detailsPanelDom`, `mockWebviewContext`,
  `webviewHtml`) for exercising rendered webview output.
- **`test/e2e/support/`** — E2E-only: `Fixture`, `workspaceHelper`,
  test-process stubs. Depends on VS Code + real filesystem.

## section 3. The TestSurface idiom

To reach private class members from tests, **declare a named
`<ClassName>TestSurface` (or `<ClassName>Internals`) interface**
co-located in the test file or a test-helper adjacent to the class.
Cast via `as unknown as <Name>`. JSDoc why. No inline anonymous shapes.
No kitchen-sink surfaces.

**Rules:**

1. Interface name ends in `TestSurface` or `Internals`.
2. Kept narrow — typically ≤5 fields. Each field is a private member the
   test genuinely drives.
3. JSDoc on the interface explains _why_ the test reaches through the
   private boundary (what contract it's asserting that the public API
   can't express).
4. No inline `as unknown as { ... }` literals — every such cast gets a
   named interface.
5. No omnibus "all private members" surface — one surface per concern.

**Exemplars on main:**

- `test/unit/services/resetDialog.test.ts` — `ResetDialogInternals`
  (2 fields; drives `_onMessage` + reads `_panel.webview.html`).
- `test/unit/services/commitToolWindow.test.ts` —
  `CommitToolWindowTestSurface` (drives handler dispatch under a stub
  webview).
- `test/e2e/support/workspaceHelper.ts` —
  `GitServiceWorkspaceHelperSurface` (enumerates repos + drops watchers
  during per-test teardown).
- `test/unit/services/rebaseSkip.test.ts` —
  `GitServiceGitCliTestSurface` (injects a scripted CLI into a real
  `GitService` instance).

### Function-name prefix variant for module-scope test-only exports

The `<ClassName>TestSurface` interface idiom above covers reaching
into private _class_ members. For **module-scope test-only exports**
(top-level `export function`s in a non-class module — typically a
singleton's reset hook or a helper a test needs to call directly),
use the `__<name>ForTest` prefix convention instead:

```ts
// src/utils/outputChannel.ts
export function __resetOutputChannelForTest(): void {
  // …
}
```

**Rules:**

1. Double-underscore prefix + `ForTest` suffix. The double-underscore
   makes test-only intent visible at every call-site without needing
   to chase the import.
2. JSDoc tagged `@internal` and explicitly says "Production code MUST
   NOT call this" plus the failure mode (e.g. "tears down the cached
   singleton mid-flight").
3. **Pair with a structural CI guard** that greps `src/` for the
   literal name and fails the build on any production caller. The
   canonical example is
   `scripts/check-test-only-surface.sh` (registered as
   `npm run check:test-only-surface`; wired into `check:all` and
   `.github/workflows/ci.yml` alongside the other `check:*` guards).

**When to use the prefix vs. the interface:**

- **Class with private members** → declare a `TestSurface` interface
  and cast through `as unknown as`. The class's public API stays
  un-prefixed.
- **Module-level singleton or free helper** → use `__*ForTest` on the
  exported symbol itself. There's no "interface to declare" — the
  function is the surface.

**Grandfathered exceptions.** Some pre-existing test-only module
exports follow a different naming (`migrateStorageForTest`,
`serializeStorageForDisk`, `migrateShelfStorageForTest`,
`serializeShelfForDisk`) — they predate the prefix convention and
are kept as-is to avoid churn. New test-only module exports MUST use
the `__*ForTest` prefix. A future sweep may rename the
grandfathered set; until then, run `git grep -nE 'export function
(.*ForTest|serialize.*ForDisk)' src/` to enumerate the current
inventory.

### The variadic-`unknown[]` `throwError` pattern

Error-path stub factories for `IGitService` (and similar composite role
interfaces) typically want _every_ method to throw the same error. Rather
than hand-typing each method signature, declare one polymorphic
`throwError` that accepts an unconstrained arg list:

```ts
// Variadic signature lets this one function stand in for every IGitService
// method regardless of its specific argument list — the whole object is
// cast via `as unknown as IGitService` once assembled.
const throwError = async (..._args: unknown[]): Promise<never> => {
  throw new Error(errorMsg);
};

return {
  commit: throwError,
  push: throwError,
  // …every other mutator…
} as unknown as IGitService;
```

Why this is preferred over the alternatives:

- **`(..._args: any[]) => …`** — triggers `no-explicit-any` and loses
  every downstream type check.
- **Per-method signature copy-paste** — noise, drift when the interface
  evolves, and offers no additional safety since the body ignores the
  args anyway.
- **`as unknown as IGitService` once at the end** — the single cast is
  localised to the factory and carries a comment explaining why the
  factory is deliberately not structurally compatible field-by-field.

Exemplars:

- `createErrorThrowingGitService` in
  `test/property/commitContextMenuErrors.property.test.ts`.
- `createErrorThrowingMockGitService` in
  `test/property/branchContextMenuErrors.property.test.ts`.

## section 4. Decision rules — where does my new test helper go?

| Scenario                                                    | Put it in                |
| ----------------------------------------------------------- | ------------------------ |
| Crosses unit + property (typed accessor into private state) | `test/typed/`            |
| E2E-only (fixtures, workspace juggling)                     | `test/e2e/support/`      |
| Replaces a module import at resolution time                 | `test/mocks/`            |
| One-off for a single test file                              | Inline in that test file |

If a helper would be used only once, don't extract it. The overhead of
reading across two files isn't paid back by a single caller.

## section 5. Related

- Production-side escape hatch for raw `GitCli` access from call sites
  that the frozen `IGitService` composite deliberately doesn't wrap: see
  `IGitServiceCli` in `src/git-core/interfaces/IGitService.ts`. That's a
  production interface (marked `@internal`), not a TestSurface.

## section 6. Lint rules that catch real bugs

A handful of lint rules have caught real production defects in this repo.
This section teaches the pattern each rule detects so you recognise it in
a PR before the linter does. For policy on suppressing a rule, see
[CONTRIBUTING.md → Suppressing a lint rule](../CONTRIBUTING.md#suppressing-a-lint-rule).

- **`@typescript-eslint/no-floating-promises`** — a `Promise` whose
  rejection nobody ever observes. The classic catch here isn't a
  production fire-and-forget; it's a test that _claims_ to assert
  something but silently passes because the assertion lives behind an
  unawaited call. The regex double-count bug in
  `BranchContextMenuCommands._parseConflictCount` (a case-insensitive
  `/CONFLICT/gi` matched both `CONFLICT` and `conflict in` on the same
  line, inflating the count the pull-fallback dialog rendered — user
  saw "merge shows 6 conflicts but the file only has 3") survived for
  multiple PRs because its property test called
  `fc.assert(fc.property(...))` without `await`. The `Promise`
  resolved-via-throw into nothing; mocha reported the test as green;
  the regex kept over-counting. A `no-floating-promises` lint would
  have flagged the unawaited `fc.assert` at the point it was
  introduced. When a fire-and-forget is genuinely intentional
  (state-sync refresh, init path), route through
  `safeFireAndForget(promise, label)` so the rejection lands on
  `console.error` with a contextual label rather than disappearing.

- **`@typescript-eslint/no-misused-promises`** — an async function
  passed where a sync callback is expected (e.g. `setTimeout`, event
  handlers). The runtime silently swallows rejections and the caller
  sees "nothing happened." If you hit this rule inside an event handler
  and genuinely want fire-and-forget semantics, wrap through
  `safeFireAndForget` or declare the handler sync and route the work to
  a dedicated promise chain.

- **`@typescript-eslint/await-thenable`** — `await` on a non-Promise
  silently resolves to the value. Harmless in toy code; a latent bug in
  a refactor that changed a method from async to sync without updating
  call sites. The rule catches it at compile time.

- **`@typescript-eslint/no-base-to-string`** — string-concatenating an
  object that didn't override `toString()` surfaces `[object Object]`
  in logs and (worse) in user-facing error toasts. The rule flags any
  template literal or `+` operator where a non-stringifiable value can
  flow in.

## section 7. Data-safety patterns

Two patterns live under this umbrella: forward-compat storage (survive
version skew across reader / writer) and atomic working-tree writes
(survive partial-failure mid-flight). Both defend against the same class
of failure — persisting half-state that a later read observes as
authoritative — and the testing strategies are parallel enough that they
read best side-by-side.

### 7.1. Storage forward-compat registry

Services that persist JSON to the `.git/` directory (currently
`ChangelistService` → `intellig-changelists.json` and `ShelfService` →
`intellig-shelf.json`) follow a common forward-compat pattern so an older
version of the extension doesn't silently drop fields emitted by a newer
version when it reads and re-saves the file:

1. Declare a narrow storage interface (`IChangelistStorage` /
   `IShelfStorage`) listing only the keys the current version
   recognises.
2. Declare a `KNOWN_*_KEYS_SPEC` `satisfies` literal that causes the
   build to fail if a new field is added to the interface without being
   registered in the spec. The `Set` used at runtime is derived from the
   spec via `Object.keys(...)` so the two can never drift.
3. During load (`migrateStorageForTest` / `migrateShelfStorageForTest`),
   partition the parsed record into known vs. unknown keys; stash the
   unknown half on `_unknownTopLevel` (top-level) or `_unknownItem`
   (per-item) or `_unknownFileField` (per-file, shelf only). These are
   in-memory bookkeeping — they never themselves appear as on-disk keys.
4. During save (`serializeStorageForDisk` / `serializeShelfForDisk`),
   emit the known keys in a stable order, then spread the captured
   unknowns back out as anonymous siblings.

Property tests assert the round trip with a fast-check arbitrary that
injects a few arbitrary-named scalar extras at each level:

```ts
fc.assert(
  fc.property(payloadArb, (raw) => {
    const onDisk = mkPayload(raw); // JSON-shaped input
    const loaded = migrateStorageForTest(onDisk);
    const emitted = serializeStorageForDisk(loaded);
    for (const k of Object.keys(raw.topLevelUnknown)) {
      assert.deepStrictEqual(emitted[k], raw.topLevelUnknown[k]);
    }
  })
);
```

Plus a hand-crafted pinned regression `it(...)` that locks in a
realistic forward-compat payload (e.g. a top-level `schemaExtension`
object, per-item `labels`/`priority`, per-file `isBinary`/`encoding`).

Reference implementations:

- `src/changelists/ChangelistService.ts` — `KNOWN_TOP_LEVEL_KEYS_SPEC` /
  `KNOWN_ITEM_KEYS_SPEC`; `migrateStorageForTest` /
  `serializeStorageForDisk`.
- `src/shelf/shelfStorageMigrate.ts` — `KNOWN_SHELF_TOP_LEVEL_KEYS_SPEC` /
  `KNOWN_SHELF_ITEM_KEYS_SPEC` / `KNOWN_SHELF_FILE_KEYS_SPEC`;
  `migrateShelfStorageForTest` / `serializeShelfForDisk`.

Reference property suites:

- `test/property/changelistStorageRoundTrip.property.test.ts`
- `test/property/shelfStorageRoundTrip.property.test.ts`

### 7.2. Atomic-write testing patterns

All writes from `PatchService.createPatchFromLocalChanges`,
`ShelfView.createPatchFromShelf`, `CommitContextMenuCommands` patch
export, `MergeView.markResolved`, `ChangelistService.saveChangelistStorage`,
and `ShelfService.saveShelfStorage` route through `atomicWriteFile` in
`src/utils/atomicWrite.ts`. This matters because a partial write (EBUSY
on a Windows-locked file, ENOSPC on a full disk, SIGKILL mid-flight)
must never leave a truncated file at the target path — downstream
consumers (`git apply`, `git am`, storage loaders) silently fail on junk.

Three test patterns give us confidence these sites stay honest:

1. **Injection seam — `IAtomicWriteFsAsync`.** `atomicWriteFile`
   accepts an optional `fs` dependency matching
   `IAtomicWriteFsAsync`. Unit tests pass a synthetic fs whose `rename`
   throws EBUSY / `writeFile` throws ENOSPC / `unlink` throws ENOENT
   etc., and assert that the target file is left in its previous state
   and that the sibling `<target>.tmp-<pid>-<ts>` is cleaned up (or
   demonstrably removed even under failure).

2. **Real-fs integration — `mkdtemp` + happy path + fault injection.**
   Integration tests (`patchService.test.ts`,
   `shelfView.test.ts` `createPatchFromShelf`,
   `CommitContextMenuCommands.test.ts`) use a real
   `fs.mkdtempSync(os.tmpdir() + '/...-')` workspace, call through the
   public API, read the resulting file, and assert content. For the
   fault-injection half, they point the save dialog at a path whose
   parent directory does not exist — this is the canonical cheap fault
   because `atomicWriteFile` naturally rejects with ENOENT when its
   sibling-tmp write can't open its parent.

3. **Sibling-tmp-debris hygiene.** After a successful write, the
   directory listing must contain the target file and nothing else that
   matches the `.tmp-` discriminator. After a failed write, the target
   must not exist and no `.tmp-*` sibling may remain. Both assertions
   are cheap and cover the "rename survived but tmp leaked" and
   "tmp survived but rename rolled back" failure modes.

Reference test files:

- `test/unit/services/patchService.test.ts` (integration + atomic)
- `test/unit/services/shelfView.test.ts` (`createPatchFromShelf` —
  atomic write)
- `test/unit/commands/CommitContextMenuCommands.test.ts`
  (commit-context patch export: atomic write + fault injection)
- `test/unit/utils/atomicWrite.test.ts` (unit-level fault injection
  via `IAtomicWriteFsAsync`)

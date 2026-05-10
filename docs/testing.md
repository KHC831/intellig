# Testing

IntelliG has four distinct test layers plus a small set of test-infra
directories. This document is the canonical reference for where a new
test or test helper belongs, and how to reach into private state from
a test without rotting the production API.

## §1. Test layers

| Layer      | Path                 | VS Code host? | Real git? | Driver     | Approx. count |
| ---------- | -------------------- | ------------- | --------- | ---------- | ------------: |
| Unit       | `src/test/unit/**`   | no            | no        | Mocha      |          2542 |
| Property   | `src/test/property/**` | no          | no        | fast-check |          3158 |
| Ext-host   | `src/test/ext-host/**` | yes         | no        | Mocha      |            22 |
| E2E        | `src/test/e2e/**`    | yes           | yes       | Mocha      |            36 |

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
  Per-test isolated via `src/test/e2e/support/Fixture.ts` +
  `workspaceHelper.ts`. Use for command flows that exercise real git
  state transitions. These are slow; budget carefully.

## §2. Test-infra locations

```
src/test/
├── mocks/         ← module-resolution substitutes (resolved at build time)
├── typed/         ← typed accessors for unit + property suites
├── e2e/support/   ← E2E fixtures, stubs, workspace helper
├── unit/          ← unit suites
├── property/      ← property suites
├── ext-host/      ← extension-host smoke suites
└── e2e/           ← end-to-end suites
```

- **`src/test/mocks/`** — module-resolution substitutes. `vscode.ts` is
  hoisted by the test runner to replace `import * as vscode` in the
  graph. Anything that an import statement resolves to, for test
  purposes, lives here.
- **`src/test/typed/`** — typed bridges into private state (e.g.
  `writableWindow` for casting to a `vscode.window` override surface,
  `invokePrivateHandler` for driving a tree-view's private command
  dispatcher). Used by unit + property suites. (Formerly `helpers/`;
  renamed under TL-26 so the intent is evident from the path.)
- **`src/test/e2e/support/`** — E2E-only: `Fixture`, `workspaceHelper`,
  test-process stubs. Depends on VS Code + real filesystem.

## §3. The TestSurface idiom

To reach private class members from tests, **declare a named
`<ClassName>TestSurface` (or `<ClassName>Internals`) interface**
co-located in the test file or a test-helper adjacent to the class.
Cast via `as unknown as <Name>`. JSDoc why. No inline anonymous shapes.
No kitchen-sink surfaces.

**Rules:**

1. Interface name ends in `TestSurface` or `Internals`.
2. Kept narrow — typically ≤5 fields. Each field is a private member the
   test genuinely drives.
3. JSDoc on the interface explains *why* the test reaches through the
   private boundary (what contract it's asserting that the public API
   can't express).
4. No inline `as unknown as { ... }` literals — every such cast gets a
   named interface.
5. No omnibus "all private members" surface — one surface per concern.

**Exemplars on main:**
- `src/test/unit/services/resetDialog.test.ts` — `ResetDialogInternals`
  (2 fields; drives `_onMessage` + reads `_panel.webview.html`).
- `src/test/unit/services/commitToolWindow.test.ts` —
  `CommitToolWindowTestSurface` (drives handler dispatch under a stub
  webview).
- `src/test/e2e/support/workspaceHelper.ts` —
  `GitServiceWorkspaceHelperSurface` (enumerates repos + drops watchers
  during per-test teardown).
- `src/test/unit/services/rebaseSkip.test.ts` —
  `GitServiceGitCliTestSurface` (injects a scripted CLI into a real
  `GitService` instance).

## §4. Decision rules — where does my new test helper go?

| Scenario                                             | Put it in              |
| ---------------------------------------------------- | ---------------------- |
| Crosses unit + property (typed accessor into private state) | `src/test/typed/` |
| E2E-only (fixtures, workspace juggling)              | `src/test/e2e/support/` |
| Replaces a module import at resolution time          | `src/test/mocks/`      |
| One-off for a single test file                       | Inline in that test file |

If a helper would be used only once, don't extract it. The overhead of
reading across two files isn't paid back by a single caller.

## §5. Related

- Production-side escape hatch for raw `GitCli` access from call sites
  that the frozen `IGitService` composite deliberately doesn't wrap: see
  `IGitServiceCli` in `src/services/interfaces/IGitService.ts`. That's a
  production interface (marked `@internal`), not a TestSurface.

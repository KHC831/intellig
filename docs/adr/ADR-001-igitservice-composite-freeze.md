# ADR-001: Freeze the `IGitService` composite

Status: Accepted (2026-05-09)

## Context

`IGitService` has been the single entry point for every git operation in the
extension since the earliest parity work. It is a composite interface — one
TypeScript interface holding every method the extension calls against a
repository, from `getRepositories()` through `commit()` / `push()` /
`rebase()` all the way to `revertFile()` and `resetToCommit()`. The
production class `GitService` implements this interface, and every
service / dialog / command in the codebase depends on it.

Over the course of the IntelliJ-parity effort the composite grew past the
point where a single interface was a net positive:

- The method count crossed the threshold where test stubs were copy-pasting
  full signatures just to throw `'unreachable'`. The `variadic-unknown[]
throwError` idiom (see `docs/testing.md` section 3) exists precisely because
  hand-typing every signature in an error-throwing stub is noise that
  drifts every time the interface changes.
- Consumers that only care about a narrow slice of the surface
  (`BranchPopup` wants branch operations; `ShelfView` wants shelf-adjacent
  working-tree operations; the history pane wants log + show) still have
  to take the whole composite as an opaque dependency. This obscures what
  each call site actually uses, which in turn obscures which sites would
  break under a refactor that swapped the implementation.
- Adding a new git capability reliably reopens the "should this live on
  `IGitService` or on a new interface" debate in review, with no
  principled answer on hand.

## Decision

**`IGitService` is frozen.** No new methods will be added to this interface.
New git capabilities land on narrower role interfaces. Candidate role
interfaces (named by the domain they own, not by a refactor task ID):

- `IGitRemote` — remote enumeration, fetch / push mechanics.
- `IGitHistory` — log, show, blame.
- `IGitBranches` — branch list, checkout, create, delete, rename.
- `IGitStash` — stash push / pop / list.
- `IGitTags` — tag list, create, push.
- `IGitWorkingTree` — status, add, revert, reset, diff.
- `IGitRepository` — repository discovery + lifecycle + change events.
- `IGitReplay` — rebase, cherry-pick, merge drivers.

These are a starting point. The actual split will be driven by what the
call sites already want to consume — the role interfaces are emergent, not
top-down.

`GitService` (the class) will eventually implement each role interface
it covers, and consumers will be refactored to depend on the narrowest
role they can. Until that decomposition lands, the composite stays as a
dead-letter convenience aggregate — it is not itself modified, and no
new consumers should take it as a dependency when a narrower shape is
already available.

## Consequences

### Positive

- New git capabilities slot cleanly into a focused role interface or
  spawn a new one, without re-litigating the composite's shape per feature.
- Call sites become legible: a class that depends on `IGitBranches`
  obviously does branch work; a class that depends on `IGitService` is
  obviously due for a migration.
- Test stubs shrink. A branch-context-menu test mocks `IGitBranches`
  with a handful of methods rather than the entire composite.
- The `variadic-unknown[] throwError` stub pattern becomes a transitional
  convenience rather than a permanent necessity — once a call site
  depends on a role interface, a typed stub for that role is practical
  to hand-write.

### Negative / costs

- The eventual decomposition is a broad refactor touching every consumer
  of `IGitService`. It is deferred; while deferred, the codebase carries
  both shapes (composite + emerging roles) and reviewers have to choose
  the right target per addition.
- Until the split lands, the dead-letter composite is still on the critical
  path for tests — `IGitService` stubs remain common. The freeze does not
  delete existing signatures.

### Neutral

- The `IGitServiceCli` `@internal` escape hatch (exported alongside
  `IGitService`) is _not_ part of the composite. It exposes the raw
  `GitCli` handle for call sites that need to issue commands the
  composite deliberately doesn't wrap (e.g. `git show <ref>:<path>`
  from the `intellig-git:` content provider, or console-capture wiring
  in `ExtensionServices`). Each such call site is a candidate to become
  a proper role-interface method during the decomposition. New call
  sites should not use the escape hatch without review — the hatch is
  an acknowledged leak, not a blessed pattern.

## Motivating seeds for the role split

Three `TestSurface` interfaces already cast narrow slices of service
state, and each is a natural seed for a role interface:

- **`GitServiceGitCliTestSurface`** (see
  `test/unit/services/rebaseSkip.test.ts`) — casts to the `GitCli`
  injection point to scripts a command. This is the seed for a
  `IGitReplay` / `IGitWorkingTree` split along whichever boundary the
  rebase-skip flow sits on.
- **`ChangelistServiceTestSurface`** — casts to the change-event +
  persistence side of the service. Seed for a working-tree-adjacent
  role interface that the composite currently proxies through
  `IGitService`.
- **`ShelfServiceTestSurface`** — casts to the shelf-persistence side.
  Seed for a `IShelfPersistence` (or similar) interface that lives
  alongside `IGitWorkingTree`.

Each surface already documents _why_ the test reaches past the public
API — those "why"s describe exactly the contracts a role interface
would eventually express.

## References

- `src/services/interfaces/IGitService.ts` — composite interface + the
  `@internal IGitServiceCli` escape hatch.
- `docs/testing.md` section 3 — `variadic-unknown[] throwError` stub pattern.
- `docs/testing.md` section 5 — relationship between the production escape
  hatch and the test-side `TestSurface` idiom.
- `docs/testing.md` section 7 — data-safety patterns that live downstream of
  the service interfaces.

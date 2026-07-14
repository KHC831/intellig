# ADR-012: Topical `/src` source tree restructure

Status: Accepted (2026-05-26)

## Status update — migration complete

> This block is a historical removal record, not an operative reference.
> The Decision and Consequences prose below is preserved verbatim as the
> original record of the decision.

The one-time ADR-012 migration is **complete**, and the topical `/src`
restructure it produced **remains in force**. The decision is not
reversed: the source tree stays grouped by topic exactly as described
below. Only the one-time _machinery_ that performed and policed the move
has been retired now that it has served its purpose.

The following Migration_Resource groups have been retired and removed
from the repository:

| Retired group                | Path(s)                                                                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Restructure_Plan**         | `scripts/restructure/plan.json`                                                                                                                                                                                                        |
| **Migration_Script**         | `scripts/restructure/migrate.mjs`                                                                                                                                                                                                      |
| **Migration_Property_Tests** | `src/test/property/restructurePlanTotality.property.test.ts`, `src/test/property/migrateBoundary.property.test.ts`, `src/test/property/migrateIdempotence.property.test.ts`, `src/test/property/migrateImportRewrite.property.test.ts` |
| **Migration_Unit_Tests**     | `src/test/unit/scripts/restructure/` (the whole folder)                                                                                                                                                                                |

**No migration-pinned invariant required relocation.** Every invariant
that was presently binding when the migration tooling was retired is
already enforced by a retained guard or test, so nothing had to be moved
into a new home to survive the removal:

- the **ADR-006** QuickPick view-state guard
  (`scripts/check-quickpick-state-no-error.sh`) still enforces the
  no-`error?`-sideband invariant against the live tree;
- the **ADR-008** watcher-family registration guard
  (`scripts/check-watcher-families-registered.mjs`) still enforces the
  `_*Watchers` cleanup-registry invariant against the moved
  `GitService.ts`;
- the per-ADR conformance suites and the storage round-trip suites
  remain present and continue to enforce their respective invariants.

Because the migration unit and property tests only ever asserted
migration _mechanics_ (path mappings resolved through the now-removed
`plan.json`), retiring them removed no sole enforcement of a
still-relevant invariant.

## Context

The extension grew its service layer past the point where a flat
`src/services/` directory was a net positive. By the time this ADR was
written the folder held ~30 files — service classes, webview hosts,
dialogs, tree providers, and a parallel `src/services/interfaces/`
folder of one-interface-per-file declarations — grouped by _mechanical
type_ (everything that is "a service" lives here) rather than by
_topic_ (everything that is "about branches" lives together).

The cost showed up in review and onboarding. A reviewer touching the
blame feature had to hold a 30-entry mental map of `src/services/` to
know that `BlameService.ts`, `BlameOptionsSource.ts`,
`InlineBlameProvider.ts`, and `GutterBlameProvider.ts` form one
coherent unit, plus three more entries under `interfaces/`. Nothing in
the directory layout grouped them; the relationship lived only in the
import graph and in the reviewer's head.

This restructure is co-scoped with the structured Logger (ADR-011)
because the Logger introduces a new cross-cutting module
(`src/utils/logger/`) whose home in the tree is the cleanest placement
test for the restructure — designing the two together avoids naming
the file twice.

The work is constrained to be **observably behaviour-preserving**: a
user running the extension before and after the move sees identical UI,
notifications, persisted files, and commands. Only the on-disk source
tree changes. That constraint, plus the existing ADR set, is what makes
this a documented decision rather than a mechanical `git mv` sweep:
several ADRs pin invariants that are keyed off specific file paths or
specific symbol surfaces, and the restructure has to preserve every one
of them.

## Decision

### Topical grouping

Every file currently in `src/services/` moves into a topical
subdirectory of `src/` named for the feature area it belongs to. The
git-domain utilities currently sitting in `src/utils/` (the ones that
are _not_ domain-agnostic) move into a new `src/git-core/` alongside the
core plumbing. The full directory list, with rationale per folder:

| New directory                  | Files moved into it                                                                                                                                                                                                                                                                                                                                                                               | Rationale                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/git-core/`                | `GitService.ts`, `RebaseService.ts`, the whole `gitToolWindow/` subtree, `interfaces/IGitService.ts`, `interfaces/IGitToolWindowProvider.ts`, `interfaces/IRebaseService.ts`, plus the pure git-domain utils `gitCli.ts`, `gitParser.ts`, `gitError.ts`, `commitGraph.ts`, `commitSort.ts`, `repoScan.ts`                                                                                         | Core git plumbing, parsing, and the omnibus `IGitService`-composite-frozen surface (ADR-001). The git-tool-window UI lives in its own subfolder under here because it is tightly bound to `IGitService`. |
| `src/branches/`                | `BranchPopup.ts`, `BranchTreeProvider.ts`, `BranchComparisonView.ts`, `NewBranchDialog.ts`, `BranchContextMenuCommands.ts`, `interfaces/IBranchComparisonView.ts`                                                                                                                                                                                                                                 | Branch list / popup / context menu / comparison view.                                                                                                                                                    |
| `src/blame/`                   | `BlameService.ts`, `BlameOptionsSource.ts`, `InlineBlameProvider.ts`, `GutterBlameProvider.ts`, `interfaces/IBlameService.ts`, `interfaces/IInlineBlameProvider.ts`, `interfaces/IGutterBlameProvider.ts`                                                                                                                                                                                         | All annotate-with-git-blame surfaces.                                                                                                                                                                    |
| `src/commits/`                 | `CommitDialog.ts`, `CommitToolWindow.ts`, `CommitContextMenuCommands.ts`, plus `index.ts` (the rehomed commands re-export shim)                                                                                                                                                                                                                                                                   | Commit dialog, commit tool window, commit-row context menu.                                                                                                                                              |
| `src/conflicts/`               | `ConflictResolutionService.ts`, `MergeView.ts`, `MergeDialog.ts`, `ResolveConflictsDialog.ts`, `interfaces/IConflictResolutionService.ts`, `interfaces/IMergeView.ts`                                                                                                                                                                                                                             | Three-way merge view and conflict resolution.                                                                                                                                                            |
| `src/patches/`                 | `PatchService.ts`, `ApplyPatchDialog.ts`, `interfaces/IPatchService.ts`                                                                                                                                                                                                                                                                                                                           | Patch apply / create / shelf-import.                                                                                                                                                                     |
| `src/changelists/`             | `ChangelistService.ts`, `interfaces/IChangelistService.ts`                                                                                                                                                                                                                                                                                                                                        | Changelist storage and ops.                                                                                                                                                                              |
| `src/shelf/`                   | `ShelfService.ts`, `ShelfView.ts`, `StashView.ts`, `interfaces/IShelfService.ts`, `interfaces/IShelfView.ts`, `interfaces/IStashView.ts`                                                                                                                                                                                                                                                          | Shelf and stash (paired UI; shared concerns).                                                                                                                                                            |
| `src/rebase/`                  | `RebaseEditor.ts`, `RebaseProgressView.ts`, `interfaces/IRebaseEditor.ts`                                                                                                                                                                                                                                                                                                                         | Interactive rebase editor and progress view.                                                                                                                                                             |
| `src/sync/`                    | `PullDialog.ts`, `PushDialog.ts`, `AutoFetchService.ts`, `interfaces/IAutoFetchService.ts`                                                                                                                                                                                                                                                                                                        | Pull / push / auto-fetch.                                                                                                                                                                                |
| `src/ui-shell/`                | `GitToolWindowProvider.ts` (the panel host; the `gitToolWindow/` subfolder itself lives under `git-core`), `StatusBarService.ts`, `NotificationService.ts`, `KeymapService.ts`, `ConsoleService.ts`, `ResetDialog.ts`, `interfaces/IStatusBarService.ts`, `interfaces/INotificationService.ts`, `interfaces/IKeymapService.ts`, `interfaces/IConsoleService.ts`                                   | Cross-cutting UI services and dialogs that don't belong to a single feature area.                                                                                                                        |
| `src/config/`                  | `ConfigurationService.ts`, `interfaces/IConfigurationService.ts`                                                                                                                                                                                                                                                                                                                                  | Configuration projection.                                                                                                                                                                                |
| `src/services/` (kept; thin)   | `index.ts` (the public services barrel, kept at its original path), `ExtensionServices.ts` (the DI composition root), `interfaces/index.ts` (interfaces barrel, kept as a compatibility re-export)                                                                                                                                                                                                | The public Public_Service_API barrel and the DI composition root — `ExtensionServices` stays because it composes every topic.                                                                            |
| `src/utils/` (kept)            | The domain-agnostic utilities (`atomicWrite.ts`, `BaseWebviewPanel.ts`, `BaseWebviewView.ts`, `cache.ts`, `commitMessageHtml.ts`, `errorHandler.ts`, `graphRenderer.ts`, `hostingLinks.ts`, `keymapMigration.ts`, `lazyLoader.ts`, `outputChannel.ts`, `panelLayout.ts`, `remoteUrl.ts`, `resolveRepo.ts`, `safeFireAndForget.ts`, `webviewNonce.ts`, `index.ts`), plus the new `logger/` subtree | Generic, domain-agnostic utilities. The git-domain ones move into `src/git-core/`.                                                                                                                       |
| `src/test/` (kept identically) | Every subfolder preserved at the same path (Requirement 9.3)                                                                                                                                                                                                                                                                                                                                      | The `.mocharc.json` glob `src/test/unit/**/*.test.ts` keeps discovering specs unchanged.                                                                                                                 |
| `src/extension.ts` (kept)      | Unmoved (Requirement 9.2)                                                                                                                                                                                                                                                                                                                                                                         | Top-level entry point.                                                                                                                                                                                   |

The split is by topic, not by mechanical type: each feature folder
carries its service, its UI surfaces, its dialogs, and a nested
`interfaces/` folder for the role interfaces it owns. `ExtensionServices`
and the services barrel stay put so the public surface and DI root are
unmoved.

### Deterministic plan as a single committed data file

The mapping from old path to new path is encoded as a single committed
JSON file, `scripts/restructure/plan.json` (Requirement 12.1). Its
shape:

```json
{
  "version": 1,
  "moves": [
    { "from": "src/services/GitService.ts", "to": "src/git-core/GitService.ts", "rationale": "…" },
    …
  ],
  "barrelShim": { "path": "src/services/index.ts", "strategy": "rewrite-as-reexport-from-new-locations" }
}
```

The plan is **exhaustive**: every regular file under `src/` appears as
exactly one entry. Files that move carry a `from ≠ to` entry; files that
stay (everything under `src/test/`, `src/extension.ts`, the retained
`src/utils/**`, and the kept `src/services/index.ts` /
`ExtensionServices.ts`) appear as `from === to` _identity_ entries.
Encoding the no-move files explicitly is what gives the migration its
plan-coverage totality (every file is accounted for) and its
"re-run is a no-op" guarantee. Each entry also carries a one-line
`rationale` so the plan is self-documenting.

### Migration-script architecture

The plan is consumed by `scripts/restructure/migrate.mjs`, a Node ESM
script that resolves `plan.json` relative to its own `import.meta.url`
so it is invokable from any working directory. The pipeline:

1. **Load + validate the plan.** Reject malformed JSON, a wrong
   `version`, a missing `moves` array or `barrelShim` block, and any
   per-entry shape error. Then validate against the working tree:
   `from` paths are unique, `to` paths are unique, and each non-identity
   move is in exactly one of the legal states — _pending_ (`from`
   exists, `to` absent) or _already-applied_ (`from` absent, `to`
   exists). A partial-applied state (both endpoints present) or a
   missing source (neither present) is rejected, because the script
   cannot tell which copy is canonical.

2. **Rename phase.** For each pending move, `mkdir -p` the target
   directory and `fs.rename(from, to)`. Re-running against a
   fully-applied tree finds zero pending moves and exits 0 as a no-op
   (Requirement 12.3, 14.5 — idempotence).

3. **ts-morph import rewrite.** Every `.ts`/`.tsx` file under `src/` is
   loaded into a ts-morph project. For each `ImportDeclaration`,
   `ExportDeclaration`, dynamic `import('./path')`, and
   `import('./path').T` type node whose resolved specifier points at a
   plan `from` path, the specifier is rewritten to the corresponding
   `to`, preserving relative-vs-absolute style and any explicit
   extension (Requirement 12.5). ts-morph saves a file only when its
   text actually changed, so a second pass mutates nothing.

   The rewriter's forward map **includes identity entries** on purpose:
   when a source file moves but its import target does not (for example
   a file moving into `src/git-core/gitToolWindow/` that imports
   `'../interfaces'`, which resolves to an unchanged target), the
   relative specifier still has to be recomputed from the source's _new_
   directory to the unchanged target. Leaving identity targets out of
   the map was the root cause of an earlier breakage; including them is
   the fix.

4. **Post-rewrite self-check.** After each file's rewrite pass, every
   effective specifier (whether changed or intentionally preserved) is
   re-resolved against the source file's post-migration directory and
   checked against the set of paths that will exist post-migration. A
   failure aborts with the specific `file:line:specifier` offender — it
   surfaces breakage earlier and more precisely than `tsc` would, which
   reports a module-resolution error at the import site without naming
   the rewriter as the cause. A companion emitted-text check reads back
   each rewritten specifier and rejects any that emitted embedded quotes
   (setter quote-corruption).

5. **Unmapped-path guard.** After the rewrite, walk `src/` and assert
   every regular file's repo-relative path appears in the plan as a
   non-identity `to` or an identity `from`. An unmapped path exits
   non-zero naming the offender (Requirement 12.4).

6. **Barrel regeneration.** `src/services/index.ts` is re-emitted from a
   deterministic template — `export … from '<new-path>';` lines sorted
   lexicographically, leading comment block preserved — written only
   when the rebuilt content differs from disk. Before any write, the
   Public_Service_API fingerprint (the set of re-exported names) is
   verified byte-identical to the original, so the barrel's public
   surface cannot drift during the move (Requirement 10.3, 10.4).

7. **`tsc --noEmit` gate + git-restore rollback.** The script runs the
   TypeScript compiler against the rewritten tree. A clean exit
   completes the migration; any non-zero exit dumps the captured
   diagnostics to stderr and restores every plan path (both `from` and
   `to`) from `HEAD` via `git restore`, then exits non-zero. This is the
   no-cycle / no-regression backstop (Requirement 9.5, 13.6) that the
   property tests cannot check statically.

**Boundary discipline.** Every filesystem write routes through a
pre-write `assertWriteAllowed` check. The script may write only inside
`src/`, `scripts/restructure/`, `docs/adr/`, and the named guard scripts
under `scripts/`; it specifically refuses to touch `package.json`,
`.mocharc.json`, `tsconfig.json`, `README.md`, `docs/parity/**`, or
`media/**` (Requirement 12.6).

**Operating modes.** The script takes three mutually-exclusive flags:

- `--dry-run` prints every planned rename and import rewrite without
  writing. The self-check still runs (a planning bug is caught before
  any file is touched); the unmapped-path guard and the `tsc` post-step
  are skipped, because they verify the post-write tree.
- `--check` verifies the working tree already matches the
  post-migration shape and exits 1 on any divergence — this is the CI
  structural guard.
- `--rollback` restores every plan path from `HEAD~1`, but only when the
  working tree is clean and `HEAD~1` exists (i.e. the migration commit
  is the only delta on top of it).

### ADR conformance

The restructure honours every accepted ADR. The decisions that are
keyed off specific file paths or specific symbol surfaces are preserved
as follows:

| ADR                                                     | What it pins                                                                       | How the plan preserves it                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADR-001** (IGitService composite freeze)              | the `IGitService` composite shape                                                  | `IGitService.ts` moves from `src/services/interfaces/` to `src/git-core/interfaces/` but the _type_ is byte-identical. The barrel re-export keeps `IGitService` importable at the same module specifier.                                                                                                                                                                                                                                                      |
| **ADR-002** (module-level singletons in `src/utils/`)   | `getOutputChannel`'s four criteria, and the home for new cross-cutting singletons  | `src/utils/outputChannel.ts` stays in place. The new `src/utils/logger/` subtree also lives under `src/utils/` and satisfies all four criteria (see ADR-011).                                                                                                                                                                                                                                                                                                 |
| **ADR-005** (sanitizer pass ordering)                   | the `sanitizeGitError` regex order                                                 | `gitError.ts` moves to `src/git-core/gitError.ts`; the regex order is unchanged byte-for-byte, and the logger sanitizer _calls_ `sanitizeGitError` rather than re-deriving the order — so the ordering is preserved by construction.                                                                                                                                                                                                                          |
| **ADR-006** (error-state binding by view type)          | the QuickPick view-state interfaces tracked by `check-quickpick-state-no-error.sh` | the tracked-paths list in the guard is updated in the same diff that moves the files, so the no-`error?`-sideband invariant keeps being enforced against the new paths.                                                                                                                                                                                                                                                                                       |
| **ADR-007** (structural guards as a complementary tool) | the guard scripts themselves                                                       | `check-watcher-families-registered.mjs` is repointed at `src/git-core/GitService.ts`; `check-output-channel-test-surface.sh` is renamed to `check-test-only-surface.sh` and extended to also forbid production references to `__resetLoggerForTest`; the action-toasts and quickpick-state guards get their fixed-path lists updated. The script's own boundary discipline is allowed to touch exactly these guard scripts and nothing else under `scripts/`. |
| **ADR-008** (watcher families)                          | the `_*Watchers` cleanup-registry registration in `GitService`                     | `GitService.ts` moves under `src/git-core/`; the watcher-family registration code is byte-identical, and the repointed `check-watcher-families-registered.mjs` keeps passing against the moved file.                                                                                                                                                                                                                                                          |

The remaining accepted ADRs are unaffected by the move: ADR-003
(storage round-trip) — `ChangelistService` and `ShelfService` move under
their topic folders with no change to any persisted JSON shape; ADR-004
(atomic-write routing) — `src/utils/atomicWrite.ts` stays in place and
only the import paths in moved consumers update; ADR-009 (webview state
ownership) — the host-leads pattern is per-class behaviour, unaffected
by file location; ADR-010 (visual parity discipline) — the plan does not
touch `docs/parity/` or `media/` at all.

## Consequences

### Positive

- A reviewer touching one feature area finds its service, UI surfaces,
  dialogs, and interfaces in one folder instead of scattered across a
  30-entry flat directory.
- The migration is reproducible from a single committed plan: anyone can
  re-run `migrate.mjs` and get the same tree, and `--check` turns
  "did the tree drift from the plan?" into a CI gate.
- Idempotence plus the `tsc --noEmit` gate plus the post-rewrite
  self-check make the move safe to land in one commit — a broken rewrite
  rolls itself back rather than landing half-applied.
- The Public_Service_API fingerprint check means the move provably does
  not widen or narrow the services barrel; an accidental add/remove
  fails the migration rather than slipping through.

### Negative / costs

- The plan is verbose: every no-move file is listed as an identity
  entry, so `plan.json` enumerates the entire `src/` tree. That is the
  price of plan-coverage totality and the no-op-on-rerun guarantee; a
  sparser plan could not prove it had accounted for every file.
- The migration script carries real machinery (ts-morph, a self-check,
  a barrel regenerator, a `tsc` gate, three operating modes). It is more
  than a `git mv` loop because the path-keyed ADR invariants and the
  import graph demand it. That code has to be maintained alongside the
  guards it updates.
- ts-morph's resolution mirrors Node's extension probing by hand
  (`.ts` / `.tsx` / `/index.ts`); a future module-resolution wrinkle
  (e.g. `.mts`) would need the probe extended.

### Neutral

- `src/git-core/` deliberately mixes "service + interfaces + the
  git-domain utils that used to live in `src/utils/`". The boundary is
  "is this git-domain?", not "is this a service?" — domain-agnostic
  utilities stay in `src/utils/`.
- `src/ui-shell/` is a catch-all for cross-cutting UI services and
  dialogs that don't belong to a single feature. It is expected to be
  the folder that gets re-split first if the tree grows again; that is a
  signal, not a problem.
- The restructure changes only the source tree. It is invisible at
  runtime — same UI, same persisted files, same commands.

## Alternatives considered

- **Leave `src/services/` flat.** Rejected: the navigation cost was the
  motivating problem, and a flat folder only grows.
- **`git mv` by hand, fix imports manually.** Rejected: not reproducible,
  no idempotence, no `tsc` gate, and no mechanical proof that the
  services barrel and the ADR-keyed guards stayed intact. A by-hand
  sweep across ~30 files plus their importers is exactly the kind of
  change where a missed import or a silently-dropped barrel export
  slips through review.
- **Group by mechanical type but nest deeper** (e.g.
  `src/services/blame/`, `src/services/branches/`). Rejected: it keeps
  the "everything is under services" framing that obscures topic, and it
  would still require moving the git-domain utils out of `src/utils/`
  separately. Topic-first folders directly under `src/` read better.

## References

- `scripts/restructure/plan.json` — the deterministic path-mapping plan.
- `scripts/restructure/migrate.mjs` — the migration driver (rename,
  ts-morph rewrite, self-check, unmapped-path guard, barrel
  regeneration, `tsc --noEmit` gate, `--dry-run` / `--check` /
  `--rollback` modes).
- ADR-001 — IGitService composite freeze; the surface preserved by the
  byte-identical `IGitService.ts` move and the barrel re-export.
- ADR-002 — module-level singletons in `src/utils/`; the home criteria
  the kept `outputChannel.ts` and the new `logger/` subtree satisfy.
- ADR-005 — sanitizer pass ordering; preserved by moving `gitError.ts`
  byte-for-byte and having the logger sanitizer call it.
- ADR-006 — error-state binding by view type; the QuickPick guard's
  tracked-paths list is updated in the same diff.
- ADR-007 — structural guards; the guard scripts repointed/renamed by
  the migration and the boundary the script is allowed to write to.
- ADR-008 — watcher families; the byte-identical `GitService.ts` move
  and the repointed watcher-families guard.
- ADR-011 — the structured Logger, co-scoped with this restructure; its
  `src/utils/logger/` home is the placement test that motivated
  designing the two together.

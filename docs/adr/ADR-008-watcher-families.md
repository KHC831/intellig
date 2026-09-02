# ADR-008: Watcher families and the cleanup-registry pattern

Status: Accepted (2026-05-17)

## Context

`GitService` accumulated three filesystem-watcher concerns over Waves
1–10, each with a distinct lifecycle and distinct trigger semantics:

1. **Per-repo `.git/<entry>` watchers** (Wave 1, fixed in #78).
   Installed by `setupRepositoryWatcher(rootPath)` once per discovered
   repo. Watch a narrow allow-list of `.git/` entries (`HEAD`, `index`,
   `refs/**`, `packed-refs`, in-progress markers). Feed a debounced
   refresh that calls `loadRepository` + fires
   `onDidChangeRepository`. Stored in `_fileWatchers: Map<string,
vscode.FileSystemWatcher[]>`. Disposed when the workspace folder
   that contains the repo is removed, OR (TL-88 / #213) when the
   repo's `.git/HEAD` is deleted mid-session.

2. **Mid-session new-repo watcher** (Wave 10, task #204). Installed by
   `setupNewRepoWatcher(folderPath)` once per workspace folder. Watch
   `**/.git` _creations_ under the folder so a fresh `git init` in a
   subdir is picked up without window reload. Stored in
   `_newRepoWatchers: Map<string, vscode.Disposable[]>` (single-element
   array per key to fit the registry shape — see Decision section 1 below).
   Disposed when the workspace folder is removed.

3. **Per-repo `.git/HEAD` deletion watcher** (TL-88 / #213). NOT a
   separate map — the same per-repo watcher from concern (1) hooks
   `onDidDelete` for the `HEAD` pattern specifically and routes to the
   new `_onDidRemoveRepository` emitter + `removeRepositoryWatcher`
   cleanup. Lives inside concern (1)'s family because the watcher
   handle is shared.

Pre-TL-91, `removeRepositoryWatcher(rootPath)` walked concerns (1) and
(2) by hardcoded map name. Each new family was an opportunity for a
silent leak: a future contributor who added a fourth watcher concern
(e.g. submodule-init watcher, worktree-add watcher) would have had to
remember to extend the cleanup loop. The `dispose()` method had the
same problem — it iterated the two known maps directly.

The watcher-families pattern emerged once concern (3) made it obvious
that the existing code shape didn't generalize. Rather than wait for
concern (4) to land and then re-derive the same lesson, this ADR
consolidates the design.

## Decision

### 1. Use `Disposable[]` as the per-key value shape across all watcher families

Every watcher family stores its handles as
`Map<string, vscode.Disposable[]>`. The per-repo family already used
that shape (multiple `FileSystemWatcher`s per repo, one per
`WATCHED_GIT_PATTERNS` entry). The new-repo family uses a
single-element array per key — a tiny shape compromise vs. its
"natural" `Map<string, vscode.FileSystemWatcher>` shape — so the same
cleanup walker handles both uniformly.

This is the smallest shape that admits a uniform walker. Alternatives
considered:

- **`Map<string, vscode.Disposable | vscode.Disposable[]>`** — admits
  both singular and array values. Requires `Array.isArray` branching
  at every walker site. Noisier; the consistency win of
  always-array is bigger than the saved allocation.
- **Polymorphism via per-family `cleanup(rootPath)` methods** — pushes
  the logic into N cleanup methods registered with the same registry.
  Loses the "one path-child rule, one walker" property; if a future
  family forgets to honor the path-child contract, cleanup leaks for
  THAT family only and is undetectable from the registry alone.

### 2. Register every watcher family in `_watcherMaps` at construction

`GitService` declares
`private readonly _watcherMaps: Array<Map<string,
vscode.Disposable[]>> = []` and pushes `_fileWatchers` +
`_newRepoWatchers` into it during the constructor. Adding a new family
becomes a single touchpoint:

```ts
// In the new family's lifecycle setup:
this._myNewWatchers = new Map<string, vscode.Disposable[]>();
this._watcherMaps.push(this._myNewWatchers);
```

`removeRepositoryWatcher(rootPath)` walks `_watcherMaps` uniformly:
each map → collect keys matching the path-child rule (key === rootPath
OR `path.relative` descendant) → dispose each entry's array → delete
from map. Same walker for `dispose()`.

### 3. Per-repo state (refresh timers, in-flight reload promises) stays out of the registry

`_refreshTimers` and `_reloading` are not watcher families — they're
the per-repo state that the watchers' debounce path produces. They
have lifecycle parallels (path-child cleanup) but different cleanup
operations (`clearTimeout` rather than `dispose`). Pulling them into
the registry would force an awkward "what does dispose mean for a
timeout handle?" branch that loses the registry's clarity.

The cleanup function still handles them — but as a separate loop right
after the registry walk, with an explicit comment naming them as
non-watcher state. Reviewers can see at a glance that the registry
covers all _watcher_ families and the trailing loop covers the
_driven_ state.

### 4. Path-child rule is a registry-level invariant

Pre-Wave-10, `removeRepositoryWatcher` matched keys via exact string
equality (`map.get(rootPath)`). Wave 10 R2 / TL-83 corrected that to
`path.relative(rootPath, candidate)`-based descendant detection so
removing `/work` correctly disposes `/work/projectA` and
`/work/projectB`. The registry walker bakes that rule in: it's
declared once at the top of `removeRepositoryWatcher`, and applied to
every map. New families inherit the correct semantics for free.

The `path.relative` check, not string `startsWith(rootPath + sep)`,
correctly distinguishes:

- `/work/projectA` → descendant of `/work` (cleanup target)
- `/workspace/other` → sibling that shares only a string prefix
  (preserve)
- `D:/work` vs. `C:/work` on Windows → different drives (preserve)

## Consequences

### Positive

- Adding a new watcher family is a one-line `_watcherMaps.push(...)`
  plus the family's own setup. No additional cleanup-loop wiring; no
  reviewer-time risk that a fifth, sixth, … family forgot the
  cleanup.
- `dispose()` and `removeRepositoryWatcher` use the same walker, so a
  bug in either is visible in both. Convergent maintenance.
- The path-child rule is enforced uniformly; a family can't
  accidentally use exact-key cleanup and break the nested-repo
  contract.
- The registry's iteration order is non-significant by design;
  reviewers don't have to reason about cleanup ordering between
  families.

### Negative / costs

- The new-repo family's "natural" shape (`Map<string,
FileSystemWatcher>`, one watcher per workspace folder) becomes
  `Map<string, FileSystemWatcher[]>` with single-element arrays. A
  small allocation cost (one extra array per workspace folder) and a
  cosmetic mismatch when reading the field declaration. Comment in
  the field's JSDoc names the shape compromise.
- The walker is slightly more abstract than the pre-TL-91 hardcoded
  loops. Readers who only want to know "what does
  `removeRepositoryWatcher` actually do?" have to follow one more
  level of indirection. Mitigated by the explanatory comment block at
  the top of the function and by this ADR.

### Neutral

- Existing per-repo and new-repo families don't change behavior —
  same disposal targets, same path-child rule. The refactor is
  invisible to subscribers.
- The registry doesn't enforce that families use string keys. Future
  families that key by URI or by integer would need a polymorphic key
  comparator; today every family uses absolute-path strings, so the
  walker assumes that.
- "Watcher family" is a self-descriptive name (collection of
  filesystem watchers with a shared lifecycle). No competing term in
  this codebase.

## Adopters

- **Per-repo `.git/<entry>` watchers** (Wave 1, fixed in #78). Map:
  `_fileWatchers`. Lifecycle owner: `setupRepositoryWatcher` /
  `removeRepositoryWatcher`. Cleanup trigger: workspace folder removed
  OR (TL-88) `.git/HEAD` deleted.
- **Mid-session new-repo watcher** (Wave 10, task #204). Map:
  `_newRepoWatchers`. Lifecycle owner: `setupNewRepoWatcher` /
  `removeRepositoryWatcher`. Cleanup trigger: workspace folder
  removed.

When concern (4) lands (e.g. submodule-init or worktree-add watcher),
the adopter list grows by one and the `_watcherMaps.push(...)` line in
the constructor grows by one — no other site change.

## Negative consequences

- **R1 / H2 case-sensitivity policy.** TL-89's blanket case-insensitive
  ignored-folder match silently regressed Linux: `Build/projectA/.git`
  matched the lowercase `build` entry post-TL-89, dropping the entire
  subtree. R1 / H2 split the policy: `.git`, `.vscode`, `node_modules`,
  `.next` (filesystem-canonicalized on Windows + case-insensitive
  macOS) match case-INsensitively; `out`, `dist`, `target`, `build`,
  `vendor` (legitimate Pascal-case directories on case-sensitive Linux)
  match EXACTLY. User-supplied `intellig.repositoryScanIgnoredFolders`
  matches case-INsensitively so Windows users don't have to guess
  on-disk casing. See `src/git-core/repoScan.ts` for the split.

## References

- `src/git-core/GitService.ts` —
  - `_watcherMaps` declaration (registry)
  - constructor `_watcherMaps.push(...)` (registration)
  - `removeRepositoryWatcher` (registry walker for path-child cleanup)
  - `dispose()` (registry walker for full teardown)
- `src/git-core/GitService.ts` `setupRepositoryWatcher` — installs
  per-repo `.git/<entry>` watchers; the `HEAD` pattern hooks
  `onDidDelete` for the TL-88 deletion path.
- TL-91 / #219 — the refactor that introduced the registry.
- TL-83 / Wave 10 R2 senior HIGH — the path-child rule the registry
  inherits.
- ADR-002 — module-level singletons in `src/utils/` (related but
  orthogonal: that ADR governs cross-module shared state, this one
  governs intra-class collection-of-collections).

### Companion specs (R1 / L4)

- `test/unit/services/gitServiceWatcherFamilies.test.ts` — pins the
  registry contract (3 specs): registry exposed, walker disposes a
  synthetic third-map entry, path-child rule honored across all
  registered maps.
- `test/unit/services/gitServiceRepoDeletion.test.ts` — pins the
  TL-88 + R1/C1 contract (9 specs): `onDidRemoveRepository` fires on
  both removal causes (`.git/HEAD` deletion AND workspace-folder
  removal), is idempotent, doesn't fire for sibling-prefix paths,
  and disposes per-repo watchers cleanly.
- `scripts/check-watcher-families-registered.mjs` — R1 / M2 structural
  guard enforcing every watcher-family field is registered with the
  registry at construction time. ADR-007 section "Guard maintenance contract"
  five-section header inside the script.

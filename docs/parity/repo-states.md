# Repo states — IntelliG parity reference

Status: Living reference (Wave F, 2026-05-24)

This document is the **input-space landmap** for IntelliG's
parity-targeted features. Wave F established it as the seed of
ADR-010 Layer 4 (repo-state coverage): features that look correct
against the default repo state can fail catastrophically in
non-default states, and a UX review against a happy-path repo will
not surface the gap. Each non-default state below has its own
section enumerating the git output shape, the IntelliG behaviour
contract, and the snapshot / property-test back-references that pin
the contract.

The reference behaviour is — as elsewhere in `docs/parity/` —
IntelliJ IDEA's Git tool window. Where IntelliJ's behaviour for a
particular state is unclear, the section flags an OPEN QUESTION
inline; future waves resolve them by direct comparison.

---

## §0 Repo-state landmap

A "repo state" is the value of the working tree + index + symbolic
refs that determines what `git status` and `git branch -a --format`
emit. The states below are the canonical non-default ones git can
produce. The table is the at-a-glance index reviewers consult when
spinning up a parity-targeted feature; if a row says **NOT covered**,
the feature contract for that state is undefined and will not be
caught by the Layer 1–3 snapshot suite alone.

| State                       | Shape (one-line)                                                              | Coverage                                          | Section |
| --------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| Default                     | Attached HEAD on a branch; clean working tree                                 | Covered by all existing tests                     | —       |
| Detached HEAD               | `HEAD` is a raw SHA, no symbolic ref; `git branch` shows `(HEAD detached at <sha>)` | Covered (snap-8a/8b + parseBranches-detached-1..5 + property) | §1      |
| In-progress merge           | `MERGE_HEAD` exists; `git status` reports `You have unmerged paths`           | Covered (status-bar verb-form label)              | §2      |
| In-progress rebase          | `.git/rebase-merge/` or `.git/rebase-apply/` exists; `git branch` shows `(no branch, rebasing <onto>)` | Covered (status-bar verb-form label + property test) | §3      |
| In-progress cherry-pick     | `.git/CHERRY_PICK_HEAD` exists; `git branch` shows `(no branch, cherry-pick of <sha>)` while paused | Covered (status-bar verb-form label + SHA abbreviation property) | §4      |
| In-progress revert          | `.git/REVERT_HEAD` exists; revert paused on conflict                          | Covered (status-bar verb-form label)              | §4.5    |
| Empty repo                  | `HEAD` exists but no objects; `git log` returns nothing; `git branch` empty   | Covered (initial-branch surfacing in status bar)  | §5      |

Notes on the table:

- "Covered" requires at least one Layer-1 snapshot fixture or
  property-test invariant for the state. A behavioural unit test
  alone (e.g. asserting `parseRepositoryState('rebase in progress')`
  returns `'rebasing'`) does NOT count — it pins the parser's
  classification, not the downstream feature's behaviour in that
  state.
- "Partially covered" indicates the parser-level handling has tests
  but the rendering / interaction chain has not been audited end-to-
  end. The Wave G audit candidate items each get a focused pass to
  promote them to "Covered" or move them to "NOT covered" with a
  clear gap statement.
- "Wave G candidate" is a forward-looking landmap entry — it does
  NOT block Wave F. Wave F's scope is the detached-HEAD entry only;
  enumerating the other states up-front is the discipline change
  that makes future waves cheaper.

---

## §1 Detached HEAD

### §1.1 Git output shape

When HEAD is detached at a commit (`git checkout <sha>`,
`git checkout <tag>`, mid-rebase pause, etc.) the symbolic-ref-less
nature shows up in two places:

```
$ git symbolic-ref HEAD
fatal: ref HEAD is not a symbolic ref

$ git rev-parse HEAD
5eed84b…

$ git branch -a --format='%(refname)|%(objectname)|%(upstream:short)|%(HEAD)'
(HEAD detached at 5eed84b)|5eed84b1234567890123456789012345678901234|*|
refs/heads/main|def4567890123456789012345678901234567890abc||
refs/remotes/origin/main|def4567890123456789012345678901234567890abc||
```

The first column of the first row is a **parenthesized pseudo-ref**.
It is git's descriptive label for "no symbolic HEAD"; it is not a
ref name and is emitted bare by `%(refname)` (no `refs/...` prefix).
The line carries a real `objectname` (the SHA HEAD points at) and
`%(HEAD) === '*'` (HEAD marker) — so a naive parser can mistakenly
type-coerce it into a local branch with `name = '(HEAD detached at
5eed84b)'`.

Adjacent variants the same parser must filter:

- `(no branch, rebasing main)` — emitted while a rebase is paused.
- `(no branch, bisect started on main)` — emitted while bisect is
  active.
- `(no branch, cherry-pick of <sha>)` — emitted while a cherry-pick
  is paused.
- `(no branch)` — older/edge-case variant for plain detached HEAD.

The Wave F filter rule covers ALL of them via the parenthesized
predicate `/^\(.*\)$/.test(refname.trim())`. The safety invariant is
**not** "git rejects refnames starting with `(`" — git accepts parens
in refnames (`git check-ref-format 'refs/heads/(foo)'` exits 0).
The actual invariant is that real branches always emit through the
`refs/heads/...` / `refs/remotes/...` / `refs/tags/...` prefix, so
even a legitimately-named branch `(foo)` arrives as
`refs/heads/(foo)` (trimmed refname starts with `r`, not `(`) and
survives the filter. Only pseudo-refs — which are emitted bare,
without the `refs/...` prefix — match the predicate.

### §1.2 IntelliG behaviour contract

When the repo enters detached HEAD:

1. **`getBranches()` returns the real branches only.** The
   parenthesized pseudo-ref is filtered at `parseBranches`
   (`src/utils/gitParser.ts`). Downstream consumers — branch tree,
   log graph chip map, `_handleNewBranchFrom` start-point — see
   only branches that `git checkout <name>` would accept.
2. **The detached state itself is surfaced via `repo.head?.commit`**,
   not via a fake branch. `StatusBarService:273-276` formats the
   short SHA in the status bar; `BranchPopup:704-707` shows
   `Detached at <short-sha>` as the popup header. The detached SHA
   is a first-class display, not a branch entry.
3. **"Branches → New Branch From here" works against the detached
   commit.** The action passes the SHA (from `repo.head?.commit`),
   not a parenthesized string, to `git checkout -b <new>
   <startPoint>`. Pre-Wave-F this failed with
   `fatal: '(HEAD detached at 5eed84b)' is not a commit and a
   branch '<new>' cannot be created from it` because the start-point
   came from the leaked pseudo-ref's `.name`. Post-Wave-F the leak
   is impossible — the parenthesized entry never reaches the
   action.
4. **Log graph chips for the detached commit are empty.** The
   branch-map keyed by commit hash has no entry for the detached
   SHA (parser filtered the only line that pointed there); the chip
   emit returns the empty string the same way it does for any
   commit with no branches at it.
5. **The branch tree's "Local Branches" list contains no
   parenthesized entry.** The detached state contributes nothing to
   the tree; the user sees their actual branch set.

### §1.3 Test coverage

Layer 1 — algorithm/parser:

- `parseBranches-detached-1` — single detached pseudo-ref →
  empty array. (`src/test/unit/utils/gitParser.test.ts`)
- `parseBranches-detached-2` — detached + 2 normal local + 1 remote
  → 3 branches; pseudo-ref absent.
- `parseBranches-detached-3` — `(no branch, rebasing main)` →
  filtered.
- `parseBranches-detached-4` — `(no branch, bisect started …)` →
  filtered.
- `parseBranches-detached-5` — detached pseudo-ref as ONLY entry
  → empty array.
- `parseBranches-no-regression` — existing local + remote fixtures
  parse unchanged (filter is narrow, not over-greedy).

Layer 1 — chip-emit + tree-render:

- `snap-8a` — chip-emit-stage. parseBranches → branchMap → node →
  `_getBranchLabelsHtml` returns `''` for a detached fixture.
  (`src/test/unit/utils/commitGraphSnapshots.test.ts`)
- `snap-8b` — branch-tree-stage. `BranchTreeProvider.getChildren`
  for the local-branches category returns NO item whose label or
  `branch.name` starts with `(`.

Property — predicate fuzz:

- `parseBranches.property.test.ts` — for any inner content in
  `(<segment>)`, no surviving branch name starts with `(`; the two
  normal sibling entries (`main`, `origin/main`) survive in every
  generated output. A second property covers `.trim()` so
  whitespace-padded variants are also filtered.
  (`src/test/property/parseBranches.property.test.ts`)

Layer 4 — repo-state input space:

- This §1 entry IS the Layer 4 citation. The §0 landmap row points
  here; the snapshot back-references above close the loop.

### §1.4 Cross-references

- ADR-010 Layer 4 — repo-state coverage; this section is the
  reference for the detached-HEAD input shape.
- `src/utils/gitParser.ts:198-275` — `parseBranches` with the
  Wave F filter at the top of the per-line loop body. The filter
  comment cites this section.
- `src/services/BranchTreeProvider.ts:284-304` — `_getLocalBranches`,
  the consumer that snap-8b exercises.
- `src/services/GitToolWindowProvider.ts` — `_getBranchLabelsHtml`,
  the consumer that snap-7d (no-branches) and snap-8a (post-Wave-F
  filter chain) both pin.
- `src/services/StatusBarService.ts:273-276` — detached display
  (status bar). Pre-existing, unchanged in Wave F.
- `src/views/BranchPopup.ts:704-707` — detached display (popup
  header). Pre-existing, unchanged in Wave F.
- Pre-existing parser fragility: `gitParser.ts:204` uses `line.split('|')`
  which corrupts on legitimate refnames containing `|` (git accepts `|`
  in refnames; the parser does not). Wave G follow-up: switch to a NUL-byte
  separator (`%x00` in the format string + `-z` flag), matching the log
  parser's existing convention.

### §1.5 HEAD chip rendering (Wave G)

In detached HEAD, no branch points at the current commit. Pre-Wave-G
this resulted in a blank chip slot for the detached commit — the user
saw nothing distinguishing "this is where I am" from "this is just
some commit." Wave G adds a yellow/gold `HEAD` chip rendered on the
commit pointed at by `repo.head?.commit`.

Mechanic:

1. `loadLogCommitsForRepo` (`extension.ts`) reads `repo.head?.commit`
   and passes it as the 4th arg to `provider.updateLogState(...)`.
2. `updateLogState` stores it as `_extendedLogState.headHash`.
3. `_getBranchLabelsHtml(node)` prepends a HEAD chip when
   `node.commit.hash === _extendedLogState.headHash`.

In detached HEAD specifically:

- `repo.head.name` is `undefined` (per Wave F: `git symbolic-ref HEAD`
  exits non-zero in detached state).
- `repo.head.commit` is the SHA the user is currently checked-out at.
- The HEAD chip lights up that commit row in the graph; the user sees
  exactly where HEAD lives.
- See `docs/parity/git-log-graph.md` §2.5 for the visual treatment
  (yellow/gold, prepended FIRST, IntelliJ parity).

Refresh contract:

- After `git checkout <sha>` (CLI mutation), the host calls
  `gitService.reloadRepository(repo)` BEFORE `provider.refresh()` so
  the panel reload runs against fresh `repo.head.commit` instead of
  racing the file-system watcher's 250 ms debounced reload. Pre-Wave-G
  this caused a stale-HEAD-chip window where the chip didn't move
  until the watcher fired.

Test coverage:

- Layer 1 (chip-emit, detached state): `snap-9b` in
  `commitGraphSnapshots.test.ts` covers the detached-HEAD case
  (HEAD chip alone, no branch chips, on the detached commit).
- Layer 1 (refresh ordering): `headChipRefresh.test.ts` pins the
  invariant `reloadRepository` is awaited BEFORE `provider.refresh()`
  at every CLI mutation site.
- Layer 2 (runtime): UX-review F5 sequences `git checkout <sha>` (via
  the inline command), captures screenshots before + after to verify
  the HEAD chip moves immediately.
- Layer 4: this section IS the Layer 4 §1.5 citation. Snapshot
  back-references above close the loop.

### §1.6 Branch tree detached row (Wave H)

In detached HEAD, IntelliJ shows a `(HEAD detached at <abbr>)` entry at
the TOP of the Local Branches section in the BRANCHES tree, with a
yellow/gold icon (matching the graph HEAD chip from §1.5) and a
"detached" description. Pre-Wave-H, IntelliG showed nothing in the
BRANCHES sidebar — neither a current-branch indicator nor a row
pointing at HEAD — so the user had no way to know where they were
without switching to the log graph (where Wave G's HEAD chip lives).

Wave H adds:

1. A new `BranchTreeItemType` variant `'detached-head'` with context
   value `intellig.detachedHead`. **Type extension (not fake-IBranch)**
   because `_handleNewBranchFrom` and `_handleCheckout` read
   `item.branch?.name` as the git start-point — passing a
   parenthesized label there would resurrect the Wave F "is not a
   commit" failure class. The new field `BranchTreeItem.getDetachedHeadSha()`
   returns the full 40-char SHA, which the dispatchers use as the git
   ref instead of the parenthesized label.

2. The detached row is prepended FIRST in `_getLocalBranches()` when
   `repo.head?.name === undefined && repo.head?.commit !== undefined`.
   Empty repos (`repo.head` undefined entirely) and mid-rebase states
   (`repo.head.name` still set) DON'T trigger the row. Pinned by
   `branchTree-detached-1..5` in `BranchTreeProvider.test.ts`.

3. Right-click menu shows two entries (matching IntelliJ parity):
   "Checkout" (`intellig.branch.checkout`) and "Create New Branch
   from Here..." (`intellig.branch.newBranchFrom`). The dispatcher
   reads the SHA from `item.getDetachedHeadSha()` for both.
   **Checkout** re-runs `git checkout <sha>` (no-op-ish at git level
   when already at that commit; the existing Wave G stash/force
   fallback flow handles working-tree-dirty errors uniformly).
   **New Branch from Here** prompts for a name + creates + checks
   out the new branch from the SHA.

Composition with §1.5 (graph HEAD chip): both the chip and the tree
row use the same theme variable for color —
`statusBarItem.warningBackground` — so the visual identity is
consistent across surfaces. User who sees the gold chip on the graph
and the gold row in the tree reads them as "both are HEAD."

Refresh contract (Wave G): after `git checkout <sha>` (CLI mutation)
the `reloadRepository` chain fires `onDidChangeRepository`, which the
BranchTreeProvider subscribes to at construction time
(`BranchTreeProvider.ts:184-187`). The tree re-renders synchronously
and the detached row appears immediately. No additional plumbing
needed for Wave H.

Multi-root workspace: BranchTreeProvider is single-repo by design
(`_currentRepository: IRepository | undefined`). The detached row
appears only for the active repo's tree; switching repos via
`setRepository(repo)` re-fetches and re-renders. Per-repo
multi-tree rendering is out of scope for Wave H.

Test coverage:

- Layer 1 (tree-render): `branchTree-detached-1..5` in
  `BranchTreeProvider.test.ts` covers detached / detached+branches /
  attached / empty / mid-rebase variants.
- Layer 1 (dispatcher safety, Wave F regression class):
  `newBranchFrom-detached` and `checkout-detached` in
  `branchContextMenu.fixes.test.ts` pin that the SHA (not the
  parenthesized label) flows to `gitService.createBranch` and
  `gitService.checkout` respectively.
- Layer 1 (jsdom layout): `snap-10a` exercises
  `BranchTreeProvider.getChildren` end-to-end through the public API
  with a mock IGitService; mirrors Wave F's `snap-8b` pattern.
- Layer 2 (runtime): UX-review F5 captures the detached row visible
  at top of Local Branches in attached → detached → re-attached
  cycle; right-click menu shows Checkout + New Branch From only.
- Layer 4: this section IS the Layer 4 §1.6 citation. Snapshot
  back-references above close the loop.

---

## §2 In-progress merge — Covered

`MERGE_HEAD` exists; `git status` reports unmerged paths. The
status-bar Git widget renders a verb-form label
"**Merging \<target\>**" (or just "Merging" when the target name
isn't surfaceable from `MERGE_HEAD` alone — the file contains a
SHA, not a name).

Coverage:

- **Layer 1 (unit)**: `src/test/unit/services/StatusBarService.test.ts`
  → "in-progress labels" suite, "Merging feature/foo" + "falls back
  to verb-only label when target is unknown" cases.
- **Layer 1 (unit)**: `src/test/unit/utils/gitInProgress.test.ts`
  → "classifies merge — MERGE_HEAD only, no target name" exercises
  the on-disk reader directly against a tmpdir-scoped fake `.git/`.
- **Layer 2 (property)**: `src/test/property/inProgressTargetParse.property.test.ts`
  → invariant "target never starts with refs/heads/" + "never
  contains a newline" — covers the merge path indirectly when the
  reader's precedence rules fall through to `MERGE_HEAD`.

Open questions deferred to a future wave: branch-chip rendering on
the merge commit-in-progress (no SHA yet) and "Branches → New Branch
From here" start-point selection during a paused merge.

---

## §3 In-progress rebase — Covered

`.git/rebase-merge/` or `.git/rebase-apply/` exists. `git branch`
emits `(no branch, rebasing <onto>)` — already filtered at the
`parseBranches` parenthesized-pseudo-ref guard, so the parser-level
shield holds in this state. The status-bar Git widget renders
"**Rebasing onto \<target\>**" with the target sourced from
`rebase-merge/head-name` (interactive) or `rebase-apply/head-name`
(legacy am-style), with `refs/heads/` stripped.

Coverage:

- **Layer 1 (unit)**: `src/test/unit/services/StatusBarService.test.ts`
  → "renders 'Rebasing onto main' prefix when state=rebasing with target".
- **Layer 1 (unit)**: `src/test/unit/utils/gitInProgress.test.ts`
  → "classifies rebase via rebase-merge/" + "classifies rebase via
  rebase-apply/" + "prefers rebase over merge when both rebase-merge/
  and MERGE_HEAD exist" (precedence rule).
- **Layer 2 (property)**: `src/test/property/inProgressTargetParse.property.test.ts`
  → "target never surfaces a parenthesized pseudo-ref" — generated
  inputs include `(no branch, rebasing <foo>)` shapes git emits
  during transient states.

Open questions deferred: rebase action-button surfacing
(`Continue` / `Skip` / `Abort`) and partial-commit log-graph
treatment during a paused interactive rebase.

---

## §4 In-progress cherry-pick — Covered

`.git/CHERRY_PICK_HEAD` exists. `git branch` emits `(no branch,
cherry-pick of <sha>)` while paused — same parser shield as §3. The
status-bar Git widget renders "**Cherry-picking \<short-sha\>**" with
the SHA abbreviated through `git rev-parse --short` (one git CLI
invocation per non-idle reload, gated through `buildGitArgs`).

Coverage:

- **Layer 1 (unit)**: `src/test/unit/services/StatusBarService.test.ts`
  → "renders 'Cherry-picking abc1234' prefix when state=cherry-picking with sha".
- **Layer 1 (unit)**: `src/test/unit/utils/gitInProgress.test.ts`
  → "classifies cherry-pick — CHERRY_PICK_HEAD, abbreviates SHA via
  callback".
- **Layer 2 (property)**: `src/test/property/inProgressTargetParse.property.test.ts`
  → "SHA marker target is always abbreviated to 7 chars" — generates
  arbitrary 40-char hex SHAs and verifies `target === sha.slice(0, 7)`.

Open questions deferred: conflict-resolution flow exposes the
"current" commit (not HEAD) and `Continue` / `Abort` action wiring.

---

## §4.5 In-progress revert — Covered

`.git/REVERT_HEAD` exists during a paused revert. The status-bar
Git widget renders "**Reverting \<short-sha\>**" with the SHA
abbreviated through the same callback as §4.

Coverage:

- **Layer 1 (unit)**: `src/test/unit/services/StatusBarService.test.ts`
  → "renders 'Reverting abc1234' prefix when state=reverting with sha".
- **Layer 1 (unit)**: `src/test/unit/utils/gitInProgress.test.ts`
  → "classifies revert — REVERT_HEAD, abbreviates SHA via callback".

The revert state was not flagged in earlier landmaps because there
was no parser handling for it; both the parser-level classification
(`reverting`) and the downstream rendering land together.

---

## §5 Empty repo — Covered

`HEAD` exists (initialised by `git init`) but no objects yet. `git
log` returns nothing; `git branch` returns nothing; `git symbolic-ref
HEAD` returns the initial-branch ref (`refs/heads/main` or
`refs/heads/master` depending on git config) but the ref itself
does not yet point at any object.

`GitService.loadRepository` splits the HEAD-resolution path so an
empty repo (`symbolic-ref` succeeds, `rev-parse HEAD` exits 128)
still surfaces the initial-branch name. Without the split, the
catch-block swallowed both calls and left `head` undefined, which
fell back to a bare "No commits yet" status-bar label. The status
bar now reads "**\<initial-branch\> (no commits yet)**" — useful
signal that the user's `init.defaultBranch` is configured and where
their first commit will land.

**Decision (locked)**: SKIP `git config --get init.defaultBranch`.
`git symbolic-ref HEAD` already returns the configured initial
branch in any empty repo (git resolves `init.defaultBranch` at
`git init` time). One git-CLI call covers both default ("main") and
overridden ("trunk", "master") configurations.

Coverage:

- **Layer 1 (unit)**: `src/test/unit/services/GitService.test.ts`
  → "GitService — empty-repo HEAD surfacing" suite, exercising both
  `main` and `trunk` initial-branch shapes plus the corrupt-HEAD,
  detached, and truly-headless guard cases.
- **Layer 1 (unit)**: `src/test/unit/services/StatusBarService.test.ts`
  → "empty-repo label" suite, asserting the `(no commits yet)`
  rendering, `isEmptyRepo` state field, and tooltip narration.

Open questions deferred: log-graph treatment of an empty repo
(currently shows nothing; visually fine) and branches-popup state
when no branches exist beyond the unborn initial.

---

## §6 Parity-debt — repo-state lifecycle enum

`IStatusBarState` carries a growing flag-set of mutually-exclusive
lifecycle bits — `isDetached`, `isEmptyRepo`, and likely future flags
for bisecting / worktree-locked / submodule-uninitialised. Three
flags is the size where a discriminated-union enum stops being
premature and starts paying for itself: `repoLifecycle: 'normal' |
'detached' | 'empty' | 'bisecting' | …`.

The refactor was scoped out of the in-progress-label work because:

1. It would touch every `_buildState` / `_statesEqual` / `_updateDisplay`
   path and every snapshot test that asserts on the flag-set shape.
2. The replacement type would need to extend across the parallel
   surface in `BranchPopup._updateStatusBar` (the empty-repo parity
   fix), so the change is wider than just `StatusBarService`.

A dedicated state-shape refactor wave should:

- Introduce a `RepoLifecycle` discriminated union beside the current
  flag-set.
- Migrate `_buildState` to compute it once, pass through
  `_updateDisplay` as the single source of truth.
- Drop the flag fields; tests follow.
- Add an exhaustiveness assert (analogous to `assertNeverInProgressKind`
  in `StatusBarService`) so the next lifecycle bit fails to compile
  rather than being silently swallowed.

This entry exists so future readers don't reach the same finding and
re-open the discussion. The trade-off is locked.

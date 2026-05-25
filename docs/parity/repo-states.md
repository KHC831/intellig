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
| Detached HEAD               | `HEAD` is a raw SHA, no symbolic ref; `git branch` shows `(HEAD detached at <sha>)` | **Wave F covers** (snap-8a/8b + parseBranches-detached-1..5 + property) | §1      |
| In-progress merge           | `MERGE_HEAD` exists; `git status` reports `You have unmerged paths`           | NOT covered — Wave G candidate                    | §2      |
| In-progress rebase          | `.git/rebase-merge/` or `.git/rebase-apply/` exists; `git branch` shows `(no branch, rebasing <onto>)` | NOT covered — Wave G candidate                    | §3      |
| In-progress cherry-pick     | `.git/CHERRY_PICK_HEAD` exists; `git branch` shows `(no branch, cherry-pick of <sha>)` while paused | NOT covered — Wave G candidate                    | §4      |
| Empty repo                  | `HEAD` exists but no objects; `git log` returns nothing; `git branch` empty   | Partially covered — Wave G audit candidate        | §5      |

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

---

## §2 In-progress merge — NOT covered (Wave G candidate)

`MERGE_HEAD` exists; `git status` reports unmerged paths. The
parser-level classification is covered (`parseRepositoryState
('merge in progress') → 'merging'`), but the downstream rendering
+ interaction chain has not been audited end-to-end against this
state. Open questions for Wave G:

- Does "Branches → New Branch From here" pick the right start-point
  during a paused merge?
- Are the branch chips rendered correctly when the active commit is
  the merge commit-in-progress (which has no SHA yet)?
- What does the log graph show for the in-progress merge node?

---

## §3 In-progress rebase — NOT covered (Wave G candidate)

`.git/rebase-merge/` or `.git/rebase-apply/` exists. `git branch`
emits `(no branch, rebasing <onto>)` — already covered by the Wave F
parenthesized-pseudo-ref filter, so the parser-level shield holds in
this state too. The end-to-end rendering chain (status bar text,
"Continue / Abort" buttons, partial-commit display) is unaudited.
Open questions for Wave G:

- Are the rebase action buttons (`Continue`, `Skip`, `Abort`)
  surfaced consistently with IntelliJ's UI?
- Does the "Branches" popup correctly show the rebase target as the
  contextual branch label rather than the parenthesized pseudo-ref?
- What happens to the log graph when the user is mid-rebase and the
  todo list has been partially applied?

---

## §4 In-progress cherry-pick — NOT covered (Wave G candidate)

`.git/CHERRY_PICK_HEAD` exists. `git branch` emits `(no branch,
cherry-pick of <sha>)` while paused — same parser shield as §3.
End-to-end rendering chain unaudited. Open questions for Wave G:

- Is the cherry-pick paused state visible from the status bar?
- Does the conflict-resolution flow surface the right "current"
  commit (the one being cherry-picked, not HEAD)?
- Are the `Continue` / `Abort` actions wired to
  `cherryPickContinue` / `cherryPickAbort` consistently?

---

## §5 Empty repo — Partially covered (Wave G audit candidate)

`HEAD` exists (initialised by `git init`) but no objects yet. `git
log` returns nothing; `git branch` returns nothing; `git symbolic-ref
HEAD` returns the initial-branch ref (`refs/heads/main` or
`refs/heads/master` depending on git config) but the ref itself
does not yet point at any object. Some parser-level paths are
covered (e.g. `parseLog('')` returns `[]`), but the downstream
rendering chain — what does the log graph show? what does the
branches popup show? what does the status bar show? — has not been
audited as a single state. Wave G's audit candidate.

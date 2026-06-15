# Workstream assignment template — git4idea parity

This is the **fill-in-the-blanks brief** handed to each sub-agent that
owns one parity workstream (A–H) or one Phase-0 foundation (0a–0d). One
agent = one workstream = one disjoint directory set. Copy the template
below, fill every `<…>` slot from the audit doc
(`docs/parity/full-parity-audit-2026-06-15.md`), and pass it as the
agent's `prompt`.

## Git workflow (branching, commits, merge)

`main` is the clean linear trunk — Conventional-Commit messages, **no
merge commits**. The parity effort lands as **8–10 squashed commits on
`main`**, one per workstream. Sub-agents NEVER commit to `main` and
NEVER merge — only the orchestrator merges.

### Branch model

- Every workstream branches **off the current `main` tip**:
  `git branch parity/<id>-<slug> main` (e.g. `parity/A-commit-changelists`,
  `parity/0a-incoming-outgoing`).
- Because Wave-1 agents run **in parallel and mutate files at once**,
  each runs in its **own git worktree** so they don't fight over one
  working tree. Dispatch each Wave-1 agent with `isolation: "worktree"`
  — the worktree is created from its `parity/<id>` branch and
  auto-removed when merged. (Phase-0 agents run serially, so a worktree
  is optional for them.)

### What the sub-agent does on its branch

- Commit freely on `parity/<id>` — WIP / checkpoint commits are fine,
  they get squashed away. Use `git add` + `git commit`; never
  `push`, `reset --hard`, `checkout main`, `merge`, or `rebase`.
- Leave the branch in a green state (lint + compile + tests pass) and
  report the branch name + final SHA in the structured result.

### What the ORCHESTRATOR does (not the sub-agent)

Merge order respects dependencies: **0a → 0b → 0c first (serial)**, then
**A–H**, each only after its Phase-0 dep is on `main`. For each branch,
squash-merge into `main` so history stays linear:

```
git checkout main
git merge --squash parity/<id>-<slug>
# resolve nothing if dirs are disjoint; if a conflict appears, the
# workstream violated its directory boundary — investigate, don't force
git commit -m "<type>(<scope>): <one-line summary of the whole workstream> (#parity-<id>)"
git branch -D parity/<id>-<slug>      # delete the merged branch
```

- `--squash` collapses every WIP commit into **one** commit and creates
  **no merge commit**, so `main` stays linear.
- One squashed commit per workstream → 0a, 0b, 0c + A–H = **11 commits**;
  fold 0a/0b/0c into a single `chore(parity): phase-0 foundations`
  commit if you want to land in the 8–10 range.
- Re-run the full `npm test` gate on `main` after each squash-merge
  before doing the next, so a regression is caught at the commit that
  introduced it.
- After all merges: `git log --oneline` on `main` shows a clean linear
  block of parity commits and nothing else.

### Conflict / drift guard

Disjoint directory ownership means squash-merges should apply cleanly.
A merge conflict is a **signal that an agent edited outside its lane** —
do not `-f` past it; read the conflicting file, find which workstream
overstepped, and reconcile (usually: revert the stray edit, re-dispatch
that item as a cross-cutting change). `package.json` is the one shared
file — additive-only edits keep its conflicts to trivial
adjacent-line additions.

---

## How to dispatch

- **Phase 0 (serial, blocking)** runs first — 0a, 0b, 0c are
  prerequisites for several Wave-1 workstreams. Run them one at a time
  (or in one agent) and let them land before Wave 1.
- **Wave 1 (parallel)** — A–H over disjoint directories. Dispatch in a
  single message with multiple `Agent` tool calls so they run
  concurrently. Dependencies (must land first):
  - A needs **0b** (isActive on IChangelist)
  - C needs **0a** + **0c** (incoming/outgoing + keymap de-drift)
  - D needs **0a**
  - G needs **0a**
  - B, E, F, H — standalone, no Phase-0 dep
- Each agent edits only its own directories. `package.json` edits are
  **additive only** (append commands/menus/keybindings; never reorder
  or rewrite existing entries) so parallel agents don't collide.
- Suggested `subagent_type`: `AtrAICapabilities-all:ats-dev` (or
  `general-purpose` if that registry isn't desired). Use
  `isolation: "worktree"` only if two agents must touch the same file —
  by design they shouldn't.

---

## TEMPLATE — copy below this line

```
You are implementing ONE workstream of the IntelliG git4idea-parity
project. IntelliG is a VS Code extension at
/Users/chnmka/Documents/Projects/intellig-main porting IntelliJ's
git4idea Git workflows. Scope is pure-Git parity; GitHub/GitLab
integration is OUT of scope.

## Your workstream: <ID — e.g. "A — Commit / Changelists">

## Authoritative context (read first, in order)
1. docs/parity/full-parity-audit-2026-06-15.md — find the section for
   workstream <ID>. That is your spec: current status, what's missing
   (with file:line refs), and what to add.
2. docs/adr/ADR-010-visual-parity-discipline.md — the 4-layer parity
   discipline you must follow (snapshot tests + reference docs).
3. Any per-feature parity doc your section cross-references
   (e.g. git-log-graph.md, repo-states.md, changed-files-tree.md,
   accessibility.md).

## Reference codebase (read-only, for behavioural parity)
The git4idea source is cloned at
/Users/chnmka/Documents/Projects/intellij-community (sparse checkout).
Your section cites specific reference files — read them to match
behaviour, but do NOT copy code; reimplement idiomatically in TS.

## Directories you OWN (edit only these)
<list the src/ subdirs for this workstream — e.g. src/changelists/,
 src/commits/, the matching src/test/ trees>

## Hard constraints
- package.json edits are ADDITIVE ONLY — append new commands / menus /
  keybindings; never reorder, rename, or delete existing entries.
- Do not edit files outside your owned directories. If you find a
  cross-cutting change is needed, STOP and report it instead.
- Match the surrounding code's style, naming, and idiom.
- KeymapService and package.json: package.json is the source of truth.

## Git workflow (you commit to a branch; you do NOT merge)
- You are working on the branch `parity/<id>-<slug>`, forked from the
  current `main` tip. Stay on it.
- Commit your work with `git add` + `git commit` using
  Conventional-Commit messages. WIP / checkpoint commits are fine —
  they will be squashed when the orchestrator merges.
- FORBIDDEN: `git push`, `git checkout main`, `git merge`,
  `git rebase`, `git reset --hard`, and any force-push. You only ever
  add commits to your own branch.
- Leave the branch green (lint + compile + tests pass) at your final
  commit. Report the branch name and final commit SHA back.

## Prerequisites (must already be landed)
<Phase-0 deps for this workstream, or "none">

## Definition of done
1. The "what's missing" list for <ID> in the audit is fully addressed,
   each item traceable to a code change.
2. New behaviour is covered by tests in the matching src/test/ tree,
   following ADR-010 (unit + property + snapshot where the audit calls
   for visual parity).
3. `npm run lint -- --max-warnings 0` passes.
4. `npm run compile` passes.
5. `npm run test:unit` and `npm run test:property` pass (run the
   subset for your files if the full suite is slow, but the full suite
   must stay green).
6. If you added a visual surface, add/extend a parity reference doc
   under docs/parity/ per ADR-010 Layer 3, and pin it with a snapshot.

## Report back (your final message = structured result)
Return:
- workstream id
- branch name + final commit SHA (the orchestrator squash-merges this)
- files changed (path + one-line what)
- audit items addressed vs. deferred (with reason)
- test commands run + pass/fail
- any cross-cutting change you had to defer (for the orchestrator)
- follow-ups / risks
```

---

## Per-workstream quick-fill table

Fill the template's `<…>` slots from this table (directories are the
disjoint ownership boundaries; confirm against the audit before
dispatch).

| ID | Workstream | Owned dirs (edit only these) | Phase-0 dep |
|----|-----------|------------------------------|-------------|
| 0a | Incoming/Outgoing manager | `src/git-core/ops/` (+ `IGitService`), tests | — |
| 0b | `isActive` on changelist | `src/changelists/interfaces/`, `src/changelists/`, tests | — |
| 0c | KeymapService de-drift | `src/ui-shell/` (KeymapService), generated from `package.json` | — |
| A | Commit / Changelists | `src/commits/`, `src/changelists/`, tests | 0b |
| B | Merge view (native editor) | `src/conflicts/`, merge-editor glue, tests | — |
| C | Shell / Menus / Sync | `src/sync/`, `src/ui-shell/`, `src/registration/`, tests | 0a, 0c |
| D | Branches / Tags | `src/branches/`, tests | 0a |
| E | Shelf / Stash / Patches | `src/shelf/`, `src/patches/`, tests | — |
| F | Blame / History / Diff | `src/blame/`, history views, tests | — |
| G | Log / Graph | `src/git-core/gitToolWindow/`, `commitGraph.ts`, tests | 0a |
| H | Rebase / Cherry / Revert | `src/rebase/`, tests | — |

> Verify each row's directory list against the workstream's own section
> in the audit before dispatch — the audit is authoritative if they
> diverge.

---

_Created: 2026-06-15. Pairs with full-parity-audit-2026-06-15.md._

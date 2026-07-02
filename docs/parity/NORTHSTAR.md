# IntelliG — north star

_The product vision and what matters next. The detailed remaining-work list lives in
**[`BACKLOG.md`](./BACKLOG.md)**. Last updated 2026-07-01 (main @ `0570f68`)._

## The vision

**The best native-feeling Git UI for VS Code users who miss IntelliJ's.**

That sentence sets the bar and, just as importantly, the ceiling:

- **IntelliJ `git4idea` is the inspiration, not a spec to match pixel-for-pixel.** We borrow its
  best ideas — changelists, the branch popup, the shelf, the interactive-rebase planner, the
  commit-graph log — because they make daily Git work better. We do **not** owe it feature-for-
  feature or Swing-for-webview fidelity. When git4idea has something that wouldn't improve the
  target user's day, we skip it.
- **Native VS Code idioms are a feature, not a compromise.** The 3-way merge is VS Code's own
  editor; commit/staging routes through the native SCM API; dialogs lean on QuickPick where that
  feels right. A user who lives in VS Code should feel at home, not like they're running a
  transplanted IDE.
- **Reliability beats coverage.** The target user is switching from a tool they trusted. One git
  operation that silently does the wrong thing costs more than ten missing features. The bar is
  "I trust it with my repo," not "it has every menu item IntelliJ has."

The measure of success is not a parity percentage. It's whether a former IntelliJ user opens
VS Code, reaches for IntelliG, and stops missing the old tool for the things they do every day:
commit, branch, review the log, resolve a conflict, stash, push.

## Where we are

The hard architecture is built and, after the R3/R4 audits (June–July 2026), the correctness and
security floor is solid — including four model-level redesigns (a shared restore-to-HEAD writer, a
save/run/restore bracket, one per-repo index lock, one patch builder) and fixes for real data-loss
and old-git-version bugs. Feature coverage against git4idea is high across the board. Reset and the
interactive-rebase planner already go beyond it.

The honest weak spot is **not features — it's real-world validation.** The suite is green, but the
extension is under-dogfooded, and the R4 audit's worst findings (wrong file staged on resolve,
data loss on drop-selected, fetch broken on older git) were exactly the class a green unit suite
sails past.

## What matters next

1. **Reliability — a structured F5 dogfood sweep on real repositories.** This is the highest-value
   work by a wide margin: drive the daily flows (commit, dirty-tree branch switch, conflict
   resolution, stash, log/graph on a large history, fetch/pull/update) on a range of real repos
   (a monorepo, submodules/worktrees, an older git, a multi-root workspace) while watching the
   structured logs. This is where the next real bugs are, and it's the gate to a public release.

2. **A short, bounded set of feature gaps that genuinely improve the daily experience** — the
   Configure-Remotes front door, worktree teardown, un-resolve a file, the rejected-push retry
   loop, and a few before-commit checks. These are in **[`BACKLOG.md`](./BACKLOG.md)**, chosen by
   "does this make the target user's day better," not "git4idea has it."

3. **Visual fidelity stays deliberately capped.** Chasing IntelliJ's Swing look in a webview is a
   losing game and off-vision — native VS Code rendering *is* the goal. We invest here only where a
   surface is genuinely worse to use (e.g. a dialog paradigm), never to "look more like IntelliJ."

## Where the record lives (so this doc doesn't rot)

- **What landed** — `git log`. No hand-maintained landing table; it goes stale instantly.
- **What's left** — [`BACKLOG.md`](./BACKLOG.md).
- **What was audited** — `workspace-notes/audit/` (R3) and `workspace-notes/audit/r4/` (R4, with
  `DESIGN-ASSESSMENT.md` + `99-REPORT.md`).
- **Behavior contracts** — the property + snapshot tests (and ADR-013 for the commit-graph data
  model), not prose.

## Standing constraints

- **3-way merge stays the VS Code native editor.** Don't reintroduce a hand-rolled merge UI.
- **`package.json` `contributes`** is the widely-shared file — additive-only edits, no reordering.
- **Local-only workflow.** Work lands via squash-merge to local `main`; the user reviews and
  pushes. No PRs, no direct pushes from tooling.

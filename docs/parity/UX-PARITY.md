# IntelliG ↔ IntelliJ git4idea — UI/UX LAYOUT parity

_UI/UX layout fidelity is a parity goal in its own right — menu structure, action order/grouping,
labels, ellipsis convention, icons, tool-window tabs, dialog structure — not just feature coverage.
This tracks the **layout** gaps; feature gaps live in [`NORTHSTAR.md`](./NORTHSTAR.md), landing log in
[`STATUS.md`](./STATUS.md). Authoritative reference = git4idea action XML
`~/Documents/workspace/intellij-community/plugins/git4idea/backend/resources/intellij.vcs.git.backend.xml`
(+ `GitBranchPopupActions.java`). First mapped 2026-06-18 (ux-analyst pass)._

## Surface heatmap

| Surface | Layout parity | Biggest gap |
|---|---|---|
| Log / commit context menu | 🟡 ~70% | webview vs native-tree menus diverge; Reword label; by-subject fixup/squash (webview Reset-to-head landed) |
| Branch popup (QuickPick) | 🟡 ~65% | Rename/Delete not last; tracked-branch submenu missing; missing Diff-with-Local / Update-Selected / New-Worktree |
| Branch tree context menu | 🟢 ~90% | already well-grouped (1_branchOps/2_compare/3_integrate/4_sync/5_manage) |
| Tool-window tabs | 🟢 ~85% | no Stash / Working-Trees tab; Incoming/Update-Info persistent vs transient |
| Explorer / editor submenu | 🟡 ~70% | no "Commit File"; History mis-ordered; Annotate split out; "Compare with Branch" mislabeled |
| Command palette titles | 🟢 ~85% | redundant `Rebase:`/`Blame:` inner prefixes (ellipsis pass landed) |
| Toolbar / view-title | 🟡 ~75% | Fetch/Update/Refresh icon collisions ($(sync) ×2); branch widget not first |
| Major dialogs | 🟢 ~85% | present + close; field-level checkbox/label audit not yet done |

## Prioritized gap list

Status: ☐ open · ◐ in progress · ☑ landed. Ref = git4idea XML group/action or Java class.

| # | Surface | Gap | IntelliJ ref | IntelliG site | Size | Status |
|---|---|---|---|---|---|---|
| 1 | Log menu | Reset/Revert/Uncommit should LEAD the menu (currently buried ~item 10 / group `4_reset`) | `Git.Log.ContextMenu` (Reset.In.Log→Revert.In.Log→Uncommit first) | `htmlBuilders.ts:228`; pkg.json logCommit `4_reset` | M | ☑ 64c5a20 (webview; native tree still in #2) |
| 2 | Log menu | Webview graph menu and native tree menu diverge (different labels/actions/order); pick one source of truth | single `Git.Log.ContextMenu` | `htmlBuilders.ts:217-244` vs pkg.json `view/item/context` logCommit | M/L | ☐ |
| 3 | Log menu | "Edit Commit Message" → "Reword…" + add to tree | `Git.Reword.Commit` (`GitRewordAction`) | `htmlBuilders.ts:227` | S | ☐ (reset confirm verified present; reword rename NOT yet done) |
| 4 | Branch popup | QuickPick reorders/flattens; Rename/Delete should be LAST; missing Diff-with-Local, Update-Selected, Pull-into-current, New-Worktree, Push-Tags | `Git.Branch.Backend` (+ `.Checkout`) | `BranchPopup.ts ~721-792` | M | ☐ |
| 5 | Branch popup | Tracked-branch submenu missing (set-upstream/edit-tracked sub-popup) | `Git.Branch.Tracked` (`GitTrackedBranchActionGroup`, popup) | absent | M | ☐ |
| 6 | Explorer submenu | No "Commit File"; History should trail (not lead); Annotate grouped with diff/compare; "Compare with Revision…" → "Compare with Branch" | `Git.FileActions` | pkg.json `explorerSubmenu` | S/M | ☐ |
| 7 | Palette / webview | Ellipsis inconsistency — dialog/editor-opening actions need `…`, immediate ones don't | git4idea ellipsis convention | `htmlBuilders.ts:227-229`; pkg.json titles | S | ☑ 64c5a20 (pkg.json titles; webview labels still pending) |
| 8 | Palette | Drop redundant inner `Rebase:`/`Blame:` prefixes (render as "IntelliG: Rebase: …") | plain action text | pkg.json commands | S | ☐ |
| 9 | Toolbar | Fetch & Update Project both `$(sync)` (+Refresh `$(refresh)`) → 3 spinning glyphs; give Fetch a distinct icon; move branch widget to navigation@1 | `AllIcons.Vcs.Fetch`; `Git.ShowBranches` first | pkg.json `view/title` | S | ☐ |
| 10 | Log menu | Add by-subject Fixup/Squash (`Git.Fixup/Squash.To.Commit`); surface New-Branch/New-Tag-from-commit in the webview graph menu | `Git.Log.ContextMenu` | `htmlBuilders.ts:234-235` | M | ☐ |
| — | Branch | Pull-into-current (rebase/merge) on LOCAL tracked branches, not just remote | `GitPullBranchAction$WithRebase/$WithMerge` | pkg.json `4_pull` (remoteBranch only) | S/M | ☐ |
| — | Tool window | Consider a Stash tab + Working-Trees tab; make Incoming/Update-Info transient | `git.enable.stash.toolwindow`, `Git.Show.WorkingTrees` | `tabRouter.ts:25` | M | ☐ |
| — | Dialogs | Field-level checkbox/label/order audit per dialog (rebase/merge/push/pull/reset/new-branch/rollback) — own task | per-dialog git4idea classes | `src/rebase`,`src/sync`,etc | M | ☐ |

## Execution order
1. **Quick wins (package.json-mostly):** #8, #9, #7, #6-partial — least risk, no behavior change.
2. **Structural wave:** #1, #2 (unify the two log menus), #3, #4, #5, #10.
3. **Deferred:** Stash/Working-Trees tabs; per-dialog field audit.

**Landed 2026-06-18 (64c5a20):** #1 webview log-menu reset-to-head (test-locked: `resetToHere` before
edit/drop/merge); #7 ellipsis pass on package.json dialog-opening command titles (Commit…/Push…/Pull…);
reset-dialog destructive confirm verified already present (`ResetDialog._confirmDestructive`, no change
needed). **Still open (next, structural wave):** #2 unify webview vs native-tree log menus; #3 "Reword…"
rename + tree entry; #4 branch QuickPick reorder; #5 tracked-branch submenu; #6 explorer submenu;
#8 drop `Rebase:`/`Blame:` inner prefixes (quick win); #9 toolbar icons; #10 by-subject fixup/squash.

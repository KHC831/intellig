# IntelliG — remaining work

_The actionable backlog behind **[`NORTHSTAR.md`](./NORTHSTAR.md)**. Every item is weighed by the
vision — "does this make the target user's day better?" — not by git4idea feature coverage.
Verified against source 2026-07-01 (main @ `0570f68`). git4idea refs are inspiration/comparison,
not a spec to match._

## Feature gaps worth closing

These are the bounded gaps that genuinely improve daily use. (git4idea has all of them; that's a
data point, not the reason to build them.)

| Gap | Why it matters | IntelliG state | Size |
|---|---|---|---|
| **Configure Remotes UI** — add/rename/remove/set-url a remote. | Managing remotes today means dropping to the terminal. Backend `RemoteOps.{addRemote,removeRemote,setRemoteUrl,renameRemote}` is built + unit-locked; only the front door (command/menu/dialog) is missing. | backend only, no caller | S/M |
| **Worktree teardown** — remove / prune / refresh. | Create + open landed, so a user can make worktrees but not clean them up — a dead end. | `WorktreeOps.ts` (`list`+`add` only) | S |
| **Un-resolve a file** (`git checkout --merge -- <file>`) | After a mis-resolution there's no way to send a file back to conflicted and redo it — a real "oops" recovery gap. | not present | S |
| **Rejected-push retry loop** | On a non-ff rejection we show a per-row "Pull and Retry" but don't loop or offer a Merge/Rebase choice; the user has to drive it manually. | `PushDialog.ts` | M |
| **Before-commit checks: CRLF / large-file / bad-filename** | Catch a bad commit before it lands. The framework + 4 checks (identity, unresolved-merge incl. AA/DD, detached-HEAD, status-read) are ported; these three aren't. | `CheckinHandlers.ts` | S each |

## Smaller residuals (polish)

None are wrong-git-behavior or security. Pick up opportunistically.

- **Shelf / Stash:** stash apply-time `--index` UI toggle (backend param exists); file-subset
  stash (`stash push -- <paths>`); stash per-file changes browser.
- **Rebase:** "edit as text" fallback for `label`/`reset`/`merge`/`exec` todo lines — we preserve
  them but can't hand-edit (matters for stacked-branch users); interactive-editor richness (inline
  diff preview, P/R/E/S/F/D mnemonics).
- **Log:** branch-filter union picker; known-committers dropdown; details-panel file context menu;
  in-page Ctrl+F; filter persistence across sessions.
- **Branches:** branch-tree multi-select; branch-popup New-Worktree / Push-Tags items;
  Pull-into-current on local (not just remote) tracked branches.
- **History:** single-rev "Show Diff" (rev vs parent) in HistoryTab; sortable columns /
  tree-as-graph file-history panel.

## Deliberately not doing

- **Merged-branch cleanup** (`Git.Cleanup.Branches`) — git4idea marks it `internal="true"`; not a
  user-facing feature. The orphaned backend was removed.
- **Unshallow, Open-Exclude-File, Add-Commit-To-Remote-Branch** — low-frequency; off the daily path.
- **Pixel-matching IntelliJ's Swing UI** — off-vision. See below.

## Visual fidelity — accepted non-matches (not gaps)

Per the north star, native VS Code rendering is the goal, so these are **intentional**, not a
backlog to burn down:

- **3-way merge** = VS Code's native editor (`git.openMergeEditor`); `MergeView` is a thin adapter.
- **Blame gutter** = a single inline decoration with a background recency tint, not IntelliJ's
  multi-column Swing gutter. (Options/columns are feature-complete.)
- **Log panel** = webview flex-rows, not a `JTable`; details on the right, not the bottom.
- **Dialogs** = QuickPick wizards / read-only-ref paradigm, not IntelliJ's modal forms. This is the
  one visual axis with genuine room to move **if a surface is worse to use** — not to look more
  like IntelliJ.

The F5 dogfood sweep (NORTHSTAR priority 1) is the open item that confirms all of the above behave
well in real use.

## Command spine adoption (structural hardening, not parity)

`src/commands/registration/commandSpine.ts` centralizes the services guard,
the (clickedUri, selectedUris[]) selection contract, resolveRepo (with
cold-start discovery and raw-uri hints), path derivation, failure toasts, and
refresh-on-success. ALL EIGHT registration modules are migrated; the remaining
hand-rolled registrations carry justified `spine-exempt:` comments, enforced
by check:spine-registration. Possible follow-up: extend the spine's scopes to
the class-based context-menu surfaces (BranchContextMenuCommands,
CommitContextMenuCommands), which keep their own tree-item/webview-payload
dispatch today.

# ADR-014: UI primitive selection — webview only for the graph, native primitives elsewhere

Status: Accepted (2026-06-18)

## Context

IntelliG targets parity with IntelliJ's `git4idea`, whose UI is rich in
context menus, popups, and modal dialogs. As parity work has progressed,
a recurring friction has surfaced: several surfaces were built as
hand-rolled HTML inside the Git Tool Window **webview**, and that choice
makes some IntelliJ interactions awkward or impossible to reproduce
faithfully.

The root constraint is structural, not incidental:

- A VS Code webview is a sandboxed iframe. The extension host **cannot
  attach native menus, QuickPicks, or modal dialogs to anything rendered
  inside it.** Any menu or popup that is visually bound to webview content
  (for example, the right-click menu on a commit row in the graph) must be
  hand-rolled in HTML and CSS, with its own keyboard handling, theming,
  and state synchronization across the host/webview message seam.
- At the same time, the **commit graph itself requires a webview**: no
  native VS Code widget can draw the branching/merging DAG. A native
  `TreeView` renders an icon, a label, and a description per row and
  nothing more.

So "move IntelliG off webviews" is not a clean win — it would mean giving
up the commit graph, which is the surface users most associate with the
IntelliJ experience. But "build everything inside the webview" is the
status quo that produced the friction: it forces every menu, popup, and
dialog into hand-rolled HTML when most of them map cleanly onto native VS
Code primitives.

IntelliG is in fact already a hybrid — the branch popup uses a QuickPick,
the branch and tag lists are a native `TreeView` with package-manifest
context menus, and a `SourceControl` provider exists. The drift is that a
few surfaces (notably the log/commit menu and commit flows) were routed
into the webview when a native primitive would have been more faithful and
cheaper to maintain. This ADR records the routing rule so the choice stops
being made ad hoc per feature.

## Decision

### 1. Reserve the webview for surfaces that require custom rendering

The webview is used only where the platform offers no primitive that can
render the surface — in practice, the **commit graph** (the DAG lanes,
edges, and per-row decorations). A surface qualifies for a webview only
when custom pixel-level rendering is essential; reaching for a webview for
layout convenience alone does not.

### 2. Route everything else to a native VS Code primitive

For menus, popups, dialogs, lists, and commit/staging flows, choose the
native primitive whose model matches the IntelliJ surface:

| IntelliJ surface                                      | VS Code primitive                                                                           | Notes                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Commit graph / log                                    | Webview                                                                                     | Only option; the DAG cannot be a `TreeView`.                                    |
| Branch popup, VCS-operations popup, action choosers   | `QuickPick`                                                                                 | Maps directly to IntelliJ list popups; supports detail, separators, multi-step. |
| Branch / tag / changelist lists + their context menus | `TreeView` + `contributes.menus` `view/item/context`                                        | Native right-click menus, gated by `contextValue`.                              |
| Staging, commit, and file-scoped commit               | SCM API (`SourceControl`, resource groups, commit input)                                    | The native home for "Commit File"; mirrors the built-in Git extension.          |
| Confirmations and simple field dialogs                | Native modal (`showInformationMessage` with buttons) or a `QuickPick` / `InputBox` sequence | Faithful enough for confirm/choose/enter-value; no webview needed.              |

The table is append-only: new surfaces add a row naming their primitive
and rationale.

### 3. The commit-row context menu is the one inherent webview exception

The right-click menu on a commit row is visually bound to a webview row,
so it cannot be a native menu without giving up the graph. It therefore
stays hand-rolled HTML, and its state synchronization with the host
follows ADR-009 (host computes, webview applies). This is the single
sanctioned hand-rolled menu; it exists because of the graph, not in spite
of a native alternative.

### 4. Default for new parity work: native first

When a new parity item is picked up, choose the native primitive from the
table before considering webview HTML. A webview surface is justified only
by a custom-rendering need that no native primitive can meet, and that
justification is stated in the slice that introduces it.

### 5. Migration is selective, not wholesale

Existing webview surfaces are not rewritten en masse. A webview-bolted
surface is migrated to a native primitive only when the webview is causing
concrete parity or UX friction (an interaction that cannot be reproduced
faithfully, or a maintenance cost that keeps recurring). Working, tested
webview surfaces that meet their parity bar are left alone.

## Consequences

### Positive

- Popups, menus, and dialogs that route to native primitives get correct
  theming, keyboard handling, accessibility, and platform behavior for
  free, instead of being re-implemented in HTML.
- The hand-rolled-HTML surface area shrinks to the one place it is
  inherent (the graph and its row menu), which is the hardest surface to
  test and the easiest to let drift.
- New parity items have a decision already made: consult the routing
  table, pick the primitive, build. The webview-vs-native question stops
  recurring per feature.

### Negative

- IntelliG carries two UI idioms (webview HTML and native primitives) and
  the host/webview message seam between them. This is the cost of keeping
  the graph; it is bounded because the webview surface is now explicitly
  limited.
- Some IntelliJ dialogs are richer than a `QuickPick`/`InputBox` sequence
  can express one-to-one. Where that gap matters, the slice records the
  fidelity trade-off rather than reaching for a webview by reflex.

### Neutral

- The decision changes routing for new and friction-bearing surfaces; it
  does not, on its own, move any existing working surface. Render-only
  webview tabs (console, incoming, update-info, history) are unaffected —
  they have no native-menu need.

## Alternatives considered

### Build everything in the webview (status quo)

Maximum visual control and a single rendering model. Rejected: it forces
every menu, popup, and dialog into hand-rolled HTML, which cannot host
native interactions and is the source of the recurring friction this ADR
addresses.

### Drop the webview and render the log as a native TreeView

A fully native UI with native menus everywhere. Rejected: a `TreeView`
cannot draw the commit-graph DAG, so this discards the surface that most
defines the IntelliJ-parity experience.

### Leave the choice ad hoc per feature

Decide webview-vs-native case by case with no written rule. Rejected: that
is how the drift happened. The recurring cost of re-deciding (and
re-litigating) outweighs the cost of one routing table.

## Cross-references

- ADR-009: Webview state ownership — governs the one sanctioned hand-rolled
  menu (the commit-row context menu) and the host/webview message seam.
- ADR-010: Visual parity discipline — the parity reference and snapshot
  tests that hold each surface to its IntelliJ target, regardless of which
  primitive renders it.

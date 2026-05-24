# Git Log Graph — IntelliJ parity reference

Status: Living reference (Wave D, 2026-05-24)

This document is the **visual-truth specification** for IntelliG's
Git tool window log graph. Wave D introduced two discipline layers
(snapshot tests + UX-review checkpoint, see ADR-010); both verify
against THIS file. When IntelliJ's behavior changes — or when a
parity gap is identified — update this file first, then walk the
implementation forward.

The reference behavior is IntelliJ IDEA's "Git" tool window → "Log"
tab. The UI we ship deviates only where VS Code's webview surface
forces a different pixel-level decision; every such deviation is
called out inline.

---

## §1 Lane structure

A "lane" is a vertical track in the graph. Each commit row's commit
icon sits in exactly one lane (`graphColumn`); each row also has zero
or more graph lines connecting that icon to its parents (which sit in
their own lanes on later rows).

### §1.1 Linear history

A single chain of commits all sits in **lane 0**. There are no
branches and no merges; every line is a vertical segment in lane 0.

```
  * c5      lane 0
  * c4      lane 0
  * c3      lane 0
  * c2      lane 0
  * c1      lane 0   (root)
```

**Implementation invariant**: `getMaxGraphColumn(result)` for any
linear history must return `0`. The `snap-1` snapshot fixture and the
property test in `laneAlgorithmDivergent.property.test.ts` both pin
this.

### §1.2 Divergent branches (Wave D / D1 — Gap 1)

When two or more branches share a common ancestor that is older than
any of the loaded commits, the **first-seen child** (in newest-first
display order) inherits the ancestor's eventual lane; **every other
child** claims a distinct new lane.

```
  * tipA       lane 0   ← first-seen child of `base`, lane 0
  * tipB       lane 1   ← second child, NEW lane
  * base       lane 0   ← inherits first-seen child's lane
```

This is the bug Wave D fixed. The pre-Wave-D single-pass algorithm
collapsed `tipB` onto lane 0 because parent-lane assignment was
unconditional. The two-pass children-map algorithm in
`buildChildrenMap` + the rewritten body of `generateCommitGraph`
guarantees that divergent forks light up in distinct lanes.

**Implementation invariant** (children-map rule): for each parent
`p`, only the commit `c` such that `childrenMap.get(p)?.[0] === c`
AND `c.parents[0] === p` inherits `c`'s lane; every other child claims
a new lane. Pinned by `snap-2` and the property test.

### §1.3 Merge commits

A merge commit has ≥2 parents. The first parent (`parents[0]`)
inherits the merge commit's lane (straight-down "main line"). Every
subsequent parent claims its own lane and is reached via a cubic
bezier curve drawn from the merge icon down to the destination
column.

```
  * merge          lane 0    parents = [main2, feat]
  |\
  | * feat         lane 1    parent  = base   (claimed lane 1)
  * | main2        lane 0    parent  = base   (inherits merge's 0)
  |/
  * base           lane ?    settles on first-seen child's lane
```

**Implementation invariant**: `node.graphLines.length === parents.length`
for any non-root commit. Pinned by `snap-4`.

#### §1.3.1 Octopus merges

A merge with ≥3 parents (octopus) follows the same rule: parent[0]
inherits, parents[1..N] each claim a new lane.

### §1.4 Lane allocation cap

The renderer (`graphRenderer.ts:isValidLane`) refuses to render
lanes ≥ 1000. Property test asserts `getMaxGraphColumn(result) ≤ K + 5`
where K is the number of distinct branch tips, so the cap is never
approached in practice.

---

## §2 Branch chips

Branch names are rendered as **chips** to the right of the commit
icon in the same row.

### §2.1 Local vs remote classification

`classifyBranchName` decides:

- contains `/` → **remote** (`branch-label-remote` CSS class)
- otherwise → **local** (`branch-label-local`)

Local chips render with the green background pair; remote with the
blue background pair.

### §2.2 Multiple branches at the same commit

When several branches point at the same commit, all chips render
side-by-side in `branchMap.get(hash)` order. The HEAD branch (when
its commit is loaded) gets the additional `head-label` class.

### §2.3 `data-branch-name` attribute

Every chip carries `data-branch-name="<escaped-name>"` so the
inline-script's `updateBranchFocus` partial-update handler can find
chips without a full DOM rebuild. The attribute value goes through
`_escapeHtml` for the same reason chip text does — preventing
reflective injection.

---

## §3 Branch focus (Wave D / D2 + D3)

A user can **focus** the graph on a single branch. While focus is
active, that branch's chip is outlined and bold, the graph scrolls to
the branch's tip, every commit on the path from the tip back to the
merge-base with HEAD is brightened, and every other commit is dimmed.

### §3.1 Trigger

The "Focus on Graph" inline icon (eye) on a branch tree-view item.
Bound to the `intellig.branch.focusOnGraph` command, which routes
through `GitToolWindowProvider.setFocusedBranch(name)`.

> **Why an inline icon and not a single-click?** The pre-Wave-D
> single-click already scrolls the graph to a branch tip
> (`navigateToBranch`). Adding focus to that gesture would surprise
> users who only wanted scroll. Wave D added a distinct visual
> affordance instead.

### §3.2 Visual treatment

- **Focused chip**: `branch-label-focused` class — `outline: 1px
  solid var(--vscode-focusBorder, currentColor)`, `outline-offset:
  1px`, `font-weight: 600`. Wave D R1 / Senior L-2 swapped raw
  `currentColor` for the theme-aware `--vscode-focusBorder` so the
  outline reads correctly under high-contrast themes; `currentColor`
  is the fallback when the variable is unavailable.
- **On-path commits** (when focus active): SVG strokes at
  `stroke-width × 1.5`, opacity `1.0`.
- **Off-path commits** (when focus active): every SVG element at
  opacity `0.6`. Stroke width unchanged.
- **No focus**: every commit at baseline opacity (`1.0`) and
  baseline stroke. The graph is visually identical to its
  pre-Wave-D appearance.

> **Implementation note (Wave D R1 / TLD-D-1)**: visual treatment is
> applied via SVG `opacity` and `stroke-width` attributes inside
> `renderGraphSvg`, NOT via CSS classes keyed on
> `[data-on-focused-path]`. This deviates from the plan-v3 sketch
> which proposed a CSS-class-based approach; it lands cheaper for
> Wave D's scope but couples the styling to the SVG-emission code.
> Future highlight features (e.g. search-match highlight) that need
> to compose with focus should consider adding a styling-layer
> indirection — emit a `data-focus-state="on|off"` attribute and
> drive the visual via CSS. The renderer-stage snapshots in
> `commitGraphSnapshots.test.ts` (snap-6a/6b/6c) pin the current
> emission shape so any such migration shows up as a deliberate
> snapshot diff.

### §3.3 Path-to-merge-base BFS

`setFocusedBranch` resolves the branch tip hash, calls
`gitService.getMergeBase('HEAD', branchName)`, then BFS-walks the
parent edges of `commitNodes` from the tip toward the merge-base.
The walk caps at `commitNodes.length` to defend against corrupt
parent chains (Trap T-1).

When `getMergeBase` returns `undefined` (no common ancestor or git
error — Trap T-8), the BFS still walks the loaded ancestry to give
*some* visual; the chip outline (D2) survives regardless.

### §3.4 Focus survives a refresh — until the branch is gone

`updateLogState` mirrors the `anchorHash` lifecycle: if the new
branch list (built from `branchMap`'s values) still contains the
focused branch name, focus + path are recomputed against the new
nodes. If the branch is gone (force-push, rename, repo switch),
both are cleared.

### §3.5 Toggle semantics (Wave D R1 / Senior M-1)

Clicking the eye icon on the **same** branch a second time clears
focus. The command handler in `extension.ts` reads the current
focus name via `getFocusedBranchName()` and computes:

```ts
const next = currentName === branchName ? null : branchName;
await provider.setFocusedBranch(next);
```

This is the only built-in way to clear focus. Switching branches by
clicking a different eye icon moves focus to the new branch (no
intermediate clear). Repository switches and refreshes that drop the
focused branch from the live branch list also clear focus
implicitly (see §3.4).

### §3.6 Webview wire surface

| Surface | Direction | Message |
|---|---|---|
| Focus state | host → webview | `{ type: 'updateBranchFocus', focusedBranchName, focusedHash }` |
| Focus request | webview → host | `{ type: 'focusBranchOnGraph', branchName }` |

The render-time `_getBranchLabelsHtml` is the source of truth for
the focused chip class. The partial-update message exists so a
focus change without a full re-render still updates the chip outline
(Trap T-7).

> **Wave D R1 / Senior M-3**: an earlier version of the wire
> envelope also carried `focusedPathHashes: string[]`. The JS
> handler never read it (the SVG dim/brighten lands during the full
> re-render that follows the post; the path data is host-cached in
> `_focusedPathHashes`). Dropping it slims the payload and makes the
> intent explicit.

> **Wave D R1 / Senior H-2 — security**: webview-posted
> `branchName` strings are validated against the host-side branch
> list before any processing. A hostile or desynced webview cannot
> inject arbitrary refs (e.g. `--upload-pack=evil`) into
> `setFocusedBranch`. Defense in depth: `getMergeBase` also passes
> `--end-of-options` so even a hypothetical bypass of the
> host-side filter cannot reach git as an option.

---

## §4 Cross-references

- **ADR-007** — structural guards as complementary tool. Wave D adds
  three guards for the focus surface: `focusBranchOnGraph` case in
  the message handler, `setFocusedBranch` on the provider,
  `intellig.branch.focusOnGraph` declared in package.json.
- **ADR-009** — webview state ownership. `updateBranchFocus` is the
  Wave D addition to the surface table; `setFocusedBranch` follows
  the §3 fire-before-post ordering (`onDidChangeState.fire()` →
  `_postBranchFocusUpdate()` → `_updateWebview()`).
- **ADR-010** — visual parity discipline. The discipline that
  produced this document; required reading for future parity waves.

## §5 Future work (out of scope for Wave D / Wave D R1)

- §3.7: hover-then-modifier preview of focus before the user clicks
  the inline icon (IntelliJ shows a translucent preview on
  shift-hover; we do not).
- §1.5: lane reuse after a branch terminates. The current algorithm
  preserves the lane "alive" forever in the rendered window because
  the cap mechanism kicks in early. IntelliJ reuses lanes once they
  go out of view.

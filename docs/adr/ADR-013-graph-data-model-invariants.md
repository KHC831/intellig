# ADR-013: Commit graph data model and lane-algorithm invariants

Status: Accepted (2026-06-08)

## Context

The Git Tool Window's Log / Graph panel is rendered from a derived
data model produced by `generateCommitGraph` in
`src/git-core/commitGraph.ts`. The function turns a newest-first
array of `ICommit` objects (plus an optional `branchMap`, `tagMap`,
focused-branch hash set, and HEAD branch name) into an array of
`ICommitNode` rows, each carrying:

- a `graphColumn: number` — the lane the commit sits in;
- a `graphLines: IGraphLine[]` — one entry per outgoing edge to a
  parent, carrying `{fromColumn, toColumn, color, type, style?}`;
- `branches`, `tags`, `onFocusedBranchPath` — passthrough metadata.

The renderer (`src/utils/graphRenderer.ts`) then produces SVG strokes
keyed off `graphColumn` for the node and `graphLines` for the edges.
This module is the **algorithm boundary** for the entire UX — every
visible artifact in the panel (color, bend, dash, dim) is downstream
of these field values.

Three classes of bugs have been paid for in production over the past
six weeks against this same code:

1. **Lane jumps on refresh** (`KNOWN-ISSUES.md` task #53 / T53
   "green-node-on-blue-line"). The pre-seeding pass that pins HEAD's
   branch tip onto lane 0 was missing. Lane indices were a pure
   function of input commit ordering: any reload that touched the
   topo sort caused a branch to land on a different column, and the
   "vertical stroke uses the source commit's lane color" invariant
   then put a green node on a blue line because the line was
   committed to its old column while the node moved.
2. **Phantom beziers into empty lanes** (T-stray-bezier). When a
   commit's parent was not in the loaded `--max-count` window, the
   algorithm called `allocateLane()` for the off-window parent and
   the renderer drew a hook into a column that had no row anywhere.
3. **Divergent-sibling collapse** (Wave D). Two children of the same
   un-loaded parent were given the same lane because the single-pass
   algorithm inherited the parent's lane unconditionally on the
   second child. The second child landed on top of the first; both
   chains collapsed to one stroke.

Each fix landed in `commitGraph.ts` as a focused change. None of
them was canonical — there was no single document a future
contributor could read to understand the contract the graph data
model honors. The implementation plan
(`docs/design/git-tool-window-implementation-plan.md`) lists spec 8.L1,
spec 8.L4, and spec 8.L9 as the load-bearing rules that flow through this
module; the spec (`docs/design/git-tool-window-spec.md` spec 8) names
each rule in isolation but does not knit them together with the
algorithm and renderer surfaces they constrain.

This ADR is that knitting. It records the decided shape of
`IGraphLine` and `ICommitNode`, the algorithm's contract for lane
assignment and edge emission, and pairs each invariant with the
test pin that locks it.

## Decision

### 1. The data model is `IGraphLine` + `ICommitNode` and is fixed

`IGraphLine` is the single typed surface every graph edge passes
through:

```ts
interface IGraphLine {
  fromColumn: number; // source lane (always === source node's graphColumn)
  toColumn: number; // destination lane (parent's lane, or === fromColumn for off-window stubs)
  color: string; // resolved through getColumnColor() at construction time
  type: 'commit' | 'merge' | 'branch';
  style?: GraphLineStyle; // 'solid' (default) | 'dashed' (off-window stub)
}
```

`ICommitNode` carries one `graphColumn: number` plus an array of
`IGraphLine` entries, the upstream `commit`, and the chip / tag /
focus-flag passthrough fields. The shape is FROZEN: any future
addition is append-only with sensible defaults so the renderer can
ignore unknown extensions, mirroring the ADR-001 pattern for
`IGitService`.

The `style?` field is intentionally optional. The renderer treats
`undefined` as `'solid'`. The opt-in shape lets older fixtures and
test snapshots not have to enumerate `style: 'solid'` everywhere; the
single value the renderer cares about is `style === 'dashed'` for the
off-window stub case, and the algorithm sets that field exactly when
the corresponding edge needs the dashed affordance (see spec 3 below).

### 2. Lane stability across reloads — spec 8 L1

Lane assignment for any commit is determined by:

1. **Pre-seeding pass.** When `branchMap` and `headBranchName` are
   both supplied, walk the branch tips in priority order — HEAD's
   branch first (claims lane 0), then locals alphabetically, then
   remotes alphabetically. For each tip whose commit is in the
   loaded window, `allocateLane()` and pin the result into
   `state.commitToLane`. Mark the lane active so subsequent
   allocations find a gap. A tip whose commit is already pinned
   (e.g. `main` and `origin/main` share a SHA) collapses onto the
   priority winner's lane — no double allocation.
2. **Main pass** consumes `commits[]` in newest-first order. Each
   row inherits its pre-claimed lane (set 1) or allocates a fresh
   lane via `findNextAvailableLane`. For each parent, the
   first-child + first-parent shape inherits straight down; any
   other shape allocates a new lane for the parent.

The two-step contract gives lane assignment two stability
guarantees:

- **Byte-identical reload.** Calling `generateCommitGraph` twice
  with the same `commits`, `branchMap`, `headBranchName` produces
  deeply-equal output. The `Map` iteration order in `branchMap` is
  collapsed by the priority sort, so a `Map` rebuilt with different
  insertion order yields the same lanes.
- **HEAD-ancestry promotion.** No matter how `commits[]` is ordered,
  HEAD's branch tip lands on lane 0 when its tip commit is in the
  window. Divergent siblings appearing earlier in display order
  cannot grab lane 0 because seeding ran before the main pass.

These guarantees are pinned by:

- `src/test/property/laneStabilityAcrossReload.property.test.ts`
  — three properties (same input ⇒ same output; iteration order
  is irrelevant; HEAD's branch wins lane 0 across random K /
  depth / head-pick).
- `src/test/property/headAncestryPromotion.property.test.ts` —
  divergent-sibling scenarios with both interleaved and
  branch-by-branch input orderings, plus a negative control that
  proves the property depends on the seeding pre-pass.
- `src/test/unit/utils/commitGraph.test.ts` "Phase 1a pins" suite
  — `seeds lane 0 from HEAD only — local + origin/main on same
SHA share lane 0 (spec 8 L1)` and `does NOT pre-seed non-HEAD
branch tips — second branch goes through main pass (spec 8 L1)`.
- `src/test/unit/utils/commitGraph.test.ts` "Lane seeding from
  branchMap" suite — single-input pins (`HEAD's branch tip lands
on lane 0 even when it's not the newest commit`,
  `cross-render stability: same branchMap → same lane
assignments`, plus the negative-control variants that show
  seeding is a no-op when no `headBranchName` is provided).

### 3. Off-window parent stubs are dashed same-lane edges — spec 8 L9

When a commit's parent hash is not present in `commitsInWindow`
(the parent fell off the loaded `--max-count` slice), the algorithm
emits exactly one graph line:

```ts
{
  fromColumn: column,
  toColumn: column,        // SAME lane — no fresh allocation
  color: getColumnColor(column),
  type: i === 0 ? 'commit' : 'merge',
  style: 'dashed',
}
```

The renderer paints this as a vertical dashed stub — visually "history
continues below the loaded window", IntelliJ parity. Two failure
modes the contract excludes:

- A `style: undefined` (or missing) here regresses to a phantom
  bezier when the renderer strokes the destination column.
- Calling `allocateLane()` for the off-window parent commits a fresh
  column to which no row will ever land; the renderer then draws a
  hook into the empty column.

The L9 contract holds for **both** the first-parent edge of a linear
commit AND the second-parent edge of a merge whose merged-from branch
is off-window. When a merge has one in-window parent and one
off-window parent, the in-window edge is a normal bezier and the
off-window edge is the dashed same-lane stub — no interaction
between the two.

#### Off-window FIRST-PARENT mainline continuation (renders SOLID)

`style: 'dashed'` is the **data-model** marker that an edge targets an
off-window parent; it is not, by itself, a "draw a dashed stub" command.
There are two render shapes:

- **Genuine leaf** — a commit whose parents are _all_ off-window. Nothing
  real continues its lane, so the renderer draws the dashed "history
  continues below the loaded window" stub. This renders identically at any
  row (window bottom or not); the lane is released and may be reused below.

- **Mainline continuation** — a merge whose _first_ parent is off-window but
  which _also_ has an in-window parent (a merged side branch occupying the
  rows below). In a single-ref `--topo-order` log the merged branches drain
  first, pushing the mainline's first parent past the loaded slice; the
  trunk genuinely continues below the window. The algorithm therefore
  **reserves** the commit's lane for the rest of the window (never freed for
  reuse) and `computeActiveLanes` extends the off-window stub into a full
  pass-through down to the window bottom. The renderer draws this trunk
  **SOLID** — one unbroken column — even though the line still carries
  `style: 'dashed'`. Dashing it (the pre-fix behavior) collapsed the trunk
  to a half-row stub and let an unrelated branch reuse the freed lane a few
  rows down: the reported "lane-0 line breaks below a merge then reappears
  connecting to nothing" disconnect.

This is a deliberate parity call. IntelliJ reserves its dashed
`LineStyle.DASHED` for **collapsed long edges** — the foldable "hidden
commits" affordance (every DASHED edge in
`platform/vcs-log/.../testData/elementGenerator/manyNodes_out.txt` is
paired with an expand/unselect toggle; see
`platform/vcs-log/graph-api/.../EdgePrintElement.kt`) — and draws mainline
trunks SOLID. IntelliG has no long-edge fold yet, so it repurposes dashed
only as a not-loaded-history hint on genuine leaves and keeps trunks solid,
matching IntelliJ's trunk rendering.

Pinned by the `Off-window first-parent mainline continuation` suite in
`src/test/unit/utils/commitGraph.test.ts` (gap-fill, no-reuse, real-ink,
the load-bearing SOLID-stub clause, both-parents-off-window leaf, non-bottom
leaf, and the lane-width bound) and the no-orphan / width pins in
`src/test/unit/utils/realTopoRegression.test.ts`.

Pinned by:

- `src/test/unit/utils/commitGraph.test.ts` "Phase 1a pins" suite
  — `off-window parent ⇒ {fromColumn === toColumn, style:
"dashed"} and zero new lane allocations (spec 8 L9)` and `off-window
first parent of an in-window merge ⇒ same-lane dashed; bezier
still emitted for second parent (spec 8 L9 + merge interaction)`.
- The pre-existing `Off-window parent stubs are marked style:
dashed` suite in the same file — covers the linear-commit and
  second-parent-merge variants that landed in the bug-fix branch.

### 4. Same-lane stroke color uses the source lane — spec 8 L4

When `fromColumn === toColumn`, the renderer's vertical stroke MUST
use `getColumnColor(fromColumn)` — the source commit's lane color,
NEVER a destination lane color. The data-model side of this rule is
that the algorithm sets `color: getColumnColor(column)` for every
same-lane edge it emits, including the off-window stub from spec 3 above.

This invariant is shared with the renderer surface and is pinned by
the existing renderer tests; it appears here only to record the
contract that the algorithm's same-lane edges do NOT carry a
destination-lane color even when the edge bends to a parent on a
different lane (which never happens for same-lane edges by
definition, but the rule is the same one the renderer enforces and
must stay aligned). The Phase 2 plan extends `graphRenderer.ts`'s
test surface for this; this ADR records the algorithm side of the
contract that survives that extension.

Pinned by:

- `src/test/unit/utils/graphRenderer.test.ts` — `same-lane lines
should not produce bezier curves` and `should return at least 8
distinct colors` (the L4 markers tracked by the
  `lanesPinned.audit.test.ts` Phase 0 audit).

### 5. The lanesPinned audit cross-references this ADR

`src/test/unit/audit/lanesPinned.audit.test.ts` is the meta-test
that points at the named test files pinning each invariant. Phase 0
landed it covering L1, L2, L4. Phase 1a does NOT extend its
`INVARIANT_PINS` table — the audit's stated scope deliberately stops
at the trio whose pin tests existed at the time it was written.
Future audit extensions (L9 in particular, plus L5 / L11 / L14 in
Phase 4) will add rows that point at the test files this ADR cites.

## Consequences

### Positive

- **Single canonical reference.** Future contributors touching
  `commitGraph.ts` see a JSDoc `@invariant` on the function pointing
  at this ADR; the ADR points at the spec rule and the test pins.
  Three hops, every direction crosses to a stable surface.
- **Test pins co-evolve with the contract.** A change that dropped
  the seeding pre-pass would break property A in
  `laneStabilityAcrossReload.property.test.ts` AND the L1 unit
  pins; a change that dropped the off-window dashed stub would
  break the L9 unit pins. The contract and its regression guards
  fail together, in the same suite, with messages that point at the
  rule and at the spec entry.
- **Property tests cover the random-input space.** The fast-check
  arbitraries in the new property files generate ~80-100 random K /
  depth / head-pick / interleaving combinations per run; the
  pre-existing unit pins lock specific shapes a contributor can
  read by eye. The two layers are complementary.

### Negative

- **One more ADR to keep current.** When the lane release pre-pass
  ships (the deferred Phase 1b — see implementation plan "Open
  questions resolved"), this ADR will gain a spec 6 covering the
  released-after-row lifetime model. The append-only style means
  the existing sections survive; the deferred work has its own
  follow-up entry in `KNOWN-ISSUES.md` task #49.
- **Test-pin paths are coupled to file names.** A rename of any of
  the cited test files breaks both this ADR's references and the
  `lanesPinned.audit.test.ts` markers. The audit catches the
  rename at suite time; this ADR catches it at PR review time.
  Both are intended.

### Neutral

- **No production-code change.** Phase 1a deliberately ships only
  test pins and this ADR. The algorithm is already correct on
  `main` thanks to the bug-fix branches that preceded the redesign;
  Phase 1a locks that correctness.
- **The `style: undefined` tolerance in `IGraphLine`** is a
  forward-compat affordance, not a contract gap. The renderer's
  `style === 'dashed'` check naturally treats absent / undefined as
  solid; the algorithm sets `style: 'dashed'` exactly when the rule
  demands it. Consumers that build their own `IGraphLine` objects
  (test fixtures, hand-rolled graph snapshots) are not required to
  enumerate `style: 'solid'` for ordinary edges.

## Alternatives considered

### Encode invariants only as JSDoc on `commitGraph.ts`

The bug-fix branches landed JSDoc `@invariant` annotations on the
relevant functions and types. Rejected as the sole record because
JSDoc is read by people who already opened the file. A future
contributor surveying "what does the graph data model promise?"
needs an entry point that doesn't require knowing which file owns
the rule. ADRs are that entry point.

### Inline the data-model contract into the spec

The spec (`docs/design/git-tool-window-spec.md`) is the UX
reference; it tells designers and reviewers what a user sees. The
data-model contract is downstream of UX rules but upstream of every
implementer touching the algorithm or the renderer. Folding it into
the spec would mix two audiences. Keeping the spec rules (spec 8.L1,
spec 8.L4, spec 8.L9) authoritative for the user-visible behaviour and this
ADR authoritative for the algorithm / data-model implementation
keeps each surface scoped to one audience.

### One ADR per invariant (ADR-013, -014, -015)

Three small ADRs would let each rule stand alone. Rejected because
the rules SHARE the algorithm surface — `generateCommitGraph` is one
function, the seeding pre-pass and the off-window guard live in the
same loop, and the same-lane color rule depends on the lane indices
the seeding pre-pass produces. Splitting the ADR would force readers
to assemble the contract from three documents; the L1+L4+L9 group is
exactly the algorithm boundary, so one ADR is the right altitude.

## Cross-references

- `docs/design/git-tool-window-spec.md` spec 8.L1, spec 8.L4, spec 8.L9 — the
  user-visible rules this ADR encodes for the algorithm + data-model
  surface.
- `docs/design/git-tool-window-implementation-plan.md` Phase 1a —
  the plan that schedules this ADR alongside the test pins it
  documents (so the canonical decision and its regression guards
  land together, not as a Phase 7 afterthought).
- `src/git-core/commitGraph.ts` — the algorithm boundary; carries
  `@invariant` JSDoc citing each rule and pointing at this ADR.
- `src/utils/graphRenderer.ts` — the renderer surface that consumes
  `IGraphLine`. Phase 2 of the plan extends its tests for L4 +
  focus-dim; this ADR records the algorithm side of the contract
  the renderer relies on.
- `src/test/property/laneStabilityAcrossReload.property.test.ts` —
  the L1 byte-identical-reload property pins (Phase 1a).
- `src/test/property/headAncestryPromotion.property.test.ts` — the
  L1 HEAD-ancestry-promotion property pin (Phase 1a).
- `src/test/unit/utils/commitGraph.test.ts` — the unit-level pins
  for L1 + L9, including the new "Phase 1a pins" describe-block.
- `src/test/unit/audit/lanesPinned.audit.test.ts` — the meta-audit
  that asserts named pin tests exist for L1, L2, L4 (Phase 0
  scope; Phase 4 extends it).
- ADR-001 — IGitService composite freeze; the data-model freeze
  pattern this ADR follows.
- ADR-009 — webview state ownership; the renderer / host split
  that consumes `ICommitNode` on the renderer side.
- ADR-010 — visual parity discipline; the snapshot-test pattern
  that locks the renderer's `IGraphLine` consumption.
- ADR-012 — topical source tree; locates `commitGraph.ts` under
  `src/git-core/` and its tests under `src/test/unit/utils/` and
  `src/test/property/`.

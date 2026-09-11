# ADR-016: Graph column packing by per-row rank

Status: Accepted (2026-09-05)

## Context

The commit graph's column packer relabels each raw lane's high, sparse
index (assigned by the lane allocator across the lane's whole
lifetime — see ADR-013 section 2) down to a dense, per-row-bounded
column so the gutter is only as wide as the busiest row actually
needs. Once a real history grew past a screenful of rows, lines
visibly crossed: a line entering a row in one column would appear to
swap places with a neighbouring line, and the eye followed the wrong
pair of stubs across the row boundary.

The previous packer (`src/git-core/graph/laneCompaction.ts` before
this change) split each raw lane's drawn rows into maximal consecutive
runs — a "cluster" — and colored each cluster independently with a
greedy lowest-free-column pass. Any row where a lane went undrawn
split its run in two, and the two halves were then free to land in any
column relative to each other. Two lanes `A < B` could come out of the
greedy with `column(A) > column(B)` in the very same row — the packer
was **order-destroying**, not merely occasionally wrong.

Measured order inversions (two visible lanes whose columns disagree
with their raw-lane order, same row) on the old cluster packer:

| fixture                 | inversions |
| ----------------------- | ---------- |
| bitcoin@1000 (380 rows) | 789        |
| realTopoAnon@413        | 72         |
| realTopoAnon@100        | 30         |
| selfTopoAnon@125        | 0          |

## Decision

A lane's column in row _r_ is its **rank among the lanes visible in
row r**, ordered by raw lane index:

```
column(L, r) = |{ L' visible in row r : L' < L }|
```

Implemented in `buildRankMap` / `compactPrintModelLanes`
(`src/git-core/graph/laneCompaction.ts`). Rank is order-preserving by
construction — it cannot invert two lanes' relative order — and dense
by construction: a row with _k_ visible lanes always fills columns
`{0..k-1}`, with no search and no free-column bookkeeping.

This mirrors IntelliJ's `getSortedVisibleElementsInRow`
(`platform/vcs-log/graph/src/com/intellij/vcs/log/graph/impl/print/PrintElementGeneratorImpl.kt:246-268`
in the vendored source at `~/Documents/workspace/intellij-community/platform/vcs-log`):
it collects every element visible in the row and sorts it once
(`Collections.sort(result, elementComparator)`), so an element's
printed position is its rank in that per-row sorted list, not a
column carried over from a previous row.

Order inversions, old packer → rank, on the same fixtures:

| fixture          | before | after |
| ---------------- | ------ | ----- |
| bitcoin@1000     | 789    | 0     |
| realTopoAnon@413 | 72     | 0     |
| realTopoAnon@100 | 30     | 0     |
| selfTopoAnon@125 | 0      | 0     |

Rendered gutter width is unchanged on every fixture: 200 / 80 / 60 /
60px, same max column as before. Rank costs no width because each
row's column set is dense `{0..k-1}` by construction, and a hidden
edge costs zero width because it is not visible in the row and
therefore never ranked — the same `inkedLanes`-based width budget from
invariant H2 (`test/support/graphInvariants.ts`) holds unchanged.

A hidden gap is **not** required to keep its column. Both ends of a
hidden long edge carry an arrow stub meaning "continues elsewhere"
(IntelliJ's contract, `src/git-core/graph/longEdges.ts`); rank keeps
that deliberately. The acceptance criterion is not "no line ever
changes column" — it is "no line crosses another line's column, and
any line that changes column does so only across an arrowed gap."

### Rejected alternative: bridging

Holding a lane's column fixed across its own hidden gap (rather than
letting rank reuse the freed column) re-inflates the column count to
the max raw lane **index**: 41 columns / 840px on bitcoin@1000 against
9 columns / 200px with rank. `computeGraphWidthFromModels`
(`src/git-core/graph/printModel.ts:734`) sizes the gutter from the
per-row `inkedLanes` max, and `.commit-graph` is
`width: var(--graph-width, 80px); overflow: hidden`
(`src/git-core/gitToolWindow/provider/commitRowStyles.ts:64`) — a
wider gutter clips the message column. Rejected.

Slanting the line alone, without bridging the column, was also
measured and found to be a no-op: the crossing is a column-order
defect, not a rendering-angle defect, so nothing short of fixing the
packer's order removes it.

### Seam docking

Rank makes a lane's column differ between adjacent rows far more often
than the old cluster packer did — 200 such changes on bitcoin@1000,
where the cluster packer had 0 (a cluster's own run never changed
column mid-run by construction). Painting each row's edge at its own
column with a plain vertical stroke would render every one of those
200 changes as a sideways step at the row boundary.

`src/git-core/graph/laneLinking.ts` resolves, per edge half touching a
row boundary, which column the neighbour row actually drew for the
same physical lane, and `src/git-core/graph/graphPainter.ts` slants
the segment's last pixels toward the midpoint — matching
`SimpleGraphCellPainter.kt:168`
(`paintLine(g2, x1, y1, x2, y2, (x1 + x2) / 2, (y1 + y2) / 2, ...)`),
where a non-vertical edge's control point is the midpoint between its
two row-local x-coordinates on both sides of the boundary.

The rule is one rule with a precedence: identity, then raw lane, then
own column (`straightSeam` in `laneLinking.ts`). A bend (merge/branch
curve) skips the identity step, because its continuation across a row
boundary is a different edge by construction — the curve terminates at
a node. The raw-lane fallback is load-bearing: without it, rank plus
docking leaves 173 broken row boundaries on a real merge-heavy history
where a fork/merge boundary has two different edges sharing one
physical lane, against 47 broken boundaries on `main` today — worse
than what shipped, in a change whose whole point is that lines
connect.

Two implementation hazards, both of which happened during this work:

1. **Capture raw endpoints before the remap.** `compactPrintModelLanes`
   overwrites each edge's `fromLane`/`targetLane` with packed columns
   in place. `linkSeams` needs the pre-remap raw lane to look up the
   neighbour row's column for the same physical lane; a raw-keyed
   lookup performed after the remap silently docks a bend to the wrong
   line. A prototype shipped exactly this bug with every graph
   invariant green across 8,539 tests; it was only caught by a
   byte-diff against the previous painter's output, not by any test
   assertion.
2. **An invariant written while the mechanism is inert encodes the
   inertness, not the contract.** Invariant K (boundary ink
   continuity, `test/support/graphInvariants.ts`) originally compared
   a painted endpoint against the neighbour row's column **centre**.
   That comparison was trivially true while nothing docked (own column
   equalled neighbour column, so "centre" and "midpoint" coincided),
   and went red on 544 boundaries the moment rank made seams actually
   move columns. The correct comparison is the docking **midpoint**
   the painter computes, not the neighbour's raw column value.

## Invariants (`test/support/graphInvariants.ts`)

- **E2** — seam continuity. Column continuity itself (the old
  invariant E) is no longer required: rank legitimately relabels a
  lane's column at a fork/merge boundary. What must hold instead is
  that each side's seam stamp faithfully names the other side's real
  column, so the painter's `(ownColumn + seamColumn) / 2` midpoint
  lands on the same pixel from both sides.
- **H2** — width budget over `inkedLanes`, with **no headroom**:
  measured slack between packed width and the busiest row's
  drawn-lane count is 0 on every fixture. Replaces the old invariant
  H, which asserted exact equality but never counted `inkedLanes` — the
  quantity the gutter width is actually derived from.
- **I** — determinism across two independent builds, not idempotency
  (in-place re-compaction). Re-running `compactPrintModelLanes` on the
  same model objects K inspects would rebuild `rawToColumn` from
  already-packed lanes and silently overwrite a wrong seam with a
  coincidentally-right one on the second pass, laundering the exact
  defect K exists to catch before K ever sees it.
- **J** — gap termination, asserted on the edge identity's **raw**
  lane (`e.edge.lane`), never the packed column. Rank reuses a hidden
  gap's freed column far more freely than the old cluster packer, so
  asserting on the packed column would fail on correct code.
- **K** — boundary ink continuity, read off the painted SVG output
  rather than off the seam data fields, so a wrong seam shows up as
  ink landing at the wrong x-coordinate instead of only as a data
  mismatch a human has to interpret.

## Known divergences from IntelliJ

All pre-date this work and are cosmetic:

- Arrowhead barbs are axis-aligned; IntelliJ rotates them to the
  segment (`SimpleGraphCellPainter.kt:137-144`).
- Terminal stubs reach the row edge; IntelliJ's terminal stubs stop
  short (`SimpleGraphCellPainter.kt:158-161`).
- `showLongEdges` skips the whole pipeline rather than raising the
  hiding threshold, so that code path is never packed or seam-stamped
  by this change.

## Honest limits

- The visual test lane (`test/visual`, `npm run test:visual`) has 216
  passing tests and not one real graph pixel: the three specs that
  touch a graph cell assert text colour against a stub model with lane
  0 and zero edges. It stays green through any geometry regression in
  this pipeline; the invariants above, not the visual lane, are what
  cover column packing and seam docking today.
- Whether a multi-column slant reads to a human eye as one continuous
  line is a judgement call, not a measured quantity. At the widest
  observed case a four-column seam travels 40px across a 12px row
  height. F5 dogfood of this change is owed and has not been done.

## Consequences

### Positive

- Order inversions are eliminated by construction (0 across all four
  fixtures) rather than reduced by a better search heuristic.
- Gutter width is unaffected: rank's density guarantee means the
  width budget (H2) never grows relative to the previous packer.
- The seam-docking mechanism (`laneLinking.ts`) was landed and
  characterized as an inert no-op one commit before rank activated it,
  so the packer change itself carries no new painter logic to review
  alongside the packing-order fix.

### Negative

- A lane's column now differs between adjacent rows far more often
  than under the old packer (200 vs 0 on bitcoin@1000), so every
  consumer of `graphColumn` / `IRowEdgeElement.lane` across a row
  boundary must go through the seam fields (`topLane`/`bottomLane`),
  not assume a fixed column for a lane's whole visible span.
- The raw-lane fallback in seam resolution is a second, harder-to-see
  invariant a future refactor of `laneLinking.ts` must preserve; its
  absence only shows up as a broken-boundary count regression, not a
  type error or an obviously wrong shape.

### Neutral

- No change to `IGraphLine` / `ICommitNode` (ADR-013's frozen data
  model); packing and seam linking are a print-model-stage
  transformation downstream of that boundary.

## Alternatives considered

### Bridging a lane's column across its own hidden gap

Rejected — see "Rejected alternative: bridging" above. Re-inflates the
gutter from 9 to 41 columns on bitcoin@1000, which the fixed-width
`.commit-graph` CSS clips.

### Keep the cluster/interval packer, fix only the greedy assignment

Considered patching the existing lowest-free-column greedy to sort
clusters by raw lane index before assignment. Rejected: the
order-destroying defect is structural to independently-colored
clusters, not to the assignment order within one pass — a lane split
into two runs by an undrawn row is still two independently-colored
clusters under any greedy ordering, and the two pieces can still land
out of order relative to a lane that stayed in one run the whole time.
Per-row rank sidesteps the cluster concept entirely.

## Cross-references

- ADR-013 — the frozen `IGraphLine` / `ICommitNode` data model this
  packing stage sits downstream of; this ADR adds no field and no
  change to that freeze.
- ADR-010 — visual parity discipline; the "honest limits" section
  above is this ADR's instance of that discipline's demand for
  runtime verification, not yet satisfied here.
- `src/git-core/graph/laneCompaction.ts` — the rank packer
  (`buildRankMap`, `compactPrintModelLanes`).
- `src/git-core/graph/laneLinking.ts` — seam resolution
  (`straightSeam`, `bendSeam`, `linkSeams`).
- `src/git-core/graph/graphPainter.ts` — the docking painter that
  slants a segment's endpoint toward the seam midpoint.
- `src/git-core/graph/printModel.ts` — `computeGraphWidthFromModels`,
  the `inkedLanes`-based width budget H2 measures against.
- `test/support/graphInvariants.ts` — E2, H2, I, J, K.

# ADR-016: Graph column packing by per-row rank

Status: Accepted (2026-09-05)

A test below is never cited by line number — a test file's line numbers
move with every edit, so `check-doc-citations` rejects a `*.test.ts`
citation that carries one. Production and vendored IntelliJ source
citations below keep line numbers; `check-doc-citations` bounds-checks
the ones with a `src|test|scripts` root.

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

| fixture                   | inversions |
| ------------------------- | ---------- |
| bitcoin@1000 (1,000 rows) | 789        |
| realTopoAnon@413          | 72         |
| realTopoAnon@100          | 30         |
| selfTopoAnon@125          | 0          |

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

Computed gutter width is unchanged on every fixture: 200 / 80 / 60 /
60px, same max column as before. The rendered gutter floors at 80px
(`logPanelHtml.ts`), so the two narrow fixtures render wider than they
compute. Rank costs no width because each
row's column set is dense `{0..k-1}` by construction, and a hidden
edge costs zero width because it is not visible in the row and
therefore never ranked — the same `inkedLanes`-based width budget from
invariant H2 (`test/support/graphInvariants.ts`) holds unchanged.

A hidden gap is **not** required to keep its column.
`computeLongEdgeCuts` (`src/git-core/graph/longEdges.ts`) arrows the two
ends of each hidden span it cuts, meaning "continues elsewhere"
(IntelliJ's contract); rank reuses the freed column in between
deliberately. The acceptance criterion this decision is responsible for
is therefore about ordering, not continuity: **no line crosses another
line's column within a row.** A column change across a hidden span is
permitted, and the arrow stubs at the span's two ends are what make it
readable.

`computeLongEdgeCuts` decides visibility one edge at a time rather than over
a merged lane interval, and hides a stretch only when nothing else draws it.
An edge beginning inside another edge's span on the same lane therefore keeps
its own ink, and every hidden span carries an arrow stub at both ends.

### Rejected alternative: bridging

Holding a lane's column fixed across its own hidden gap (rather than
letting rank reuse the freed column) re-inflates the column count to
the raw lane index rather than the drawn density. Measured with hiding on,
that is 41 columns / 840px on bitcoin@1000 against
9 columns / 200px with rank. `computeGraphWidthFromModels`
(`src/git-core/graph/printModel.ts:738`) sizes the gutter from the
per-row `inkedLanes` max, and `.commit-graph` is
`width: var(--graph-width, 80px); overflow: hidden`
(`src/git-core/gitToolWindow/provider/commitRowStyles.ts:64-66`) — a
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
the segment's last pixels toward the midpoint. IntelliJ makes its two
halves meet by a different route. A vertical stub's coordinates are
direction-dependent: a DOWN stub runs `rowCenter` to `rowHeight`
(the row's bottom edge); an UP stub runs the opposite way, `rowCenter`
to `0` (the row's top edge)
(`platform/vcs-log/impl/src/com/intellij/vcs/log/paint/SimpleGraphCellPainter.kt:158-161`
in the vendored source at `~/Documents/workspace/intellij-community`). A
non-vertical edge always runs a full row height from the same start:
a DOWN half ends `rowCenter` beyond the bottom edge at `rowHeight +
rowCenter`, and an UP half ends `rowHeight - rowCenter` beyond the
top edge at `rowCenter - rowHeight` (`:165-167`) — the "twice the size"
of IntelliJ's own comment there, "paint non-vertical lines twice the
size to make them dock with each other well", is a factor of two
relative to the vertical stub's own length in that direction
(`rowHeight - rowCenter` down, `rowCenter` up). Writing `a = rowCenter
/ rowHeight`, that ratio is `1 / (1 - a)` down and `1 / a` up — both
equal 2 only when `a = 1/2`.

Row r's downward half crosses the
shared boundary at `x2 + a(x1 - x2)`, and row r+1's upward half crosses it
at the same value, so the halves meet for **any** `rowCenter`. That
generality is worth having, because `:81` snaps `rowCenter` to an integer
and it is not always exactly half a row. The crossing coincides with the
midpoint `(x1 + x2) / 2` only in the default case `a = 1/2`.

Our painter reaches the same place from the other end: both sides compute
the midpoint of the two columns directly, so they dock by construction
rather than by geometry. The parity is that both dock, not that both derive
the crossing the same way.

`(x1 + x2) / 2` does appear explicitly at `:168`, passed as `paintLine`'s
`startArrowX`/`startArrowY`, and it is tempting to read that as the docking
point. It is not. It is the segment's own midpoint, which coincides with the
crossing only at `a = 1/2`, and those two parameters are read only inside
`if (hasArrow)` at `:137-144` to anchor the arrow barbs; the line itself is
the plain `Line2D.Double(x1, y1, x2, y2)` at `:136`. The crossing comes from
the endpoints, not from that pair.

The code is one rule with a precedence: identity, then raw lane, then own
column (`straightSeam` in `laneLinking.ts`). Only the raw-lane step is
currently live. `buildIdentityMaps` is built from the ALREADY-REMAPPED
models, storing `edgeIdKey(e.edge) -> e.lane` (packed column) — and
`edgeIdKey` reads `e.edge.lane`, which compaction never touches, so it is
always the SAME raw lane the raw-lane arm would look up. Because both
maps are derived from the same row's rank map, whenever
`identityMaps[neighborRow].get(myKey)` is defined it names the identical
packed column `rawToColumn[neighborRow].get(rawLane)` would already
return — identity succeeding requires the exact same raw lane to be
present in the neighbor row, and once it is, both paths read it from the
same map. Two independent ablations confirm this on everything the
pipeline emits: uniquifying `edgeIdKey` so identity never matches leaves
all four checked-in fixtures byte-identical, and forcing the identity
arm to always return `undefined` leaves 3,000 fuzzed random topologies
byte-identical (`workspace-notes/verify/fuzzIdentityArm.ts`). The
identity step is retained anyway — `printModel.ts:48-63` records `edge`
as a deliberate architectural layer for future edge-level interactivity,
and removing the arm is a product decision, not a review finding.

IntelliJ's own fallback ladder does not map onto ours the way it looks
like it should. `PrintElementGeneratorImpl.kt`'s `createEndPositionFunction`
(`:175-189`) builds `toPosition` as a `HashMap<GraphElement, Int>` and
does `toPosition[edge] ?: toPosition[getGraphNode(nodeIndex)]`
(`:182-186`). That is a VALUE lookup, not an object-reference one:
`GraphEdge.equals`/`hashCode` (`GraphEdge.java:56-76`) are overridden
over `myUpNodeIndex`/`myDownNodeIndex`/`myTargetId`/`myType`, and
`GraphNode.java:29-45` the same over `myNodeIndex`/`myType` —
structurally the analogue of our own `edgeIdKey` string, not a reference
lookup two equal-looking edges could defeat. What actually breaks the
parity is granularity, not identity kind: IntelliJ's key is the edge's
own endpoints (or the node's own index), fresh per row from
`getSortedVisibleElementsInRow`, and it has no notion of a raw lane
NUMBER two DIFFERENT edges could share the way ours does — a lane, in
our sense, is not a concept its model has at all. We pack by raw lane
instead, so a lane-keyed lookup resolves a case an edge-keyed one
structurally cannot: the case the raw-lane arm exists for — a
fork/merge boundary where two DIFFERENT edges share one physical lane —
has two different `GraphEdge` value-keys in IntelliJ's model no matter
what lane they'd share in ours. IntelliJ's third outcome differs too: it
returns null and `PrintElementGeneratorImpl.kt:156-167` then emits no
half at all, or a terminal stub, where we fall back to an undocked
vertical. None of this makes our identity arm
IntelliJ-motivated; it is retained for the reason in `printModel.ts`,
and the raw-lane arm is what does the parity-relevant job (see the
144-broken-boundary ablation below). `laneLinking.test.ts` pins the
raw-lane arm's key rather than only its output. A bend (merge/branch
curve) skips the identity step because it is never useful there: an
'up' bend at row _r_ has `childRow === r` and would consult
`identityMaps[r - 1]`, but every straight in row _r - 1_ has
`childRow <= r - 1` (a merged interval's straight starts at `iv.startRow`,
and the no-interval arm falls back to the emitting row itself, so either way
it covers that
row), so the bend's key can never be present in that map, whatever
shapes a straight's interval can take. A 'down' bend's identity
resolves (via the target lane's straight pass-through below) to the
same column the raw-lane arm already returns. The raw-lane arm alone is
sufficient for both. The raw-lane fallback is load-bearing on both
arms, but not measurably so by the same instrument, and the two must be
stated separately rather than as one pair.

The BEND arm (`bendSeam`'s only fallback besides own column) is what
invariant K's `countBrokenBoundaries` can see: removing it alone leaves
144 broken row boundaries on bitcoin@1000 — a fork/merge boundary where
two different edges share one physical lane fails to connect — against 0
on the other three fixtures. Today's baseline (both arms intact) is 0
broken row boundaries on all four fixtures; invariant K's own positive
control (`test/support/graphInvariants.ts`) asserts exactly that, since a
boundary with no ground-truth entry in the neighbor row — a hidden
long-edge span, an off-window stub, a leaf — is structurally skipped by
`countBrokenBoundaries` rather than counted as broken. That skip is what
keeps K from firing on legitimate terminations. It also means K cannot
tell a legitimate termination from an illegitimate one: a wrongly-hidden
span reads to K exactly like a correctly-hidden one (see Honest limits). Removing the
STRAIGHT arm alone (`straightSeam`'s `byRawLane` branch) leaves
`countBrokenBoundaries`'s count at 0 — on all four fixtures, and on 2,000
random synthetic topologies fuzzed for this measurement. The joint
ablation (both arms removed) is the same 144, contributed entirely by
the bend.

That zero is `countBrokenBoundaries` specifically, not "nothing catches
it" — the straight arm is pinned twice over. Synthetically,
`test/unit/graph/laneLinking.test.ts` has two direct cases: "a straight
boundary with no identity match falls back to the raw-lane entry, not
its own column" and "the raw-lane arm keys on the physical lane, not on
the edge that occupies it"; the bend has its own separate case, "a bend
reads the RAW endpoint against the neighbor row, not its own
already-packed lane". End-to-end, removing the straight arm also fails
`test/unit/utils/topo/graphPipelineInvariants.test.ts`'s "upholds every
layout invariant on real bitcoin topology" on the real bitcoin@1000
fixture — not via K, but via invariant E2 (seam continuity): `edge
11:r12:4 row 12's top seam 1 must name row 11's real column 2`.
Ablating the straight arm turns exactly three tests red: the two
`laneLinking.test.ts` cases named above and
`graphPipelineInvariants.test.ts`'s bitcoin case, via E2. Every other
unit test stays green, including the bend case above — `bendSeam` reads
`rawToColumn` directly and never calls `straightSeam`. The property
suite stays green either way. E2 is the only one of the three that
covers this case on a real fixture; the two `laneLinking.test.ts` cases
pin it synthetically.

Why `countBrokenBoundaries` specifically misses what E2 catches:
`rawLaneGroundTruth` (K's ground truth, distinct from E2's) records a
raw lane's column only from a straight edge or the row's own node, never
from a bend or an inked-only occupant. Fuzzing 5,000 random small
topologies (a seeded PRNG, `mulberry32(42)`) hits the straight arm's
`byRawLane` branch, with a value genuinely different from the edge's own
column, in 3,413 of them. Over the FIRST 2,000 of that same sequence —
both scripts consume the RNG identically, so this is a prefix of the
5,000, confirmed by index, not an unrelated sample — 1,346 hit the arm
that way, and ablating the arm changes the PAINTED SVG bytes on exactly
those same 1,346 trials: positionally intersecting the differing-column
hit set with the byte-changed set over the 2,000 gives 1,346 in the
intersection and 0 in either set alone. The hit set and the changed set
are identical, which is stronger evidence than either count alone — a
frequent, real, visible effect that `countBrokenBoundaries` cannot see
because every one of those differing hits resolves through a
neighbor-row raw lane that some OTHER kind of element occupies (a bend,
or a lane inked but not separately claimed by a straight), so K's
narrower ground truth has no entry there and skips the boundary as a
legitimate termination. That is a real, narrow blind spot in
`countBrokenBoundaries` for the straight arm — not evidence the arm is
unreachable or redundant the way `chevronLanes` is (see invariant M
below), and not evidence the arm goes unverified: E2 and the two unit
cases already cover it.

(Measured by ablating each arm independently: diffing invariant K's
`countBrokenBoundaries` against the four checked-in fixtures and against
2,000 fuzzed random topologies, running the straight-arm ablation
through the full unit and property suites to find what else it broke,
and fuzzing 5,000 random topologies for reachability and paint-byte
diffing — scripts at `workspace-notes/verify/measureAdrNumbers.ts`,
`fuzzStraightArm.ts`, `fuzzStraightArmBroken.ts`,
`fuzzStraightArmVisual.ts`. An earlier draft of this section quoted
173/47 from a review prototype whose own broken-boundary counter counted
a legitimate termination and then tolerated it rather than skipping it,
so its baseline read 47 instead of 0 — a different counting rule, not a
different measurement of the same quantity.)

### How steep the slants actually are

State the counting rule with the numbers. An earlier draft of this section
carried a second table over a wider population, and its non-vertical total
reproduced under no counting rule at all: a seam slot that is never stamped
carries no displacement, so a wider population can only add zeros. The rule
below is the one that reproduces against this tree.

Counted over every seam field `linkSeams` stamps — a `full` segment carries
two, every other element one — 6,551 in total on bitcoin@1000, matching
`2 x 1,902 fulls + 2,747 others = 6,551` exactly: the signature of every
element carrying its full complement of stamps. That arithmetic says
nothing about whether each stamp is also a seam a segment actually draws
— that no stamp goes unpainted is a separate fact, established below by
the painter, not by this count. `graphPainter.ts`
does discard a seam value on several branches, but each discard is keyed on
`el.half` — the same field `linkSeams` reads when deciding which seam to
stamp — so a branch that can drop a displacement only ever drops a value
that was never stamped. One further branch discards both seam values
without consulting `el.half`, but it fires only when each kept seam already
equals the element's own column, so what it drops is always zero. The field is named rather than the rendering
because a script can count the field.

| columns crossed | 0     | 1   | 2   | 3   | 4   |
| --------------- | ----- | --- | --- | --- | --- |
| seam fields     | 5,862 | 602 | 61  | 16  | 10  |

So 689 of 6,551 stamped seams are non-vertical, about 10.5%. Measured
against this tree rather than carried over from an earlier draft.

`workspace-notes/verify/measureSlantHistogram.ts` measures every seam's
displacement as `|paintedLane - e.lane|` uniformly, straight or bend. That
is correct only because of a field alias, not by construction: `printModel.ts`'s
down-bend push sets `lane: line.toColumn` alongside `targetLane: line.toColumn`
(`:478-480`), and its up-bend push sets `lane: sourceLane` alongside
`fromLane: sourceLane` (`:501-502`), so `e.lane` happens to equal the
endpoint each stamped seam actually measures from. A bend initializer that
stopped keeping `lane` equal to `fromLane`/`targetLane` would mis-measure
this histogram silently, but a broken production alias would not go
unnoticed: `printModelSeamContinuity.test.ts`'s row-seam-continuity
assertions fail on either bend direction, and invariant E2 additionally
fails when the DOWN-bend direction breaks (its ground truth cannot see an
up-bend break). `laneLinking.test.ts` pins something else — its own
`bendEdge` fixture helper's alias, which mirrors `printModel.ts`'s without
being wired to it (the file imports `printModel.ts` only under `import
type`, erased at runtime) — keeping the fixture honest, not production —
see Honest limits for what the histogram measurement itself still cannot
see.

One column of slant is roughly 40 degrees from vertical. The worst case is
four columns: 40px of travel across a 12px half-row, roughly 73 degrees, a
near-horizontal jog. There are exactly 10 of them. IntelliJ's painter
behaves the same way, so this is parity rather than a defect, and the slant
is deliberately not capped: it is a judgement to make at dogfood, and if it
reads badly the compatible mitigation is to keep the docking x and steepen
only the visible portion.

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
- **H2** — width budget over `inkedLanes`. It replaces the old invariant
  H, which asserted exact equality but never counted `inkedLanes`, the
  quantity the gutter width is derived from. Note what it can and cannot
  do: every column it counts is at most `globalMaxCol` — the edge and inked
  paths by construction, the node lane because `printModel.ts` inks it too, so
  `maxDistinctInARow` can never exceed `globalMaxCol + 1` for any packer at
  all, and rank's densest row attains the bound. The zero slack is therefore
  forced rather than observed. Note the bound does not rest on a row's
  column set being exactly `{0..k-1}`: `buildRankMap` runs before
  `linkSeams`, and the seam fold adds a neighbour row's column to
  `inkedLanes` afterwards, which is the same reason a density check cannot
  serve as a membership witness below. H2 still rejects a non-dense packer,
  which is what the budget arm caught on the bridge design (recorded from
  that branch's run, not re-measured since it was deleted), but it cannot
  detect a
  widening under rank. The per-fixture packed-width pins in
  `graphPipelineInvariants.test.ts` are what cover that.
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
  mismatch a human has to interpret. K's ground truth is `rankMap[rawLane]`
  by definition, the same quantity `rawToColumn` holds — so K validates
  that a seam function reads the right key and row, not that the rank
  map itself preserves lane order. That property is invariant L's job.
- **L** — order preservation over a row's straight-drawn lanes and its
  node (`rawLaneGroundTruth` in `test/support/graphInvariants.ts`), not
  every visible lane: rank must never invert their relative order
  within a row. A bend endpoint or a chevron-only lane is ranked by the
  same single comparator but is not separately witnessed by this
  ground truth. Counted against the actual per-row rank maps
  (`buildRankMap`'s output, BEFORE `linkSeams` folds a neighbour row's
  column into `inkedLanes` — the compacted models' own `inkedLanes`
  are a wider, post-seam population and reproduce a different pair of
  numbers): on bitcoin@1000, 282 of 1,000 rows carry a ranked column L
  never witnesses (393 in total, at most 6 in one row), and on 28 rows L
  checks fewer than two columns while two or more were ranked. A second
  arm covering the rest was considered and rejected. Rank applies one
  comparator once to one set, so a comparator defect misorders straights
  too and this arm can compare on 972 of those 1,000 rows (measured
  directly, not derived by subtraction); the membership gap this leaves —
  a lane none of L's ground truth, or L itself, ever names — is fenced
  separately and directly, not by this arm: invariant M's rank-map-membership
  witness, `assertRankMapMembership` (`test/support/graphInvariants.ts`),
  checks, for every row, that every lane contributed by the node, by each
  edge, by `inkedLanes`, or by `chevronLanes` gets a rank at all.
  `assertGraphInvariants` still runs it for every fixture in the suite, and
  `graphPipelineInvariants.test.ts` additionally runs it alone, with nothing
  else able to fail first, in "every lane a row contributes gets a rank:
  realTopoAnon.json@413" — the one `it(` the
  `graph-lane-rank-map-inked-lanes-arm` mutation-manifest entry targets, so
  that entry proves M specifically dies if `inkedLanes`'s contribution is
  removed, not merely that some other assertion in `assertGraphInvariants`'s
  full invariant list does. Measured directly, two ways: applying the
  manifest's own mutation and running just that isolated test fails at M's
  assertion — on `realTopoAnon.json@413`, row 4's orphaned lane 0 remaps to
  itself under `compactPrintModelLanes`'s `map.get(lane) ?? lane` remap, so
  neither H2's width budget nor K's off-canvas check would have caught it
  even had they run; and disabling `assertRankMapMembership`'s body while leaving the
  mutation's target production code alone makes the manifest entry pass
  under mutation (unfenced) once the full mutation lane re-runs. The reason
  not to
  extend L itself is cost, not redundancy: it would promote the
  index-parallelism between the packed and
  unpacked model arrays from an incidental property to an asserted one, so
  its only available failure is a spurious one the day anyone reorders
  `m.edges`. Note also that a per-row density check cannot serve as
  the membership witness: after seam folding a row legitimately carries a
  neighbour row's column above its own `k-1`, so it would go red on
  correct code. This is the property the rank packer exists to
  guarantee; nothing else in this list is sensitive to a permutation of
  a row's column assignment (see the order-inversion table above).
- **M** — rank-map membership. Independently of L's straight-only ground
  truth, every lane the node, each edge (`lane`/`fromLane`/`targetLane`),
  `inkedLanes`, or `chevronLanes` contributes must be a key in that row's
  rank map (`buildRankMap`'s output), checked against the raw pre-compaction
  models — a lane missing a key keeps its raw index after compaction (K arm
  2's off-canvas paint). `chevronLanes` is vacuously covered today, and it
  has two writers, each covered for a different reason. The own-lane
  dashed-stub add (`printModel.ts:444`, inside the `isDashed` branch) always adds
  `ownLane`, which `inkedLanes` also adds unconditionally (`:533-535`) —
  covered regardless of what `isDashed` evaluates to. The off-window
  chevron loop (`:519-523`) only ever adds a lane already in
  `bottomInkLanes`, and `bottomInkLanes` has exactly two writers — inside
  the `activeLanes` loop (`:345`, within the loop at `:330`) and the
  own-lane add (`:442`) — both of which `inkedLanes` also adds directly
  (`:530` inside its own `activeLanes` loop, `:533-535` for the own lane).
  So M starts having teeth for that source only the day `:444` adds
  something other than `ownLane`, or either `bottomInkLanes` writer stops
  matching its `inkedLanes` counterpart.

## Known divergences from IntelliJ

Pre-date this work. The first two are cosmetic:

- Arrowhead barbs are axis-aligned; IntelliJ rotates them to the
  segment (`SimpleGraphCellPainter.kt:137-144`).
- Terminal stubs reach the row edge; IntelliJ's terminal stubs stop
  short (`SimpleGraphCellPainter.kt:158-161`).

The third is not cosmetic — it clips the message column:

- With `showLongEdges` on, `compactPrintModelLanes` never runs
  (`logPanelHtml.ts`), so full-edge mode keeps raw lane indices. Rank
  is order-preserving and width-shrinking whether or not edges are
  hidden, so this is a deliberate behavioural divergence, not a no-op —
  `computeGraphWidthFromModels` sizes the gutter from the raw max inked
  lane (~46 on bitcoin@1000 → 960px), and `.commit-graph`'s
  `overflow: hidden` at `--graph-width` clips the message column
  exactly the way the Rejected-bridging section above measures at
  840px. Deciding whether to run the packer unconditionally is tracked
  as a follow-up (it changes what the toggle renders and needs its own
  red-first pin and F5); `graphPainter.test.ts`'s unpacked-path pin is
  what would need a deliberate edit if that follow-up lands.

## Honest limits

- The visual test lane (`test/visual`, `npm run test:visual`) has not one
  real graph pixel in it: the specs that touch a graph cell
  (`logRows.visual.test.ts`, rendered through the `mkRowModel()` stubs its
  fixture helper `test/visual/support/gitToolWindowFixture.ts` builds)
  assert text colour against a stub model with lane 0 and zero edges. It stays green through any
  geometry regression in this pipeline; the invariants above, not the
  visual lane, are what cover column packing and seam docking today.
- Long-edge hiding is exercised by two fixtures, not four: bitcoin@1000 emits
  130 arrow stubs in each direction and the synthetic `longEdgeConvergeTopo`
  emits one pair, while `realTopoAnon` at both depths and `selfTopoAnon@125`
  emit none. Every "on all four fixtures" measurement below that touches the
  long-edge layer therefore has the breadth of bitcoin alone, and invariant J
  is vacuous on the three that emit nothing. Arrow counts here are measured
  through the suite's own construction — `generateCommitGraph` with the
  fixture's branchMap, headBranchName and headHash. A bare
  `generateCommitGraph(commits)` reports 132 instead, because without the
  spine anchor a divergent branch seizes lane 0 and the mainline moves: that
  construction is not one the extension ever produces, and no number in this
  document is taken from it.
- The row threshold (`LONG_EDGE_SIZE`) qualifies an EDGE, never each hidden run
  within it. A qualifying edge whose middle is partly inked by another edge on
  the same lane is hidden in whatever contiguous runs are left, and a run is
  hidden only when at least two rows survive the two arrow stubs — below that,
  hiding blanks one row and spends two on arrowheads, so the run is left drawn.
  Both numbers are judgement, not measurement: no fixture produces a run under
  26 rows, so nothing here is evidence about what a short gap looks like.
- The mainline trunk's long stretches are hidden in more windows than under
  merged lane spans. An edge reaching the window's last row with no node on its
  lane there stays whole (it ends in a chevron, not at a parent). A merged
  trunk span reaches the last row, so whenever the window ends OFF the trunk
  that exemption covered the trunk's whole lane; per edge it covers only the
  trunk's final edge. A window that ends ON a trunk commit was never exempt
  either way, so it is unchanged. On intellij-community --all at 12,000 rows,
  which ends off the trunk, this changes the hidden set on 409 rows: the
  trunk's long pass-throughs become arrow-capped gaps and 399 of those rows
  narrow from two columns to one. No row is left blank, and IntelliJ's
  `isEdgeVisibleInRow` hides a long trunk edge too (it asks about one edge and
  knows nothing of lanes). Windows of 1,000 and 3,000 rows of that history
  measure unchanged, which is a fact about where those windows end and what
  they contain, not a guarantee about small windows — and no one has looked at
  the change in a running editor.
- Long-edge hiding reasons in intervals, never row by row: an edge is split
  at the nodes on its lane by binary search, stretches shared by many edges are
  counted once on the node axis, and each lane's undrawn gaps are walked once.
  Its cost follows the edges and nodes plus the rows actually hidden, so many
  merges into one parent do not multiply it — with or without commits of the
  shared lane inside their spans. Unit specs hold 2,000 converging edges to
  within ten times the cost of one, in both shapes, and a property test diffs
  the result against a one-row-at-a-time statement of the rule.
- Whether an edge is off the window is a fact the interval collector records
  (`ILaneInterval.offWindow`) where it creates the continuation, not something
  long-edge hiding infers from where an interval ends.
- Whether a multi-column slant reads to a human eye as one continuous
  line is a judgement call, not a measured quantity. At the widest
  observed case a four-column seam travels 40px across a 12px
  half-row (`DEFAULT_GRAPH_CONFIG.rowHeight` is 24). F5 dogfood of this
  change is owed and has not been done.
- Load-more and scope changes are untested: the print model is fully
  recomputed on every window change, and nothing compares the before
  and after column assignments across a load-more boundary. This was
  named as a blind scenario in this design's own coverage audit and
  dropped out of the effort with no test and no prior record that it
  had. The one measurement that exists points the other way: over five
  window pairs, 0 earlier rows moved under rank against 23 under the
  greedy — **conditioned on the row's raw visible set being unchanged**.
  Keep that clause wherever the figure is quoted; unconditioned, both
  packers move hundreds of rows and the claim is false. That is an
  argument for covering it, not for assuming it is fine: nothing asserts
  it, so this is a follow-up task rather than a permanent gap.
- Invariant K's `countBrokenBoundaries` specifically cannot see the
  straight arm's raw-lane fallback (`straightSeam`'s `byRawLane` branch,
  "Seam docking" above): its ground truth tracks only straight-edge and
  node claims on a raw lane, so whenever the fallback resolves through a
  neighbor-row bend or inked-only occupant — fuzzing shows this happens
  3,413/5,000 times on random topologies (1,346 over the first 2,000 of
  that same sequence, exactly the trials whose painted bytes change under
  ablation) — `countBrokenBoundaries` has no ground truth entry there and
  skips the boundary. The arm is not unverified overall: two
  `laneLinking.test.ts` unit cases pin it directly, and invariant E2
  independently fails on the real bitcoin@1000 fixture when it is
  removed. `countBrokenBoundaries`'s blind spot is real and worth
  knowing, just narrower than "nothing sees it."
- Invariant M's source list (node lane, each edge's `lane`/`fromLane`/
  `targetLane`, `inkedLanes`, `chevronLanes`) is hand-enumerated against
  `IRowPrintModel`'s fields as they exist today. If that interface grows
  a new lane-bearing field, M does not learn about it by construction — it
  has to be added to the witness by hand. K arm 2 (containment) catches
  most of that case anyway, because a lane no source maps keeps its raw
  index and paints past the row's own `svgWidth` — but not if the new
  field's lane also happens to land in `inkedLanes`, since then it IS
  mapped and paints in range. A field that is both unmapped by
  `lanesInRow` and present in `inkedLanes` would escape both checks.
- The slant-histogram measurement ("How steep the slants actually are"
  above) counts every seam's displacement as `|paintedLane - e.lane|`,
  which is correct only because `printModel.ts`'s bend initializers keep
  `lane` aliased to `fromLane` or `targetLane` (`:478-480`, `:501-502`) —
  not because `e.lane` is structurally the endpoint a stamped seam
  measures from. A bend initializer that broke that alias would silently
  mis-measure the histogram, but a broken production alias would not go
  unnoticed — see Seam docking above for what actually catches it and
  what `laneLinking.test.ts` pins instead.
- The identity arm in `straightSeam` ("Seam docking" above) is inert
  today on everything the pipeline emits, and `buildIdentityMaps` still
  pays for it on every repaint regardless: a `Map` plus one template-string
  key per straight edge, 4,133 of them on bitcoin@1000. That cost is
  recorded, not acted on — the arm is retained for the reason
  `printModel.ts:48-63` states, and removing either the arm or the cost
  is a product decision, not something this review batch does.

## Consequences

### Positive

- Order inversions are eliminated by construction (0 across all four
  fixtures) rather than reduced by a better search heuristic.
- Gutter width is unaffected, pinned per fixture at packed max column
  8 / 2 / 1 / 1. H2 cannot establish this on its own (see above); the
  pins are the assertion that would fail if a widening landed.
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
- `test/support/graphInvariants.ts` — E2, H2, I, J, K, L, M.

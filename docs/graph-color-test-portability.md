# IntelliJ graph/color test portability

This document records which of IntelliJ's `platform/vcs-log` graph & color unit
tests we ported to `intellig`, which we did **not**, and — for each
non-portable group — **why**, the **risk** of not having that coverage, the
**benefit** and **effort** of adding it anyway.

## TL;DR

`intellig` reimplements only the **ownership + color** slice of IntelliJ's graph
stack: "which branch/head owns each commit, and therefore what color is its
line/node." It does **not** reimplement IntelliJ's permanent-graph engine (BEK
linearization, fragment collapsing, print-element generation, the compressed
int-map data structures). So the portable tests are the ones that pin the
ownership/color rule; the rest exercise machinery that does not exist here, and
porting them would mean testing code we never wrote.

We ported the behavior-defining core **verbatim** and it passes bit-for-bit,
including `java.lang.String.hashCode()` parity for the branch color seed.

## What we ported (done)

| Upstream test                                                                                                           | Ported to                                             | Fidelity                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permanent/GraphLayoutBuilderHeadOrderTest.kt`                                                                          | `test/unit/graph/graphLayoutBuilderHeadOrder.test.ts` | **Verbatim** — same graphs, head sets, comparators, expected head-ownership arrays.                                                                                                                                                                                           |
| `permanent/GraphLayoutBuilderTest.java`                                                                                 | `test/unit/graph/graphLayoutBuilder.test.ts`          | **Intent port** — the upstream test is fixture-file driven (`layoutBuilder/*.txt` + a serialized-layout diff); we assert the same observable properties (per-node layout index, important-heads list) on equivalent graphs instead of porting the fixture files + serializer. |
| `GraphColorManagerImpl` / `GraphColorGetterByHead` (no dedicated upstream unit test — exercised via the print pipeline) | `test/unit/graph/graphColorManager.test.ts`           | **New** test pinning the ported rule + `javaStringHashCode` parity.                                                                                                                                                                                                           |

To run those ported tests against real code we ported the engine itself:

- `src/git-core/graph/graphLayout.ts` — `GraphLayoutBuilder` + `GraphLayoutImpl`
- `src/git-core/graph/dfsUtil.ts` — `DfsUtil.walk`
- `src/git-core/graph/graphColorManager.ts` — `GraphColorManagerImpl` + the head color getter

These are faithful, executable references for IntelliJ's algorithm. The
production color core (`branchColors.ts`) is a specialization of the same rule
(IntelliJ tier ordering + topmost-first tiebreak); its own tests
(`branchColors.test.ts`) assert the product-level behavior.

> Follow-up option: route `branchColors.ts` ownership through
> `buildGraphLayout` (using first-parent-only down-edges so it reproduces the
> current walk exactly) so the ported engine becomes load-bearing rather than a
> reference. Benefit: one ownership implementation, parity guaranteed by
> construction. Effort: ~half a day incl. re-verifying every `branchColors`
> test. Risk: medium (must preserve the just-shipped tuned palette/ownership).

## What we did **not** port

Legend — **Risk** = risk of having no port; **Benefit**/**Effort** = of adding one.

### 1. BEK / LinearBek linearization

`linearBek/BekTest.kt`, `LinearBekTest.kt`, `LinearBekExpandTest.kt`, `TestUtils.kt`

- **Why not portable:** BEK is IntelliJ's optional graph-_re-sorting_ layout that
  pulls merged branches together for a compact picture. `intellig` renders the
  raw first-parent/topological order returned by `git log` — there is no BEK
  transform to test.
- **Risk of no coverage:** None for current behavior — we have no BEK code to
  regress.
- **Benefit of adding:** Only realized if we ever implement BEK-style
  linearization; then these become the spec.
- **Effort:** Very high — porting BEK requires porting the whole linearization
  algorithm first. Not worth it unless the feature is requested.

### 2. Print-element generation

`impl/print/PrintElementGeneratorTest.kt`, `EdgesInRowTest.java`, `print/TestGraphBuilderTest.kt`

- **Why not portable:** These turn the abstract graph into drawable elements
  (node circles, edge segments, per-row coordinates) for IntelliJ's Swing
  painter. `intellig` has its own renderer (`printModel.ts` + `graphPainter.ts`)
  emitting SVG with different geometry and a different API; the expected
  coordinates/elements don't transfer.
- **Risk of no coverage:** Low–medium. Rendering bugs (gaps/seams/colors) are
  the most user-visible. This area is **already** covered by our own
  `printModel.test.ts`, `printModelSeamContinuity.test.ts`, and the graph
  property tests.
- **Benefit of adding:** Marginal — would duplicate existing intellig-specific
  coverage against a foreign coordinate model.
- **Effort:** High — would require a translation layer between the two
  print models.

### 3. Fragment collapsing / filtered ("dotted") edges

`impl/DottedFilterEdgesGeneratorTest.kt`, `InplaceFilterEdgesGeneratorTest.kt`, `FragmentGeneratorTest.kt`

- **Why not portable:** IntelliJ can collapse a linear run of commits into a
  single "dotted" edge and expand it on demand (and recompute edges when commits
  are filtered out). `intellig` does not collapse fragments — filtering reloads
  the log.
- **Risk of no coverage:** None — no equivalent feature.
- **Benefit of adding:** Only if we add collapsible fragments.
- **Effort:** High (feature + tests).

### 4. Permanent-graph construction & hash indexing

`impl/permanent/GraphBuilderTest.kt`, `GraphBuilderHashIndexTest.java`, `impl/EdgeStorageTest.kt`

- **Why not portable:** These build IntelliJ's `PermanentLinearGraph` from a
  commit list and index commits by hash into JVM-specific compressed structures.
  `intellig` builds its model in `optimizedCommitGraph.ts`/`commitGraph.ts` with
  plain JS structures.
- **Risk of no coverage:** Medium — graph construction errors (wrong parents,
  missing edges) corrupt everything downstream. Mitigated by our
  `logGraphAccuracy` / `graphLaneContinuity` property tests, which assert the
  built graph matches `git log` output.
- **Benefit of adding:** Some — a focused construction test is cheap insurance.
- **Effort:** Low–medium **if** retargeted to intellig's builder API (not a
  direct port; the expected outputs differ).

### 5. First-parent facade

`impl/facade/FirstParentTest.kt`

- **Why not portable:** Tests IntelliJ's `FirstParentController` (a toggleable
  "first-parent only" _view_ over the permanent graph). `intellig`'s coloring
  walk is already first-parent, but there is no equivalent toggleable controller
  API to drive.
- **Risk of no coverage:** Low — first-parent ownership IS covered by the ported
  `GraphLayoutBuilderHeadOrderTest` + `branchColors` tests.
- **Benefit of adding:** Low.
- **Effort:** Medium (would need the controller abstraction).

### 6. Containing-branches

`impl/permanent/ContainingBranchesTest.java`

- **Why not portable:** IntelliJ computes "which branches contain commit X" by
  walking the in-memory graph (`ContainingBranchesGetter`). `intellig` has the
  _feature_ but delegates to `git branch --contains` (see `BranchOps`,
  `gitParser`), so there is no in-graph algorithm to test — git is the oracle.
- **Risk of no coverage:** Low — correctness is git's, and our git parsing is
  covered elsewhere.
- **Benefit of adding:** Low for the algorithm; a small e2e on the feature is
  more valuable than porting this unit test.
- **Effort:** N/A as a direct port (would require reimplementing the in-graph
  algorithm we deliberately don't have).

### 7. Low-level data-structure & utility tests

`utils/BfsTests.kt`, `BitSetFlagsTest.java`, `GraphUtilTests.kt`, `IntIntMultiMapTest.kt`, `ListIntToIntMapTest.java`, `PermanentListIntToIntMapTest.java`, `TreeIntToIntMapTest.java`, `UnsignedBitSetTest.java`, `UpdatableIntToIntMapTest.java`

- **Why not portable:** These test JVM-specific compressed int→int maps, bitsets
  and BFS helpers that exist to make IntelliJ's engine memory-efficient.
  `intellig` uses plain `Array`/`Map`/`Set`; there is no equivalent code.
- **Risk of no coverage:** None — nothing here to regress.
- **Benefit of adding:** None unless we introduce such structures (we have no
  reason to).
- **Effort:** Low to port mechanically, but it would be **test-only code with no
  subject** — net negative (maintenance with no protected behavior).

### 8. Test infrastructure / parsers (not behaviors)

`parser/*`, `AbstractTestWithTextFile(.java)`, `AbstractTestWithTwoTextFile.java`, `GraphStrUtils.java`, `StrUtils.kt`, `TestGraphBuilder(.kt)`, `TestGraphs.kt`, `CommitIdManager.java`, `SimpleCommit.java`

- **Why not portable:** These are harness/fixtures, not tests of behavior. We
  reproduced only the tiny slice we needed (the `graph { … }` adjacency DSL) as
  a local helper in the ported tests.

## Recommendation

The behavior that actually governs **what the user sees** — branch ownership and
color — is now locked to IntelliJ by verbatim/equivalent ports and passes
exactly. The remaining upstream tests cover engine layers `intellig` does not
implement; porting them would mean either building those features first
(items 1, 3) or writing test-only code with no subject (item 7).

If we want incremental parity insurance beyond what's done, the best
return-on-effort, in order:

1. **Wire `branchColors.ts` onto `buildGraphLayout`** (follow-up above) — turns
   the ported engine load-bearing. Low/medium effort, high confidence payoff.
2. **A focused graph-construction test** retargeted to intellig's builder
   (item 4) — cheap insurance for a downstream-critical step.

Everything else is not worth the effort at current scope.

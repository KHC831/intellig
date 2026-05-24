# ADR-010: Visual parity discipline

Status: Accepted (2026-05-24)

## Context

Wave D shipped two user-visible Git-tool-window log-graph fixes
(divergent-branch lane collapse + branch focus on graph). Pre-Wave-D
review caught no behaviour regressions because the existing test
surface — Mocha unit tests + property tests — covered algorithmic
correctness against synthetic fixtures and code-shape against
structural guards (ADR-007), but did NOT cover visual outputs.

The divergent-branch bug (Wave D Gap 1) shipped past 13 existing
behavioural tests because none of them pinned the `graphColumn` of
the SECOND child of an unseen parent — only that the merge had two
graph lines, that the row count matched, that the lane count was
some-number-greater-than-one. A reviewer or a property test would
need to know to ask "is `tipB` in lane 1 or lane 0?" — exactly the
kind of question pre-formatted assertions are bad at.

The branch-focus feature (Wave D D2 + D3) is even harder to cover
without visual checks: the right behaviour is "the right chip is
outlined, the right SVG strokes are bold, the right opacities apply,
nothing else changed." That is a comparison against an IntelliJ
reference image — not a unit test.

Before Wave D this comparison happened informally: a developer ran
the extension via F5, opened the tool window, eyeballed the result
against IntelliJ, and signed off. Two problems with that flow:

1. **Asymmetric coverage**: small algorithmic deviations are visible
   to the eye but invisible to the existing test suite, so they ship
   green-CI.
2. **No reference**: each developer had their own mental model of
   what IntelliJ's log graph looks like. Disagreements were resolved
   by re-running IntelliJ and squinting. There was no canonical
   reference document.

## Decision

Three parity-discipline layers are now table stakes for every
Git-tool-window UI change. Future parity waves are expected to apply
the same pattern to their domain.

### Layer 1 — Visual snapshot tests

Frozen-literal snapshot tests for any algorithm whose output
ultimately drives a visual layout (lane assignments, chip rendering,
graph line topology, focused-path tagging).

Pattern: a Mocha file under `src/test/unit/.../*.snapshots.test.ts`
with `assert.deepStrictEqual(snapshotOf(result), expectedFrozenLiteral)`.
NO `--update-snapshots` flag opacity — when a developer changes the
algorithm legitimately, they update the inline literal explicitly,
and reviewers see the visual diff in the PR.

The Wave D seed: `src/test/unit/utils/commitGraphSnapshots.test.ts`
with five fixtures (linear baseline, divergent two-children,
three-way fork, merge with branches at both parents, focus state).

> **Multi-stage snapshot discipline (Wave D R1 / TLD-L-1+L-2)**:
> visual outputs typically pass through multiple stages (algorithm
> → renderer → HTML markup). Each stage must be independently
> snapshotted so a refactor that changes one stage's representation
> while preserving the next stage's output still surfaces as a
> deliberate diff. Wave D R1 added snap-6a/6b/6c — renderer-stage
> snapshots that pin the SVG emission shape (`opacity="0.6"` /
> `opacity="1"` / `stroke-width="3"`) — alongside the algorithm-
> stage snap-1..5. A future migration that swaps per-element
> attributes for CSS classes will update the snap-6 expecteds
> explicitly.

### Layer 2 — UX-review checkpoint

Every parity-targeted UI feature gets a UX-review pass against the
parity reference doc (Layer 3) before senior + tech-lead re-review.
The UX reviewer:

- Describes how to manually trigger the feature
- Compares rendered behavior to the parity reference
- Returns a verdict: VISUAL-PARITY / VISUAL-DRIFT-X (with X
  pointing at a specific section of the parity doc)

Team-lead spawns the UX reviewer; the coder reports DONE with
synthetic fixture / repro instructions the reviewer can use.

> **Operational note (Wave D / Wave D R1)**: this wave shipped using
> a generic agent with the UX-review charter inlined as the prompt.
> A dedicated role config at `~/.claude/agents/ux-reviewer.md` is
> owed (Wave E or an infra wave); the inline-charter pattern is the
> current production path until the role is properly defined. The
> charter itself ("describe trigger / compare to parity doc /
> verdict") is stable and should port directly when the agent
> definition lands.

### Layer 3 — `docs/parity/<feature>.md` reference doc

A canonical living document per UI feature describing IntelliJ's
reference behaviour. Sections:

- Lane / element structure with ASCII or descriptive diagrams
- Render rules (CSS classes, opacity, stroke widths)
- Trigger / state machine for interactive features
- Cross-references to the relevant ADRs

The doc is what UX-review verifies against AND what future parity
waves cite as the spec. Updates to this doc precede implementation
changes — write the spec first, walk the code forward.

The Wave D seed: `docs/parity/git-log-graph.md`.

## Consequences

### Positive

- Visual regressions get caught in unit tests (Layer 1) before review.
- A canonical reference exists for both reviewers and future
  contributors (Layer 3); no more "eyeball IntelliJ" debates.
- The UX-review checkpoint (Layer 2) closes the gap between green CI
  and "actually looks right."
- Future parity waves get a template: write the parity doc, snapshot
  the algorithm output, dispatch UX-review.

### Negative / costs

- Snapshot tests have to be updated whenever the algorithm legitimately
  changes; the inline-literal approach makes this a deliberate visible
  diff, not a one-flag-update.
- Layer 3 reference docs are living documents; staleness is a real
  risk. Tied to the implementation update cadence to mitigate.
- UX-review adds a sequence step before senior + tech-lead. Worth it
  for parity-targeted UI; out of scope for non-UI features.

### Neutral

- Layer 1 reuses the existing Mocha + `assert.deepStrictEqual`
  primitives — no new framework, no new harness.
- Layer 3 lives alongside ADRs (`docs/parity/`) so they're discovered
  by the same `docs/` browse path.

## Alternatives considered

### Visual regression testing via screenshots

A pixel-diff harness (e.g. Playwright + visual-snapshots) would
catch any visual drift, including pure CSS changes. Rejected because
the VS Code webview is rendered inside an Electron host that itself
varies across versions, the CI runner lacks a deterministic
rasterizer, and the reviewer cost of triaging false positives outweighs
the regression-catch payoff at our scale. Layer 1's algorithmic
snapshot is a coarser but cheaper proxy.

### Storybook-style visual catalog

A separate webview that renders every fixture for in-browser visual
review. Rejected because the IntelliJ reference is the spec, not a
catalogue of accepted outputs; the parity doc + snapshot tests already
serve the same comparison need without duplicating the surface.

## References

- ADR-007 — Structural guards as a complementary tool. Layer 1
  snapshots are the visual-output analogue of structural guards.
- ADR-009 — Webview state ownership. The `updateBranchFocus` surface
  added in Wave D is documented in ADR-009 §3.
- `src/test/unit/utils/commitGraphSnapshots.test.ts` — Wave D seed
  for Layer 1.
- `docs/parity/git-log-graph.md` — Wave D seed for Layer 3.

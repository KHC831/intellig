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

> **Wave E discipline-tightening — output snapshots, not input
> snapshots**: a snapshot of an algorithm's OUTPUT data structure
> is NOT a snapshot of the rendered HTML. Wave D R1's multi-stage
> rule generalises to a stricter test: **if a function emits HTML
> (or any string consumed by a UI layer), the snapshot must include
> the literal emitted output, not just the function's input data**.
> Wave D's `commitGraphSnapshots.test.ts` snap-3 captured
> `node.branches: ['main']` — the algorithm-stage value — but did
> NOT exercise `_getBranchLabelsHtml(node)`. Wave E's bug (chips
> don't render in narrow panels) lived entirely in the chip-emit +
> CSS layout layers, both of which were untested. Wave E adds:
> - **Chip-emit-stage snapshots** (snap-7a..7e) asserting the
>   literal HTML span output of `_getBranchLabelsHtml`
> - **Layout-stage snapshot** (snap-7f) using jsdom to assert the
>   chip is reachable in the DOM tree at the expected position
>   (sibling of `.commit-title`, not a descendant)
> - **Message-text snapshot** (snap-7g) asserting the row's
>   `.commit-title` text content is the full first line (no JS
>   truncation), so CSS — not JS — controls the responsive ellipsis
>
> The discipline now reads: **algorithm → renderer (per-element)
> → renderer (layout) → final HTML emit**. Each stage is
> independently snapshotted; a refactor at any stage that doesn't
> preserve the next stage's output triggers a deliberate diff.

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

> **Wave E discipline-tightening — runtime verification REQUIRED**:
> Wave D shipped a chip-rendering bug past a VISUAL-PARITY verdict
> because the UX-reviewer performed a code audit (read the
> implementation, compared to the parity doc) without runtime
> verification. From Wave E onward, the UX-review verdict MUST
> include AT LEAST ONE of:
>
> 1. **F5 dogfood with screenshot** — preferred. Reviewer launches
>    the extension, exercises the feature, captures a screenshot,
>    attaches to the verdict. The screenshot is the artifact.
> 2. **jsdom-rendered HTML test** — the reviewer writes (or cites)
>    a test that synthesises the rendered HTML for the feature and
>    asserts on the visual claim (e.g. `assert.ok(chip.parentElement
>    .classList.contains('commit-branches'))` for chip placement).
>    `commitGraphSnapshots.test.ts` snap-7f is the canonical
>    template for this form.
> 3. **Explicit cannot-F5 declaration** — only acceptable when the
>    runtime environment is genuinely unavailable. Reviewer must
>    write: `I cannot F5 (reason); the visual claim "<X>" is
>    verified by snap-<id> in <file>; the parity doc citation is
>    <section>.` This forces the discipline to make the snapshot
>    back-reference (Layer 3) mandatory in advance.
>
> A code audit alone is INSUFFICIENT. The Wave D failure was the
> canonical example: the parity doc said "chips render to the right
> of the message," the implementation looked right at every layer
> the reviewer inspected, and the rendered output did not match.
> Without runtime or rendered-HTML verification, the gap is invisible.

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

> **Wave E — snapshot back-references**: each visual claim in a
> parity doc that maps onto an algorithm/renderer/HTML output must
> cite the corresponding snapshot test that pins it. Format:
> `(see snap-Nx in commitGraphSnapshots.test.ts)`. Wave E updates
> `docs/parity/git-log-graph.md` §2 to cite snap-7a..7f for chip
> rendering; future parity docs include this back-reference style
> by default. Combined with the cannot-F5 declaration form above,
> the back-reference makes "verified by test" a first-class
> sign-off mode rather than an unstated fallback.

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
  for Layer 1; Wave E adds snap-7a..7g (chip-emit, jsdom layout,
  message-text full-line emission); Wave E R1 adds snap-7h
  (chip max-width + ellipsis CSS contract).
- `docs/parity/git-log-graph.md` — Wave D seed for Layer 3; Wave E
  adds snap-back-references in §2.

## Update log

- **Wave D (2026-05-24)**: original Layers 1–3 (algorithm snap-1..5,
  renderer snap-6a..6c, parity doc seed, UX-review charter).
- **Wave E (2026-05-24)**: tightened Layer 1 to require literal-output
  snapshots whenever a function emits HTML (snap-7a..7e for
  `_getBranchLabelsHtml`); added a layout-stage snapshot via jsdom
  (snap-7f); tightened Layer 2 to require runtime verification
  (F5 / jsdom test / explicit cannot-F5 declaration); tightened
  Layer 3 to require snapshot back-references in parity-doc visual
  claims. Trigger: Wave D shipped a chip-clipping bug past green
  CI + VISUAL-PARITY verdict because the existing snapshots only
  pinned algorithm input, the UX-review was a code audit without
  runtime check, and the parity doc had no snapshot back-references.

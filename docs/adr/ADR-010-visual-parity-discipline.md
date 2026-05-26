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

### Layer 4 — Repo-state coverage

Layers 1–3 close the gap between *algorithm output* and *rendered
visual* for the **default** repo state (clean working tree, attached
HEAD on a normal branch). Wave F surfaced the next gap: features that
look correct against the default state can fail catastrophically when
the repo is in a non-default state.

The Wave F production bug — "Branches → New Branch From here" failed
with `fatal: '(HEAD detached at 5eed84b)' is not a commit` — shipped
past three Layer-1 snapshot fixtures, a UX-review pass, and senior +
tech-lead sign-off because every test fixture and every reviewer
screenshot used a repo with attached HEAD. Git's `branch -a --format`
output shape is materially different in detached HEAD / mid-rebase /
mid-bisect / mid-cherry-pick states (it emits parenthesized
pseudo-refs like `(HEAD detached at <sha>)`), and that shape was
absent from the test surface.

Layer 4 makes the repo-state input space explicit:

1. **Repo-state landmap** — every parity-targeted feature must enumerate
   its behaviour across the canonical non-default states in
   `docs/parity/repo-states.md` §0 at-a-glance table. The states
   covered today are: default, detached HEAD, in-progress merge,
   in-progress rebase, in-progress cherry-pick, empty repo. New
   features mark each row as covered / partially covered / NOT
   covered, with a Wave-N citation when the gap is in scope.
2. **Repo-state fixtures** — each non-default state that the feature
   claims to support gets at least one Layer-1 snapshot fixture (or
   property-test invariant) wired through the same parser → renderer
   → HTML chain. Wave F's seed: `parseBranches-detached-1..5` +
   snap-8a + snap-8b for the detached-HEAD state.
3. **Repo-state cite in parity doc** — the §1.x section for each state
   in `docs/parity/repo-states.md` carries the same snapshot
   back-reference shape Layer 3 mandates: `(see snap-Nx in <test>)`.
   The combination — landmap + fixtures + back-references — makes the
   repo-state coverage auditable from the parity doc alone.

The discipline now reads: **(input space) repo-state landmap →
(algorithm) snap-N → (renderer per-element) snap-N → (renderer layout)
snap-N → (final HTML emit) snap-N**. A regression at any stage in any
covered state surfaces as a deliberate diff.

> **Wave F seed**: `docs/parity/repo-states.md` §0 enumerates 6
> repo states (default, detached HEAD, in-progress merge / rebase /
> cherry-pick, empty repo). Wave F covers detached HEAD only (§1);
> the remaining states are flagged "NOT covered, Wave G candidate"
> in the §0 at-a-glance table so future waves can pick them up
> without re-deriving the landmap.

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
- `docs/parity/repo-states.md` — Wave F seed for Layer 4 (repo-state
  landmap + detached-HEAD §1).
- `src/utils/gitParser.ts` `parseBranches` — Wave F filter for git's
  parenthesized pseudo-refs; covered by `parseBranches-detached-1..5`,
  snap-8a, snap-8b, and the `parseBranches.property.test.ts` property.

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
- **Wave F (2026-05-24)**: established Layer 4 (repo-state coverage).
  Every parity-targeted feature now enumerates its behaviour across
  the canonical non-default states (detached HEAD, in-progress merge
  / rebase / cherry-pick, empty repo) in `docs/parity/repo-states.md`
  §0 at-a-glance table; each covered state gets at least one Layer-1
  snapshot or property-test invariant; the parity-doc state section
  carries snapshot back-references. Wave F seeds the layer with the
  detached-HEAD entry (parseBranches filter for parenthesized pseudo-
  refs, snap-8a chip-emit + snap-8b branch-tree, plus a fast-check
  property). Trigger: Wave A–E feature work tested only against the
  default repo state; Wave F's user dogfood found "Branches → New
  Branch From here" crashing in detached HEAD because none of three
  algorithm-stage snapshots, the UX-review pass, or the senior +
  tech-lead reviews exercised the detached input shape. Layer 4
  makes the repo-state input space first-class.
- **Wave G (2026-05-25)**: extended Layer 4 (repo-state coverage) with
  §1.5 — HEAD chip rendering. Trigger: Wave F's detached-HEAD parser fix
  closed the "Failed to create branch" crash, but user dogfood surfaced
  a downstream gap: in detached HEAD the user has no visual indicator
  of where HEAD lives. The chip-rendering pipeline (Wave A → D → E)
  produced empty chip slots for detached commits because no branch
  pointed there. Wave G adds a yellow/gold HEAD chip rendered on the
  commit pointed at by `repo.head?.commit`, prepended FIRST to the
  `.commit-branches` slot (IntelliJ parity); pinned by snap-9a..9f.
  Also fixes a stale-HEAD-chip race by adding
  `gitService.reloadRepository(repo)` to every CLI mutation site so
  `provider.refresh()` runs against fresh state instead of racing the
  watcher's 250 ms debounced reload.
- **Wave H (2026-05-25)**: extended Layer 4 (repo-state coverage)
  with §1.6 — branch tree detached row. Trigger: Wave G closed the
  graph-side detached HEAD gap (yellow/gold HEAD chip on the commit
  row), but user dogfood surfaced that the BRANCHES tree sidebar
  showed nothing for detached state — no current-branch indicator,
  no row pointing at HEAD. Wave H adds a new `'detached-head'`
  `BranchTreeItemType` variant rendered at the TOP of Local Branches
  with the same yellow/gold theme variable
  (`statusBarItem.warningBackground`) Wave G uses for the graph chip.
  Right-click menu shows Checkout + New Branch from Here, matching
  IntelliJ parity. Dispatcher reads the 40-char SHA via
  `getDetachedHeadSha()` so the parenthesized label never reaches
  git (Wave F regression class). Pinned by snap-10a (jsdom layout) +
  branchTree-detached-1..5 (state variants) + checkout-detached /
  newBranchFrom-detached (dispatcher safety). Bonus: Wave H's
  multi-fixture mock construction triggered the rule-of-three
  threshold for the IGitService mock (Wave F TLF-N3 watch flag);
  extracted to `src/test/mocks/mockGitService.ts` and updated the
  three pre-existing call sites (snap-8b, headChipRefresh.test.ts,
  Wave H's new fixtures).
- **Wave I (2026-05-26)**: post-Wave-H comprehensive review surfaced 8
  security/correctness findings (1 CRIT + 4 HIGH + 2 MED + 5 LOW)
  ranging from an argv-injection-by-ref-name boundary
  (`--upload-pack=evil` landing as a flag in ~15 GitService methods),
  the parseLog `|` separator collision with author names containing
  `|`, the leaked `BranchTreeProvider.onDidChangeRepository`
  subscription, the secondary-service GitCli fragmentation that hid
  `git rebase` / `git stash` / `git blame` calls from the
  ConsoleService back-channel, the workspace-wide BlameService
  watcher (`**/*` glob), the CommitDialog inline-onclick CSP
  exposure, plus 5 hygiene-tier issues (unescaped data-hash, lax
  branch-name validator, unvalidated stash-index, `\n`-split
  compareBranches diff, predictable `Math.random()` ids). Wave I
  bundles all 8 as one coherent ship across 8 atomic commits with
  TDD red→green proof per commit. Layer 1 (snapshot) gained zero
  new fixtures; Layer 2 (UX review) and Layer 3 (`docs/parity/`)
  were unchanged. The visible-parity surface was untouched — every
  finding was internal hygiene or a defense-in-depth seam, so this
  Wave's contribution is to the OTHER columns of the parity-coverage
  matrix (security + back-channel diagnostics + lifecycle hygiene).
  Pinned by gitArgInjection.property.test.ts (200-run fast-check
  property), GitServiceArgInjection.test.ts (~15 method-level
  characterizations), parseLog-separator-1..2 (`\x1f` round-trip),
  branchTree-dispose-1..3 (subscription teardown), consoleCapture-1..3
  (back-channel), blameWatcher-1..2 (RelativePattern), and
  commitDialog-csp-1 / -delegation-1..2 (data-action shape).

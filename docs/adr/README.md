# Architecture Decision Records

This directory holds the Architecture Decision Records (ADRs) for
IntelliG. An ADR captures one decision plus the context, alternatives
considered, and consequences. ADRs are append-only: superseded
decisions stay on disk, with a `Superseded by ADR-NNN` link in the
status block.

## Index

Grouped topically (the index passed ~12 entries). Supersession edges
render inline as `ADR-NNN → ADR-MMM` next to the superseded entry; no
chain exists yet — every ADR below is in force.

### Core architecture & lifecycle

- [ADR-001](ADR-001-igitservice-composite-freeze.md) — Accepted —
  IGitService composite interface freeze
- [ADR-002](ADR-002-module-level-singletons-in-utils.md) — Accepted —
  Module-level singletons in `src/utils/`
- [ADR-008](ADR-008-watcher-families.md) — Accepted —
  Watcher families and the cleanup-registry pattern
- [ADR-012](ADR-012-topical-source-tree.md) — Accepted —
  Topical `/src` source tree restructure (move `src/services/**`
  into topic folders). The decision remains in force; the one-time
  migration is complete and its Migration_Resources are retired.

### Data safety

- [ADR-003](ADR-003-storage-forward-compat-round-trip.md) — Accepted —
  Storage forward-compat round-trip
- [ADR-004](ADR-004-atomic-write-routing.md) — Accepted —
  Atomic-write routing policy

### Errors & logging

- [ADR-005](ADR-005-sanitizer-pass-ordering.md) — Accepted —
  Sanitizer pass ordering
- [ADR-006](ADR-006-error-state-binding-by-view-type.md) — Accepted —
  Error-state binding by view type
- [ADR-011](ADR-011-structured-logger.md) — Accepted —
  Structured logging facade (Logger, sinks, correlation IDs,
  sanitization) conforming to ADR-002

### UI & graph

- [ADR-009](ADR-009-webview-state-ownership.md) — Accepted —
  Webview state ownership: host leads, JS follows
- [ADR-010](ADR-010-visual-parity-discipline.md) — Accepted, amended
  2026-07-03 (parity reference docs retired with the IntelliJ unpin;
  snapshot tests + UX review remain binding) — Visual parity
  discipline
- [ADR-013](ADR-013-graph-data-model-invariants.md) — Accepted —
  Commit graph data model (`IGraphLine` / `ICommitNode`) and
  lane-algorithm invariants (spec 8 L1 lane stability + HEAD-ancestry
  promotion, spec 8 L9 dashed off-window stub, spec 8 L4 same-lane stroke
  color), pinned by property + unit tests in
  `test/property/laneStabilityAcrossReload.property.test.ts`,
  `test/property/headAncestryPromotion.property.test.ts`, and
  the "Phase 1a pins" suite in
  `test/unit/utils/commitGraph.test.ts`.
- [ADR-014](ADR-014-ui-primitive-selection.md) — Accepted —
  UI primitive selection: webview only for the commit graph; native
  primitives (QuickPick, TreeView + context menus, SCM API, native
  modals) for menus, popups, dialogs, and commit/staging. The
  commit-row context menu is the one inherent hand-rolled exception.
- [ADR-016](ADR-016-graph-column-packing.md) — Accepted —
  Graph column packing by per-row rank (replaces the order-destroying
  cluster/interval packer), plus seam docking across a lane's own
  column changes at a row boundary. Downstream of ADR-013's frozen
  data model; pinned by invariants E2, H2, I, J, K in
  `test/support/graphInvariants.ts`.

### Enforcement & process

- [ADR-007](ADR-007-structural-guards-as-complementary-tool.md) —
  Accepted — Structural guards as a complementary tool

### Build & packaging

- [ADR-015](ADR-015-bundled-extension-host.md) — Accepted —
  Bundled extension host (esbuild `dist/extension.js`, no
  node_modules in the .vsix, Monaco as a copied media asset,
  `check:vsix-clean` verifies the runtime manifest)

## Status legend

- **Accepted** — in force; current code reflects the decision.
- **Proposed** — under discussion; not yet binding.
- **Superseded** — replaced by a later ADR; the superseding ADR's
  number is recorded in the original ADR's status block.
- **Deprecated** — the decision no longer applies (component removed
  or context changed); kept on disk for historical reference, but
  consult later ADRs / current code for present-day guidance.

## Adding a new ADR

1. Copy the most recent ADR as a template.
2. Use the next sequential number (`ADR-008-...`).
3. Fill in: Status, Context, Decision, Consequences, Alternatives,
   References. Keep it short — one decision per ADR.
4. Append the new entry to the index above in this `README.md`.
5. Land the ADR alongside the code change that implements (or
   pins) the decision so reviewers see them together.

Keep the index grouped topically (add a group only when an ADR fits
none of the existing ones), and render supersession edges inline next
to the superseded entry (e.g. `ADR-003 → ADR-019`) so chains stay
visible without clicking through.

# Architecture Decision Records

This directory holds the Architecture Decision Records (ADRs) for
IntelliG. An ADR captures one decision plus the context, alternatives
considered, and consequences. ADRs are append-only: superseded
decisions stay on disk, with a `Superseded by ADR-NNN` link in the
status block.

## Index

- [ADR-001](ADR-001-igitservice-composite-freeze.md) — Accepted —
  IGitService composite interface freeze
- [ADR-002](ADR-002-module-level-singletons-in-utils.md) — Accepted —
  Module-level singletons in `src/utils/`
- [ADR-003](ADR-003-storage-forward-compat-round-trip.md) — Accepted —
  Storage forward-compat round-trip
- [ADR-004](ADR-004-atomic-write-routing.md) — Accepted —
  Atomic-write routing policy
- [ADR-005](ADR-005-sanitizer-pass-ordering.md) — Accepted —
  Sanitizer pass ordering
- [ADR-006](ADR-006-error-state-binding-by-view-type.md) — Accepted —
  Error-state binding by view type
- [ADR-007](ADR-007-structural-guards-as-complementary-tool.md) —
  Accepted — Structural guards as a complementary tool
- [ADR-008](ADR-008-watcher-families.md) — Accepted —
  Watcher families and the cleanup-registry pattern
- [ADR-009](ADR-009-webview-state-ownership.md) — Accepted —
  Webview state ownership: host leads, JS follows

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

Once the index exceeds ~12 entries, switch to topical grouping
(Storage / Lifecycle / UI / …) and render supersession edges inline
in the index (e.g. `ADR-003 → ADR-019`) so superseded chains stay
visible without clicking through.

# ADR-003: Storage files round-trip unknown fields

Status: Accepted (2026-05-12)

## Context

Two services persist user state as JSON on disk: `ChangelistService`
(changelists + per-item metadata) and `ShelfService` (shelved diffs + per-
file metadata). Both files are read at activate and written after every
mutation. Both files may be read by more than one running version of the
extension: a user who updates from an older build, or who runs two VS
Code windows at different versions (a stable and an insider), will have
the older version read a file that the newer version wrote.

The natural shape — define `IStorage` as a typed interface, deserialize
into that interface, serialize back — silently drops any key the current
build doesn't know about. If a newer build adds a `labels` array to a
changelist and the user opens the same workspace in an older build, the
older build reads the JSON, ignores `labels`, writes its own shape back,
and the labels are gone forever. That is data loss the user cannot
recover from without re-doing work in the newer build.

## Decision

Every persisted JSON shape is split into two halves: the typed shape
the code actually uses, and a catch-all bag of unknown keys captured at
parse time and re-emitted at write time.

The mechanics are identical across services:

- A `KNOWN_*_KEYS_SPEC` object lists every known key, one per line,
  with a `satisfies` clause against
  `Record<Exclude<keyof IShape, '_unknownBag'>, true>`. The build breaks
  if a new key is added to the interface without being added to the spec.
- `KNOWN_*_KEYS` is the runtime `Set<string>` derived from the spec's
  keys. Parsing partitions the JSON into "known" (goes into the typed
  shape) and "unknown" (goes into `_unknownBag`).
- On serialize, `_unknownBag` is spread back into the top level (or into
  the per-item level, or into the per-file level — each boundary gets
  its own bag). The resulting JSON carries every field the newer build
  wrote, even though the older build has no code path that reads them.

The bag name is prefixed with `_` and suffixed with its boundary:
`_unknownTopLevel`, `_unknownItem`, `_unknownFileField`. The underscore
is a visibility signal: these fields are in-memory bookkeeping, never
themselves deserialized from a bag. The `Exclude<...>` in the spec's
`satisfies` clause enforces exactly that.

## Consequences

### Positive

- An older build cannot silently drop fields a newer build persisted.
  The round-trip is lossless for any additive schema change.
- Schema migrations become additive: a newer build adds a new known key,
  older builds pass it through via the bag, and the system converges
  without a versioned-file migration step.
- The `satisfies` clause makes "add a key to the interface, forget to
  add it to `KNOWN_*_KEYS_SPEC`" a compile error rather than a
  silently-drop-on-save runtime bug.

### Negative / costs

- Every service that adopts this pattern pays the same ~30 lines of
  boilerplate (spec object, derived set, partition on parse, spread on
  serialize). When a fourth adopter lands it becomes worth extracting
  a shared `partitionKnown` / `spreadKnown` helper; until then, the
  duplication is intentional (different services have slightly
  different bag shapes and the abstraction-too-early cost outweighs the
  repeated boilerplate).
- The pattern does **not** protect against destructive schema changes.
  If a newer build _removes_ a key, or changes an existing key's
  semantics, the round-trip will still be lossy in the direction the
  change specifies. The guarantee is only against additive changes.

### Neutral

- Users see no UI difference. The bag is invisible unless they open the
  file in a text editor, and even then it looks like a straightforward
  nested JSON object.

## Example

```ts
// Parse
const parsed = JSON.parse(content) as Record<string, unknown>;
const unknownTopLevel: Record<string, unknown> = {};
const known: Partial<IStorage> = {};
for (const k of Object.keys(parsed)) {
  if (!KNOWN_TOP_LEVEL_KEYS.has(k)) {
    unknownTopLevel[k] = parsed[k];
  } else {
    // ...assign to `known`...
  }
}

// Serialize
const out = {
  ...known,
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  ...(Object.keys(unknownTopLevel).length > 0 ? { _unknownTopLevel: unknownTopLevel } : {}),
};
```

Per-item and per-file bags follow the same shape. See
`src/services/ChangelistService.ts` (`KNOWN_TOP_LEVEL_KEYS_SPEC` +
`KNOWN_ITEM_KEYS_SPEC`) and `src/services/ShelfService.ts`
(`KNOWN_FILE_KEYS_SPEC`) for production references.

## References

- `src/services/ChangelistService.ts` — `KNOWN_TOP_LEVEL_KEYS_SPEC`,
  `KNOWN_ITEM_KEYS_SPEC`, parse + serialize paths.
- `src/services/ShelfService.ts` — per-file-level bag
  (`_unknownFileField`), same pattern.
- `docs/testing.md` section 7 — storage forward-compat testing registry
  (round-trip spec must exercise an unknown top-level key _and_ a
  per-item/per-file key for every adopter).

# ADR-004: Atomic-write routing policy

Status: Accepted (2026-05-12)

## Context

Services that persist durable state to disk (changelists, shelved diffs,
resolved-merge buffers, user-exported patches) ran a mix of
`fs.writeFileSync` and `fs.promises.writeFile` calls against their
target paths. A direct write has two failure modes that matter to
users:

1. **Crash-during-write** — if the process is killed between the
   `open` and the last byte flush, the file is left truncated. On next
   launch the service reads the half-written JSON, fails to parse, and
   "gracefully" falls back to an empty state. The user's data is gone.

2. **Partial-write visibility to a concurrent reader** — another
   observer (a second VS Code window, an editor running a git hook, an
   external tool) can read the file mid-flight and see truncated
   content. Even if the writer eventually succeeds, the reader's
   snapshot is inconsistent.

Both modes map onto the same fix `git` itself uses: write to a sibling
temp file in the same directory, then `rename(2)` it over the target.
`rename(2)` is atomic within a single filesystem; POSIX guarantees it
unconditionally and modern Windows (NTFS/ReFS) guarantees it when no
other process holds the target. The helper in `src/utils/atomicWrite.ts`
packages this pattern with temp-file cleanup and consistent error
surfaces.

Not every write site benefits from the helper, however. The questions
that drove this ADR were: which writes *must* route through the helper,
and which writes are safe to leave as direct calls?

## Decision

A write is routed through `atomicWriteFile` / `atomicWriteFileSync` if
**any** of the following is true:

1. **Durable user state.** The file is read on next activate and holds
   content the user would notice losing — changelists, shelved diffs,
   merge-resolution buffers, persisted UI state. A crash-during-write on
   any of these surfaces a "your work vanished" bug.

2. **User-chosen output path.** The user clicked "Save" and picked a
   destination they expect to re-read later (exported patches, saved
   diffs). A truncated file at the user's chosen path is worse than a
   failed write because it silently poisons the user's archive.

3. **Cross-window race possible.** Two VS Code windows on the same
   workspace can both write the file. Direct writes expose a partial
   state to the reading side even when the writing side eventually
   succeeds.

A write is explicitly **kept as direct** when:

- **Temp file inside a mkdtemp directory.** When the target is a
  single-use scratch file (e.g. `PatchService._writeTempPatch` writing
  raw patch content into a freshly-created `os.tmpdir()` subdirectory),
  the atomic-write guarantees buy nothing. The parent directory is
  exclusively owned by the current operation; there is no concurrent
  reader, no re-read after restart, no cross-window race. The helper
  would add a sibling `.tmp-` file inside an already-temporary scratch
  directory and then rename — extra work for a path that is deleted at
  operation end regardless.

- **Stream output to a VS Code document.** The content is headed for an
  in-memory `TextDocument` or virtual document. There is no filesystem
  write at all.

Any write site outside these two exceptions defaults to the atomic
helper. When a reviewer sees a direct `fs.writeFile*` call, the burden
is on the author to justify why neither rule (1), (2), nor (3) applies.

## Consequences

### Positive

- User-facing durability is consistent. A kill-signal or a same-path
  concurrent read cannot surface truncated state from any routed write.
- The routing decision has a written rule; reviewers don't re-litigate
  "should this be atomic?" on every new write.
- The `atomicWrite` helper stays small and purpose-built rather than
  becoming a universal wrapper that every scratch-file write pays for.

### Negative / costs

- The helper creates a sibling `.tmp-<pid>-<rand>` file on every write.
  On a failed rename the temp file is best-effort-unlinked; on a
  process kill between write and rename the temp stays behind. The
  sibling name is pid-scoped + 8 base36 chars of entropy so collisions
  between concurrent writers in the same directory are vanishingly
  unlikely, but a directory listing after a hard crash may show a
  `.tmp-` file until the user next runs a cleanup.
- `rename(2)` is not a concurrent-writer serializer. If two windows
  both read, both mutate, and both `atomicWriteFileSync` in close
  succession, the last rename wins and the earlier writer's changes
  are silently overwritten. This is last-writer-wins by design;
  read-modify-write atomicity is the caller's problem, not the helper's.

### Neutral

- The decision is orthogonal to JSON schema migrations (ADR-003). Both
  ADRs apply to the same files; they solve different failure modes.

## References

- `src/utils/atomicWrite.ts` — helper implementation + the JSDoc
  rationale for the rename-based strategy, including temp-file cleanup
  and the Windows-locked-target caveat.
- `src/services/ChangelistService.ts` — `atomicWriteFileSync` for
  durable-state rule (1).
- `src/services/ShelfService.ts` — `atomicWriteFileSync` for durable-
  state rule (1).
- `src/services/ShelfView.ts` (patch export) +
  `src/commands/CommitContextMenuCommands.ts` (patch save) +
  `src/services/PatchService.ts` (user-chosen patch output) —
  `atomicWriteFile` for user-chosen-path rule (2).
- `src/services/PatchService.ts::_writeTempPatch` — explicit
  exception: direct `fs.promises.writeFile` into a `mkdtemp`
  subdirectory.
- `docs/testing.md` §7 — atomic-write testing patterns (`crash-during-
  write`, `concurrent-read`, `Windows locked target`).

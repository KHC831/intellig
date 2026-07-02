# Porting IntelliJ's 3-way merge window

Plan for replacing our thin `git.openMergeEditor` adapter (`src/conflicts/MergeView.ts`)
with a real port of IntelliJ's merge window — the diff/merge engine, the conflict
model, and the three-pane UI — plus its test suite.

North-star sources (all under `~/Documents/workspace/intellij-community`):

| Layer | Where | Size | What it does |
|---|---|---|---|
| Engine | `platform/util/diff/src/` | ~7,100 lines, 53 files | Pure comparison + merge math: by-line/by-word/by-char diff, three-side merge ranges, conflict typing, auto-resolve ("magic resolve") |
| Model | `platform/diff-impl/src/com/intellij/diff/merge/` (`MergeConflictModel.kt`, `MergeModelBase.kt`, `TextMergeChange.kt`, `MergeDiffBuilder.kt`) | ~1,200 lines | UI-free conflict state: which chunks exist, which are resolved, applying a side, re-tracking chunk positions as the user edits the result |
| Viewer/UI | same dir (`MergeThreesideViewer.java`, `TextMergeViewer.kt`, `MergeWindow.java`, actions, highlighters) | ~3,800 lines | Swing three-pane editor: colored chunks, gutter apply/ignore buttons, toolbar, status bar, exit confirmation |
| Git glue | `plugins/git4idea/backend/src/merge/` (`GitMergeProvider.java`, `GitMergeUtil.java`) | ~830 lines | Loads yours/base/theirs from index stages `:2`/`:1`/`:3`, swaps sides during rebase ("reverse root"), marks resolved |
| Engine tests | `platform/diff-impl/tests/testSrc/com/intellij/diff/comparison/` | ~5,300 lines | Data-driven: left/base/right text in, expected chunks/resolve out; includes fuzz "auto tests" |
| Merge tests | `platform/diff-impl/tests/testSrc/com/intellij/diff/merge/` (`MergeTest.kt`, `MergeAutoTest.kt`, `MergeTestBase.kt`) | ~1,600 lines | Drives the viewer through user actions (apply side, ignore, undo, type into result) and asserts final text + chunk states |

## Can it port as-is, without rewrites?

Three different answers for the three layers.

**Engine — yes, near-mechanically.** `platform/util/diff` is a deliberately
dependency-free Kotlin module (JetBrains shares it with Fleet). Its only imports
beyond the JDK are int-array lists, string helpers, its own `BitSet`, and the
low-level Myers diff (`Diff.kt`, also in the module). Every algorithm is plain
loops + data classes — no threads, no UI, no filesystem. It transliterates to
TypeScript file-by-file, preserving names and structure (`ByLineRt.kt` →
`byLine.ts`, etc.). This is a translation, not a rewrite: same functions, same
control flow, same edge cases. `CharSequence` → `string`, `IntList` →
`number[]`, `ProcessCanceledException`/`CancellationChecker` → a no-op hook we
keep for structure.

**Model — yes, with one substitution.** `MergeConflictModel` says it itself:
"Doesn't know anything about the UI." Its logic (chunk state machine, resolve
semantics, apply/append/reset, "can this chunk auto-resolve") transliterates
directly. The one thing to replace is IntelliJ's `Document` + undo-command
plumbing: `MergeModelBase` keeps chunk line-ranges valid while the user types in
the result pane and stores per-chunk undo state. We substitute a small
`MergeDocument` interface (get/replace lines, change events) implemented over
whatever editor hosts the result pane. The range-shifting and state store/restore
logic itself ports as-is.

**Viewer/UI — no.** It's Swing + IntelliJ editor internals top to bottom. The
*behavior* is specified well enough by the model + `MergeTest.kt` to rebuild
faithfully, but the rendering layer is a from-scratch build on VS Code (fork
below).

**Git glue — mostly already ours.** `conflictSideNames.ts`,
`syntheticMergeBase.ts`, `conflictStageModel.ts`, `ResolveConflictsDialog.ts`
already cover side naming, reverse-during-rebase, stage handling, and the
conflict list. New work is only: load `:1`/`:2`/`:3` blob contents for the
window, write the result file, and stage on Apply (existing `markResolved` flow).

### Tests — portable?

- **Engine tests: yes, as-is in substance.** They're data tables ("given these
  three texts, expect these chunks / this resolved text") behind two small DSL
  base classes (`ComparisonUtilTestBase`, `ComparisonMergeUtilTestBase`). Port
  the DSL once onto mocha, then the ~4,000 lines of cases transfer with syntax
  changes only. The fuzz suites (`ComparisonUtilAutoTest`, `MergeAutoTest`)
  map straight onto our property lane (fast-check generators replacing their
  seeded random text generator).
- **Merge-model tests: yes, against a headless harness.** `MergeTestBase` spins
  up the real viewer but only ever touches it through actions and the document.
  We port it as a headless harness over our model + `MergeDocument` (no webview),
  keeping every `MergeTest.kt` case: apply left/right, ignore, one-side-applied
  conflicts, undo, typing into a chunk, chunk invalidation.
- **Viewer rendering: not portable** — covered instead by our own snapshot +
  webview-exec + e2e lanes (the visual-parity discipline layers).

### Explicitly out of scope (IntelliJ features we do NOT port)

- **Semantic / language-specific conflict resolution** (`LangSpecificMergeConflictResolver*`) — needs PSI (IntelliJ's parser infrastructure). The strategy enum keeps the slot; only TEXT strategy ships.
- **Auto-resolve import conflicts** — PSI again.
- **AI resolve hooks** (`replaceChangeWithAi`) and **statistics aggregation**.
- Non-text merge tools (`BinaryMergeTool`, `ErrorMergeTool`) — our dialog already routes binary conflicts to whole-file take-ours/take-theirs.

### License note

All ported files are Apache 2.0 (JetBrains). Keep a per-file provenance header
("Ported from `<path>` in intellij-community, Apache 2.0") and add an
attribution entry to a NOTICE file before any release that ships the port.

## The one open fork: what renders the three panes

The window is: left pane (yours, read-only) | center pane (result, **editable**)
| right pane (theirs, read-only), with aligned chunk highlights, curved
connectors, and clickable gutter arrows/× per chunk. VS Code gives us no way to
build that out of native editors — no three-way scroll lock, no clickable
gutter decorations, no cross-editor alignment. So:

- **Option A — custom webview, Monaco for the panes.** Ship the prebuilt
  `monaco-editor` package as a webview asset (works without adding a bundler;
  ~5 MB in the vsix — `.vscodeignore` must ship it, same lesson as the
  neverthrow packaging bug). Full control: aligned panes, painted chunk
  connectors, real gutter buttons, syntax highlighting, editable center with
  undo. True IntelliJ-parity UI. Most work, and Monaco's theme must be mapped to
  the active VS Code theme.
- **Option B — custom webview, hand-rolled panes.** Read-only sides are easy
  (we already paint rich webviews); the editable center means building a code
  editor ourselves — not credible. Only viable if the center pane were
  read-only with chunk-level-only edits, which breaks parity (IntelliJ lets you
  hand-edit the result freely). Not recommended.
- **Option C — keep VS Code's merge editor, port only engine + model.** The
  ported engine powers what VS Code lacks: Apply All Non-Conflicting, Magic
  Resolve (auto-resolve overlapping-but-compatible conflicts), better conflict
  typing and counts in our Resolve Conflicts dialog. UI stays VS Code's.
  Cheapest, real user value, but the window itself is not IntelliJ's — column
  labels, base-in-center layout, gutter workflow all stay VS Code.

### Assessed and rejected: forking VS Code's own merge editor as the base

VS Code's merge editor (`src/vs/workbench/contrib/mergeEditor/` in the vscode
repo) is MIT — legally fine to reuse. Practically it can't serve as our base:

- **It only runs inside the workbench.** Extensions get a Node extension host
  plus plain-HTML webviews; the merge editor imports hundreds of
  workbench-internal modules (DI services, `vs/editor` internals, editor-pane
  infrastructure) that exist nowhere an extension controls. The npm
  `monaco-editor` package ships only the compiled editor with a public API —
  the merge-editor contribution isn't in it, and its source doesn't compile
  against the public API. Using it as a base means bundling a mini-fork of
  VS Code's source tree (vs/base + vs/editor + service shims + the contrib)
  into our webview — *more* machinery than Option A, plus permanent drift
  against upstream.
- **Its merge model isn't IntelliJ's.** Checkbox-per-input acceptance,
  "combination" resolve, no base-anchored chunk gutters, no magic resolve.
  Reaching IntelliJ behavior means replacing its model with the Phase 2 port
  anyway — all that would survive is rendering glue, which is exactly the
  workbench-coupled part.
- **The editable middle column already exists without any porting.** Verified
  against the shipped build: `merge.columnLayout` switches the merge editor to
  Yours | Result (editable) | Theirs, and `showBaseTop`/`showBaseCenter` add
  the base. If layout is the main complaint with Option C, defaulting users
  into column layout is nearly free.

Where the vscode source *does* help: as an MIT-licensed reference for Phase 3's
hardest rendering problems — cross-pane chunk alignment (their view-zone
math), scroll sync, and decoration styling — ported piecemeal onto packaged
Monaco rather than vendored wholesale.

Recommendation: **A**, staged so the engine+model land first (they're identical
work under A and C — if A's webview proves too heavy mid-effort, C is the
fallback with zero wasted work).

## Phases

Each phase is independently landable on local main behind the usual gate; the
new engine ships dark (unused) until Phase 4 flips the entry point.

**Phase 1 — engine port + its tests.** `src/diff-engine/` (new, dependency-free,
mirrors the Kotlin package layout: `util/` Range/MergeRange/Side/ThreeSide/
MergeConflictType, `comparison/` Diff+BitSet, iterables, TrimUtil, ByLine/ByWord/
ByChar, ChunkOptimizer, LineFragmentSplitter, ChangeCorrector,
ComparisonMergeUtil, MergeResolveUtil, MergeRangeUtil, `fragments/`,
LineOffsets). Port order follows the dependency chain: Diff/BitSet → iterables →
TrimUtil → ByChar → ByWord → ByLine → merge utils. Each file lands with its
IntelliJ test file ported in the same commit (red-first: port the test, watch it
fail, port the source). Fuzz suites → property lane. ~7k source + ~5k test lines
to translate; the largest single chunk of the effort, but low-risk.

**Phase 2 — model port + headless merge tests.** `src/conflicts/merge-model/`:
`MergeDocument` interface, `MergeModelBase` (range shifting, undo state),
`TextMergeChange`, `MergeDiffBuilder`, `MergeConflictModel` (minus PSI/AI/import
paths). Port `MergeTestBase` as a headless harness and carry over all
`MergeTest.kt` + `MergeAutoTest.kt` cases. Exit criterion: every ported case
green over a plain in-memory document.

**Phase 3 — the merge window.** Webview panel (Option A): three Monaco panes,
chunk highlights in IntelliJ's four colors (insert/delete/modify/conflict),
divider connectors, gutter apply/ignore buttons, toolbar (Apply All
Non-Conflicting left/all/right, Magic Resolve, prev/next change, undo/redo),
status line ("N changes, M conflicts"), Accept Left/Right, Apply/Abort with
IntelliJ's exit confirmation. Center-pane edits flow through `MergeDocument`
into the model so chunk tracking + undo behave like IntelliJ. Snapshot tests +
webview-exec tests; `docs/parity/` gets the reference screenshots per the
visual-parity discipline.

**Phase 4 — git wiring + rollout.** Load `:1`/`:2`/`:3` via `git show` (base
absent ⇒ synthetic base path we already have), reverse sides during rebase
(existing `conflictSideNames`), write + stage result on Apply, feed
`ResolveConflictsDialog` counts from the engine. `MergeView.show()` opens the
new window; a setting keeps `git.openMergeEditor` available as an escape hatch.
E2e: real-git merge/rebase/cherry-pick conflicts driven through the window.

**Phase 5 — hardening.** Property soak (random three-side texts: magic-resolve
output must contain no conflict markers and preserve non-conflicting edits;
model invariants under random action sequences), large-file guard
(`DiffTooBigException` behavior), CRLF/no-EOL edge cases, perf on big files.

Rough shape: Phases 1–2 are the bulk by volume but mechanical; Phase 3 is the
bulk by design risk. 1, 2, and 3 can be worked mostly in parallel once the
engine's types (Phase 1 `util/`) exist.

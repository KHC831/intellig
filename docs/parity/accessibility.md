# Accessibility — IntelliG VS Code extension

This is the cross-cutting parity reference for accessibility (a11y)
contracts across IntelliG's webview + tree-view surfaces. Per-feature
parity docs (`git-log-graph.md`, `repo-states.md`, …) own the
behavioural / visual contract for their slice; this doc owns the
horizontal a11y contract that every slice must meet.

The four invariants every IntelliG surface must hold (per ADR-010):

1. **Screen-reader narration.** Every chip / badge / tree-row carries
   `role` + `aria-label` (or `accessibilityInformation.label` for
   tree-views) so SRs hear the meaning, not the bare class-prefixed
   text.
2. **Theme-aware colours.** Every fg/bg colour resolves through a VS
   Code theme variable (`var(--vscode-…)` for webviews,
   `vscode.ThemeColor` for tree-views) with an IntelliJ-parity hex
   fallback.
3. **WCAG 1.4.1 — non-colour affordance.** Distinctions that today
   are conveyed by colour (local-vs-remote chip, file-status colour,
   focused-branch outline) MUST also have a non-colour cue: an icon,
   a glyph, a font-weight bump, or a textual decoration.
4. **High-contrast survival.** Manual sweep under `Default High
   Contrast` and `Default High Contrast Light` themes is part of
   feature acceptance; automated coverage lives in the snapshot
   layer (theme-var contract assertions).

## §1 Branch / HEAD / Tag chips (Wave J)

The branch + HEAD + tag chips emitted on every commit row in the
graph panel. See `git-log-graph.md §2.6` for the full per-chip
contract; this section owns the cross-cutting invariants.

- Every chip is a single `<span>` carrying `role="img"` and a
  descriptive `aria-label` ("Current HEAD" / "Local branch: …" /
  "Remote branch: …" / "Tag: …"). The user-controlled half of the
  label is run through `_escapeHtml` so reflective injection is
  impossible. Pinned by `snap-12a..d`.
- Every chip carries a leading codicon glyph as the WCAG 1.4.1
  non-colour affordance (`codicon-check` for HEAD,
  `codicon-git-branch` for local, `codicon-cloud` for remote). The
  icon is `aria-hidden="true"` so AT narrates the chip's own
  `aria-label` rather than reading the icon class. Pinned by
  `snap-12f..g`.
- Chip backgrounds use VS Code's `--vscode-badge-background` /
  `--vscode-badge-foreground` semantic tokens (Wave J R1 / HIGH-4
  swap from the original `gitDecoration-stage*` / `gitDecoration-
  renamed*` mapping, which were FG-tier file-status semantics that
  themes use for the SCM tree, not chip-shaped UI). Local vs remote
  distinction lives in the codicon prefix, NOT the background
  colour. Pinned by `snap-12e`.
- Focused branch chip (`branch-label-focused`) carries:
  - `outline: 1px solid var(--vscode-focusBorder, currentColor)`
    with `outline-offset: 1px` (Wave D R1 / Senior L-2);
  - `font-weight: 700` and `text-decoration: underline` (Wave J R1 /
    MED-1) so the focused affordance is visible WITHOUT relying on
    colour alone — a sighted user reading mono-chrome printout still
    sees the bold + underlined chip;
  - `aria-describedby="focused-branch-help"` pointing at a single
    visually-hidden help span at panel bootstrap (Wave J R1 / MED-2)
    that explains the focus state to SR users.
- Codicon font loading: `_getCodiconFontFaceCss(webview)` emits a
  `@font-face` declaration that loads `media/codicon.ttf` (copied
  from `node_modules/@vscode/codicons/dist/codicon.ttf` at install
  time). Without the `@font-face`, every `<i class="codicon">` would
  render as an empty-box "tofu" glyph and the entire WCAG 1.4.1
  affordance would silently fail. CSP is widened with
  `font-src ${webview.cspSource}` to permit the same-origin TTF.
  Pinned by `codiconFont-1..3` in `commitGraphSnapshots.test.ts`.

> **Why `aria-pressed` is deferred FURTHER (DJ-2 → DK-6).** Wave J
> originally pencilled in `aria-pressed` for Wave K. After re-evaluating
> the chip semantics during the Wave K design pass we concluded that
> `aria-pressed` is the wrong attribute for chip-as-button — chips are
> a popup menu trigger, not a toggle, so `aria-haspopup="menu"` is the
> semantically-correct attribute when interactivity lands. The
> re-deferral keeps the bridge `aria-describedby="focused-branch-help"`
> (Wave J R1 / MED-2) on focused chips so SR users still hear the
> focus-state explanation; `aria-pressed` is removed from the roadmap.

## §2 File-status colours (Wave J)

The file-status indicator (`M`/`A`/`D`/`R`/`C`/`U`/`I`/`!`) emitted
on every changed-file row in the details panel. See
`GitToolWindowProvider.ts:83+` for the constants and
`detailsPanel.test.ts` for the test contract.

- `INTELLIJ_FILE_STATUS_COLORS` — hex literals that match IntelliJ
  IDEA's file-status palette (`#6897BB` blue for modified, `#629755`
  green for added, etc.). Retained as the CSS-var fallback so a
  theme that doesn't define `gitDecoration-*` still gets a
  visually-readable colour.
- `FILE_STATUS_THEME_VARS` (Wave J R1 / HIGH-2) — VS Code
  `--vscode-gitDecoration-*ResourceForeground` token mapping for
  every `FileStatus` (modified, added, deleted, renamed, copied,
  untracked, ignored, conflicted). `copied` aliases to
  `addedResourceForeground` per VS Code's own convention (their
  built-in git extension applies the same alias).
- `_getFileStatusColor(status)` returns
  `var(--vscode-gitDecoration-…ResourceForeground, #hex)` so the
  colour follows the user's theme (especially high-contrast) instead
  of the bare IntelliJ hex. Pinned by `fileStatusTheme-1..8` in
  `detailsPanel.test.ts`.

The `M`/`A`/`D`/`R`/`C`/`U`/`I`/`!` letter prefix on each row is
itself a WCAG 1.4.1 non-colour affordance — a user who can't read
the colour still reads the letter and knows the status.

## §3 Branch tree detached HEAD row (Wave H)

The synthetic `(HEAD detached at <sha>)` row prepended to the
BRANCHES tree-view when the working copy is in detached state. See
`BranchTreeProvider.ts:178+` (tooltip) and `:69+` (constructor) for
the row-construction contract.

- Icon: `git-commit` themed `statusBarItem.warningBackground`
  (yellow/gold) — matches the Wave G HEAD chip in the graph so the
  user reads "this is HEAD" consistently across both surfaces.
- Description: `'detached'` — distinct from `'current'` (which
  implies a branch is checked out).
- Tooltip: multi-line `Detached HEAD\nCommit: <sha>\n(Not on a
  branch — checkout a branch to attach HEAD)` for sighted users.
- `accessibilityInformation.label` (Wave J R1 / MED-3): `Detached
  HEAD at <shortSha> — not on a branch` so SR users hear the same
  meaning the visible icon + tooltip convey to sighted users.
  Pinned by `branchTree-detached-aria-1` in
  `BranchTreeProvider.test.ts`.

## §4 Status indicators in details panel

The changed-files list in the details panel renders one row per
changed file with a status indicator span + the file's path. See
`detailsPanel.test.ts §"Status indicators"` for the per-status test
contract.

- Status character (`M`/`A`/`D`/…) — primary semantic conveyance
  (text, not colour); SRs read the letter directly.
- Status colour — secondary conveyance, theme-aware via
  `_getFileStatusColor` (§2 above).
- The `class="file-status-indicator"` span is a single semantic
  unit; it does not carry `role` or `aria-label` because the
  one-letter text content already conveys the meaning, and adding
  redundant aria attributes would make SRs read the status twice.

## §5 Cross-references

- `docs/adr/ADR-010-visual-parity-discipline.md` — the four-layer
  visual-parity discipline (snapshot tests, UX-review checkpoint,
  parity reference docs, repo-state coverage). This doc is Layer 3
  for the a11y cross-cutting slice.
- `docs/parity/git-log-graph.md §2.6` — the per-chip a11y / theme
  contract. This doc cross-references it; it is NOT duplicated.
- `docs/parity/repo-states.md` — repo-state coverage matrix (clean,
  detached, conflicted, …). The detached-state row covers the
  branch-tree row in §3.

## §6 Future a11y work (post-Wave-K)

Items deferred from earlier waves and the current pending list:

- **`aria-pressed` removed from the roadmap (DK-6).** Wave J pencilled
  this in for Wave K; the Wave K design pass concluded `aria-pressed`
  is the wrong attribute (chips trigger menus, they are not toggles).
  When chip-as-button interactivity lands, the semantically-correct
  attribute is `aria-haspopup="menu"` plus the existing
  `aria-describedby="focused-branch-help"` bridge. No new wave
  scheduled — chip interactivity is on the next-tier roadmap, not
  scope-blocking.
- **Keyboard navigation across chips.** The chips today are navigable
  only via tab into the parent commit row + the row's own focus
  management. A future iteration adds left/right arrow navigation
  across chips within a row, matching IntelliJ's "branches popup"
  navigation. Independent of `aria-haspopup`.
- **High-contrast manual sweep.** Each new feature gets a manual pass
  under `Default High Contrast` + `Default High Contrast Light` before
  sign-off. Today's automation covers the theme-var contract (snap-12e,
  snap-13f, fileStatusTheme-1..8); the visual sweep is irreplaceable
  for catching contrast-ratio regressions that the theme variable
  doesn't surface (e.g. a chip foreground that happens to match the
  chip background under a high-contrast palette).

## §1.4 Tag chips (Wave K)

The `.tag-label` chip joined the chip family in Wave K (WK-4).
Contracts mirror the local + remote chip family; see
`docs/parity/git-log-graph.md §2.7` for the per-chip details. In
short:

- `role="img"` + `aria-label="Tag: <tagName>"` (parallel to the
  Wave J HEAD / local / remote chip aria contract).
- Leading `<i class="codicon codicon-tag" aria-hidden="true"></i>`
  prefix as the WCAG 1.4.1 non-color affordance.
- Same 200px max-width cap as branch chips so a long tag name (e.g.
  `release/2026-Q1.beta3-rc4`) ellipsizes rather than blowing up the
  layout.
- Background uses `var(--vscode-gitDecoration-modifiedResourceForeground,
  #6897BB)` — identical to the pre-WK value, retained for snap-13f.

Pinned by `snap-13a..f` + `codiconFont-4` in
`commitGraphSnapshots.test.ts`.

---

## §1.5 Status-bar in-progress label

The status-bar Git widget renders a verb-form prefix when the
working tree is mid-merge / mid-rebase / mid-cherry-pick / mid-revert.
Without it the label shows only an icon (`$(git-merge)`, etc.) and
the branch name — no narratable verb, no target. Screen-reader users
hear only the codicon glyph (which reads as "git merge" without
context — ambiguous between "the merge command" and "currently
merging") and the branch chip, with no signal that the working tree
is non-idle.

A11y contract for the in-progress label:

1. **Visible verb form** in the status-bar `text` field (rendered by
   VS Code's status-bar — the codicon + the verb literal):

   - `$(git-merge) Merging <target>`
   - `$(git-pull-request) Rebasing onto <target>`
   - `$(git-commit) Cherry-picking <short-sha>`
   - `$(discard) Reverting <short-sha>`

2. **Tooltip carries the verb-form label as the screen-reader
   fallback.** The tooltip is what VS Code surfaces to the
   `aria-label` of the status-bar item; for screen readers that do
   not interpret the codicon glyphs, the verb-form line is the
   primary narration. (The tooltip starts with the verb-form line,
   followed by the existing branch / sync narration on subsequent
   lines.)

3. **Verb-only fallback**: when a marker file exists but the target
   is unreachable (plain `MERGE_HEAD` with no name available, or a
   marker file race), the verb alone is surfaced. No `<unknown>`
   placeholder — the verb on its own is sufficient signal that the
   working tree is non-idle.

Pinned by `StatusBarService — in-progress labels` in
`src/test/unit/services/StatusBarService.test.ts`. The ASCII
connectors in the verb form ("onto") match IntelliJ's status-bar
wording for parity.

---

_Last updated: 2026-05-31._

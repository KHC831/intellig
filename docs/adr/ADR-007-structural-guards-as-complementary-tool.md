# ADR-007: Structural guards as a complementary tool

Status: Accepted (2026-05-15)

## Context

Through Wave 8 and Wave 9 the codebase accumulated CI-time structural
guards as a complement to per-site unit specs. Each was justified
ad-hoc in its own wave; none of them named the pattern as a category,
and the rationale for "guard vs spec vs both" got re-litigated in
review on every wave-N+1 invariant that looked similar.

The seven on-disk structural guards as of Wave 135 R4 / Cluster B R2:

- **`scripts/check-quickpick-state-no-error.sh`** (TL-74, Wave 8 R2).
  Per ADR-006, three QuickPick view-state interfaces
  (`IShelfViewState`, `IStashViewState`, `IBranchComparisonViewState`)
  deliberately carry no `error` field — refresh failures travel
  through a `Promise<{ error? }>` return value, never via a state
  sideband. The guard awk-checks each interface body and fails the
  build if a future change reacquires the `error?: string` field on
  any of them. Reasoning: low-N (3 interfaces), syntactic signature
  (a `error?: string;` field declaration inside a tracked
  `interface … {` block), per-view migration spec already pins the
  refresh-return contract — the guard's job is to stop the sideband
  from sneaking back in.

- **`scripts/check-action-toasts-sanitized.sh`** (TL-72 + TL-78 +
  TL-79, Wave 9 R1-R3). Closes the credential-leak boundary on
  `vscode.window.show(Error|Warning|Information)Message(...)` calls.
  Awk-joins multi-line opener-to-closer call bodies, regex-flags any
  `${VAR}` interpolation where VAR matches a known err-derived name
  (`m | msg | errMsg | errorMessage | errMessage | message | raw |
reason | abortMsg | forceMsg | stashMsg`) AND the call body does
  NOT contain `sanitizeGitError(`, AND there is no
  `// sanitize-exempt: <category>: <reason>` comment on the same line
  or directly above. Reasoning: 60+ swept sites across 12+ files;
  per-site specs would be overwhelming and most would shape-match a
  stub-and-stub-throws-credentialed-payload tautology. A representative
  per-FILE spec for the high-traffic surfaces (StashView,
  BranchComparisonView, CommitDialog, etc., ~29 specs) plus the guard
  catches drift across the long tail without per-site enumeration.

Two related artefacts are _not_ structural guards by the rule below
but were sometimes discussed alongside them in review notes:

- **NotificationService dispose-lifecycle tests** (Wave 6, see
  `test/unit/services/notificationService.test.ts`) — these are
  per-method behaviour specs (constructor wires, `init()` registers
  with `context.subscriptions`, listeners are no-ops post-dispose),
  not a structural-shape guard. Belong under "per-site spec."
- **TLR3-2 task-ID sweep** (Wave 7, task #105) — was a one-off
  cleanup pass, not a recurring CI guard. The hygiene rule
  (`feedback_history_hygiene.md`) is enforced by review attention,
  not a script.

The guard-vs-spec distinction matters because each tool has a
different cost profile and a different failure mode. Conflating them
leads either to over-specification (unit specs that re-test the same
shape across 30 sites) or under-protection (one representative spec
plus "just trust the next contributor" with nothing in CI to catch
drift).

## Decision

### When each tool fits

| Tool                                        | Use when                                                                                                                                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-site unit/property spec**             | Behaviour contract: returns specific shape, calls specific helper, surfaces specific user-visible result. Single site or low N (≤ ~5). Contract is _not_ mechanically expressible as a syntactic pattern.                                      |
| **Structural guard (CI script)**            | Invariant applies to ≥ ~8 sites. Bug class has a syntactic signature an awk/grep heuristic can express. A per-FILE representative spec exists to anchor the bug class. Drift protection is valuable beyond enumeration of today's known sites. |
| **Both**                                    | High-stakes invariants — credential leak, dispose lifecycle, durable state contract. Defense-in-depth: representative specs prove the bug class is fixed; the guard prevents new sites from regressing the invariant silently.                 |
| **Neither (escalate to integration / E2E)** | Invariant requires runtime state to verify (real subprocess effects, real fs side effects, real activation lifecycle).                                                                                                                         |

The "≥ ~8 sites" floor for guards isn't sacred but reflects observed
maintenance economics: under that threshold, a one-spec-per-site
approach is cheaper than maintaining a heuristic + its allowlist

- its exempt mechanism. Above that threshold the per-site test debt
  balloons faster than the guard scales.

### Per-FILE representative spec floor

A structural guard does **not** substitute for per-SITE specs in
isolation. The per-FILE representative-spec floor must hold:

- For each file the guard inspects, at least one unit/property spec
  must exercise the bug class through a real call path (not just by
  re-asserting the guard's own regex).
- Wave 9 example: BranchContextMenuCommands has 26 swept toast sites;
  one representative spec (`_handlePush sanitizes credentialed URL +
home path in error toast`) anchors the bug class for the file. The
  guard catches the other 25 sites.

This floor exists because a guard that only encodes a regex carries
no behavioural witness — if the production code shape changes (e.g.
the team adds a new toast verb the guard doesn't know about), the
guard silently misses the entire class. The representative spec is
the safety net for the heuristic itself.

The TDD rule (`feedback_tdd_workflow.md`, "structural guard
acceptable substitute" clause) is read as _"acceptable substitute
for per-site enumeration, conditional on the per-FILE floor"_ — not
as a blanket bypass of TDD for structural problems.

### Guard maintenance contract

Every guard owner must document, in the script header:

1. **Bug class** caught — one sentence stating the invariant.
2. **Heuristic + how it scales** — flag-everything? whitelist by name?
   hybrid? what happens as the codebase grows?
3. **Known false-positive cases** (today's exempts) — what
   shape-matches the heuristic but is legitimately safe, and how is
   it suppressed (exempt comment, allowlist entry, test exclusion).
4. **Known false-negative cases** — what bypass shapes the heuristic
   accepts. `feedback_severity_by_impact.md`'s "fix-it-if-flagged"
   policy still applies; this section is for future audit of "did
   the next reviewer think to look here?"
5. **Retirement criteria** — when does the guard stop earning its
   keep? Examples: invariant gets enforced by a stricter type
   (rendered redundant); the codebase gets a real linter for the
   pattern; the bug class becomes architecturally impossible.

Without these five sections, the guard's reasoning gets re-discovered
during the next round of triage, and exempt comments accrete without
discipline.

### Substrate choice

| Substrate                  | Use when                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **awk**                    | Multi-line constructs (paren/brace tracking matters), structured per-line state machines, simple comment-strip + paren-count is enough. **Default for non-trivial guards.** |
| **node + TS compiler API** | Guard needs AST awareness — actual binding analysis, type information, scope-following. Heavier; reach for it when awk's line-or-buffer model genuinely won't fit.          |
| **grep / sed (plain)**     | Trivial single-line patterns where a regex match per line suffices and there's no nested context.                                                                           |

Both on-disk guards (`check-quickpick-state-no-error.sh`,
`check-action-toasts-sanitized.sh`) chose awk because the patterns
require either interface-block tracking (paren/brace depth) or
multi-line opener-to-closer joining. A node + ts-morph guard would
also work, but the dependency cost (build-time TS host startup)
isn't worth it for these two use cases. Reach for AST when the
heuristic genuinely needs it; until then, awk wins on maintenance
cost.

## Consequences

### Positive

- A future "TL-N: should this be a structural guard?" review question
  has a written rule to consult instead of re-arguing on every
  invariant.
- Guard authors are forced to document false positives + false
  negatives + retirement criteria up front, which catches "I'd
  add a guard but I don't know how to limit its scope" earlier.
- The per-FILE spec floor keeps the guard from becoming the _only_
  evidence that the bug class is fixed — there's always a
  behavioural witness somewhere in `test/`.
- Reviewers have a one-line check: _for each file the guard inspects,
  is there at least one representative spec?_ If no, that's a finding.

### Negative / costs

- Heuristic-based guards have permanent FP/FN risk. Exempt mechanisms
  are foot-guns without taxonomy; TL-79's `<category>: <reason>`
  syntax mitigates but doesn't eliminate this.
- awk substrate is brittle to TS evolution (e.g. a hypothetical
  future TS where `${...}` is no longer the interpolation syntax).
  Mitigation: the per-FILE specs catch the actual behaviour; the
  guard is the structural lock, not the proof.
- The ADR was written pre-emptively at 2 guards (Wave 9 R3 / TL-77)
  because the pattern was going to recur. As of Wave I (the post-
  Wave-H comprehensive review) the count is 9 — the late additions
  being `check-watcher-families-registered.mjs` (TL-87) and
  `check-output-channel-test-surface.sh` (TL-58). Comfortably above
  the "guard-vs-rederive economics" inflection — so the ADR is now
  recouping its drafting cost via consistent header structure
  and per-guard FP/FN logs.

### Neutral

- This ADR doesn't create a quota. "≥ 8 sites" is a guideline,
  not a hard floor — judgement applies.
- The exempt-taxonomy rule (TL-79: `user-input | sha-prefix |
pre-sanitized | non-error-data`) is a per-guard concern, not a
  cross-guard one; the QuickPick-state guard has no exempts because
  its invariant is binary (the field is there or it isn't).
  Future guards may need their own taxonomy. Document it in the
  script header.
- "Informal ceiling for ad-hoc; document before the next one"
  applies: when a third guard lands, the third author cites this
  ADR in their script header rather than re-deriving the rule.

## Adopters

- **`scripts/check-quickpick-state-no-error.sh` (TL-74, Wave 8 R2).**
  Awk over three tracked interface declarations; rejects
  `error?: string` reacquisition. Companion specs:
  `branchComparisonView.test.ts` TL-68 describe block,
  `stashView.test.ts` TL-68 describe block, `shelfView.test.ts`
  refresh-return-shape specs. False-positive log: none today.
  False-negative log: a future migration that splits the interface
  into two parts could escape the tracked-name list — mitigated by
  the explicit `TARGETS` array.

- **`scripts/check-action-toasts-sanitized.sh` (TL-72 + TL-78 +
  TL-79, Wave 9 R1-R3).** Awk-joined multi-line toast-call buffer;
  rejects err-derived `${VAR}` interpolations without
  `sanitizeGitError(...)` or a structured exempt. Companion specs:
  29 representative `TL-72 — error toast sanitization` blocks
  across 12 test files (StashView, BranchComparisonView, PullDialog,
  MergeDialog, ResetDialog, RebaseEditor, BranchPopup, CommitDialog,
  ShelfView, RebaseProgressView, BranchContextMenuCommands,
  CommitContextMenuCommands). False-positive log: 3 sites today,
  all `user-input` or `sha-prefix` (extension.ts:1313, 4837;
  StashView.ts:203). False-negative log: a new err-derived variable
  name not in `SUSPICIOUS_VARS` would slip; mitigated by the
  per-FILE spec floor catching new shapes during review.

- **`scripts/check-readme-config-coherence.mjs` (Wave 135 R1 / H2,
  R3 M4 threshold).** Asserts every `intellig.*` row in README
  config tables has a default that matches
  `package.json.contributes.configuration.properties.<key>.default`.
  Soft-warns on schema keys missing from README; hard-fails when
  the missing-from-README count crosses
  `UNDOCUMENTED_FAIL_THRESHOLD=5` (Wave 135 R3 / M4). Companion
  specs: none — the bug class is purely structural (markdown ↔
  JSON schema agreement), with no behavioural counterpart that a
  unit test could anchor. The R0 review caught 4 stale defaults
  - 2 duplicate rows on first run; per-FILE spec floor would have
    needed a test for every config table, which is itself the
    drift surface this guard catches. False-positive log: none.
    False-negative log: a schema with a non-primitive default that
    doesn't JSON-normalize would silently mismatch.

- **`scripts/check-vsix-clean.sh` (Wave 135 R1 / H3).** Runs
  `vsce ls` (under the `INTELLIG_INTERNAL_PREPUBLISH_DRYRUN=1`
  bypass) and rejects any forbidden file class — `.test.js`,
  `out/test/`, `.agent/`, `AGENT_WORKSPACE.md`, `.idea/`,
  `.kiro/`, `.vscode-test/`, `docs/`, `scripts/`, `src/`,
  `tsconfig.json`, `eslintrc`, `prettierrc`, `mocharc`,
  `package-lock.json`, `CONTRIBUTING.md`, `.DS_Store`, `.map`,
  `.ts`. Companion specs: none in unit/property — bug class is
  the `.vsix` manifest, not source. R0 caught 365 stowaway files
  (210 KB `.agent/` + 507 KB `AGENT_WORKSPACE.md`) leaking via a
  `!out/**/*.js` re-include in `.vscodeignore`. False-positive
  log: none. False-negative log: vsce version drift could change
  `vsce ls` output format (mitigated via pinned `@vscode/vsce@2.24.0`).

- **`scripts/check-100-gate.sh` (Wave 135 R3 / H1 + TL-96, Cluster
  B R0).** When `package.json.version >= 1.0.0`, asserts every
  `[ ]` in CONTRIBUTING.md `### 1.0.0 gate checklist` is ticked
  AND structurally verifies gate condition (2): the experimental
  flags (`intellig.useCommitToolWindow`,
  `intellig.useTabbedGitToolWindow`) must be either absent from
  `contributes.configuration.properties` (Remove decision per the
  experimental-flag graduation sub-protocol) OR have
  `default !== false` AND no "Experimental" mention in
  `description` / `markdownDescription`. No-op for pre-1.0
  (current state). TL-96 (Cluster B R0) promoted gate (2) from
  honour-system to structurally checked; gate (1) is also
  structurally checked via `prepublish-guard.mjs`'s `license`
  fingerprint (see TL-93 entry below); gates (3) and (4) remain
  honour-system by their nature (scope decision, time-bounded
  user-feedback cycle aren't mechanically checkable from
  `package.json` shape alone). TL-98 (#226) tracks promoting
  gate (3) once TL-87 lands a structural marker for `.git`-
  as-file support. Companion specs:
  `test/unit/scripts/check100Gate.test.ts` (11 specs: pre-1.0
  short-circuit, version-extraction edge cases, structural gate
  (2) violations + passes). False-positive log: gate (2)'s
  case-insensitive "Experimental" substring match would FP on a
  graduated flag whose description mentions "Experimental" in
  unrelated context (mitigation: reword). False-negative log: a
  graduate-then-rollback workflow that lowers a flag back to
  `default: false` is correctly flagged as still-experimental.

- **`scripts/prepublish-guard.mjs` + `scripts/prerelease-state.json`
  (TL-93, Cluster B R0).** Refuses to package a `.vsix` while any
  release-blocking placeholder is still in place: LICENSE (≥2
  placeholder markers via the `minMarkers` rule), icon
  (`sha256` equality against the bundled placeholder hash),
  CHANGELOG date (`regex` matching `## [<anything>] - YYYY-MM-DD`),
  SECURITY.md email (`literal` `<EMAIL_PLACEHOLDER>`). The
  fingerprint config is data-driven via the JSON sidecar:
  adding a 5th placeholder = adding a JSON entry, replacing the
  icon = updating `placeholderHash` there. Triple-gated dogfood
  bypass (`INTELLIG_ALLOW_PLACEHOLDERS=1` +
  `INTELLIG_DOGFOOD_BUILD=1` + `INTELLIG_DOGFOOD_INVOCATION=1`)
  is the build-time layer of the placeholder-bypass defense
  layering (see "Defense layering for placeholder bypass" below).
  CI step `Structural guard — prerelease-state.json shape (TL-93)`
  validates the JSON shape independently, since the live tree
  legitimately fails the placeholder fingerprints pre-1.0.
  Companion specs:
  `test/unit/scripts/prepublishGuard.test.ts` (15 specs
  exercising each rule type + tag-cascade short-circuit + config-
  error surfaces + characterization of the shipped JSON state).
  False-positive log: a real LICENSE legitimately matching ≥2
  markers (mitigation: trim the markers list in the JSON or
  reword the LICENSE clause). False-negative log: any new
  placeholder phrasing not in the marker list slips silently
  (mitigation: per-FILE characterization spec on the JSON state).

- **`scripts/check-watcher-families-registered.mjs` (TL-87).**
  Asserts every `vscode.FileSystemWatcher` owned by `GitService`
  (collected on a `_*Watchers` field) is registered in the disposer
  array, so each repo lifecycle event tears down its watcher
  cleanly. Companion specs: the `gitServiceWatcherFamilies.test.ts`
  characterization spec sized N=2 today (`_fileWatchers`,
  `_newRepoWatchers`). False-positive log: a watcher field that's
  not lifecycle-bound (e.g., a one-shot create-and-dispose) would
  trip; mitigation is the field-naming convention. False-negative
  log: a future field whose disposer registration is conditional on
  configuration would slip past the disposer-array regex.

- **`scripts/check-output-channel-test-surface.sh` (TL-58).**
  Asserts NO production caller invokes `__resetOutputChannelForTest`
  — that helper is test-only state-reset machinery and a
  production caller would erase the OutputChannel mid-session.
  Companion specs: `outputChannelTestSurface.test.ts` (the
  characterization). False-positive log: none today. False-negative
  log: a production caller that aliases the helper through a
  re-export would slip; mitigation is the symbol's deliberately
  test-namespaced prefix.

- **`scripts/check-publish-vsix.sh` (TL-95, Cluster B R0).**
  Refuses to publish a `*-dogfood.vsix` filename. Case-
  insensitive suffix match on basename; no-arg invocation is a
  no-op (publish-flow safety-net wiring shape, not a required
  step). The `package:dogfood` npm script tags its output
  `intellig-<version>-dogfood.vsix` so the artifact carries the
  marker filename inherently — a maintainer who grabs the wrong
  vsix trips this guard the moment their publish script runs
  `npm run check:publish-vsix -- "$vsix"`. The artifact-at-rest
  layer of the placeholder-bypass defense layering. Companion
  specs: `test/unit/scripts/checkPublishVsix.test.ts` (7
  specs: no-arg no-op, real publish, dogfood trip, case-
  insensitivity, basename match, filename-only, mixed-list).
  False-positive log: a legitimately-named extension whose
  actual package name ends in `-dogfood` would be flagged
  (mitigation: tighten the pattern to also check publisher
  prefix). False-negative log: a maintainer who renames the
  dogfood vsix back to `intellig-<version>.vsix` before
  uploading defeats the filename check (mitigation: documented
  in TL-95 section 4 — primary defense is the prepublish-guard's
  noisy `BYPASSED` line, this is the second line of defense
  against "forgot which terminal I built in").

### Defense layering for placeholder bypass

The TL-93 / TL-95 pair is intentionally over-determined: each
guard catches a different temporal failure mode, and the layers
together close the placeholder-bypass surface across the whole
publish flow.

| Layer            | Tool                                                    | Catches                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build-time       | `prepublish-guard.mjs` triple env-gate                  | Maintainer accidentally packages a placeholder-laden tree. Fail-closed unless ALL THREE of `INTELLIG_ALLOW_PLACEHOLDERS=1` + `INTELLIG_DOGFOOD_BUILD=1` + `INTELLIG_DOGFOOD_INVOCATION=1` are set. |
| Artifact-at-rest | `package:dogfood --out intellig-<version>-dogfood.vsix` | Maintainer who legitimately ran `package:dogfood` for local install gets a marker filename so the artifact is unambiguously NOT for upload.                                                        |
| Publish-time     | `check-publish-vsix.sh`                                 | Maintainer (or a publish script) who points `vsce publish` at a `*-dogfood.vsix` is refused before the upload starts.                                                                              |

No single layer is sufficient: a stale shell-export of the three
env vars defeats the build-time gate; a maintainer renaming the
dogfood vsix defeats the artifact-at-rest layer; a maintainer
running `vsce publish` directly without going through the npm
publish-flow script defeats the publish-time check. The layers
together approximate Marketplace-side attestation until that's
available; until then, the cost (3 cheap guards, 1 JSON sidecar)
is small and the failure mode (a credentialed dogfood vsix on
the Marketplace) is irreversible.

## References

- `scripts/check-quickpick-state-no-error.sh` — TL-74 guard.
- `scripts/check-action-toasts-sanitized.sh` — TL-72/78/79 guard.
- `scripts/check-readme-config-coherence.mjs` — Wave 135 R1 H2 +
  R3 M4 guard.
- `scripts/check-vsix-clean.sh` — Wave 135 R1 H3 guard.
- `scripts/check-100-gate.sh` — Wave 135 R3 H1 + TL-96 guard.
- `scripts/prepublish-guard.mjs` + `scripts/prerelease-state.json`
  — TL-93 placeholder-fingerprint dispatcher + JSON sidecar.
- `scripts/check-publish-vsix.sh` — TL-95 dogfood-filename guard.
- `scripts/check-watcher-families-registered.mjs` — TL-87 watcher-family registration guard.
- `scripts/check-output-channel-test-surface.sh` — TL-58 OutputChannel test-surface boundary guard.
- ADR-006 — error-state binding by view type. The rule TL-74 enforces.
- `docs/testing.md` — TestSurface idiom (section 3) and tier-escalation
  guidance (referenced by the per-site spec column).
- `feedback_tdd_workflow.md` (memory) — the "structural guard
  acceptable substitute" clause. This ADR is the criteria that
  clause now points at.
- `feedback_severity_by_impact.md` (memory) — "if flagged, fix it"
  applies to guard-detected violations equally with reviewer
  findings.

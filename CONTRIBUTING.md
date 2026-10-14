# Contributing to IntelliG

Thanks for your interest in contributing to IntelliG.

## Ground rules

- **License.** IntelliG is licensed under the [Apache License 2.0](LICENSE).
  By submitting a contribution you agree that it is licensed under the same
  terms (Apache-2.0 section 5); there is no separate contributor agreement.
- **Code of conduct.** Everyone taking part follows the
  [Code of Conduct](CODE_OF_CONDUCT.md).
- **Security issues** go to
  [private vulnerability reporting](https://github.com/KHC831/intellig/security/advisories/new),
  never a public issue. See [SECURITY.md](SECURITY.md).
- **Code from IntelliJ.** IntelliJ IDEA Community is the behavioral reference.
  A file that translates IntelliJ code keeps JetBrains' copyright line in its
  header and is listed in [`scripts/ported-files.json`](scripts/ported-files.json);
  `npm run check:port-headers` enforces both.
- **Pull requests.** Open an issue first for anything larger than a small fix,
  so the approach can be agreed before you build it. CI runs on pull requests;
  for a first-time contributor a maintainer approves the run. The gate below
  must pass, and UI changes need a manual check in the Extension Development
  Host (F5).

## Prerequisites

- Node.js 20+
- VS Code 1.85+
- Git installed and available on PATH

## Setup

```bash
npm install
```

## Build

```bash
# Typecheck + build the extension bundle (dist/extension.js), the webview
# bundle (media/mergeWindow.js), and the Monaco assets (media/monaco/vs)
npm run compile

# Watch mode — recompiles on file changes
npm run watch
```

## Lint & Format

```bash
npm run lint          # Run ESLint
npm run lint:fix      # ESLint with auto-fix
npm run format:check  # Check formatting (Prettier)
npm run format        # Fix formatting
```

CI enforces zero errors and zero warnings (`npm run lint -- --max-warnings 0`).
Drift from that baseline blocks merge.

### Suppressing a lint rule

Lint rules in this repo aren't cosmetic — see
[`docs/testing.md` section 6](docs/testing.md#section-6-lint-rules-that-catch-real-bugs)
for the class of production bugs they've caught. Before reaching for a
disable, check whether the rule is pointing at something real. When a
disable is genuinely the right call, follow these conventions so every
suppression is reviewable on its own.

- **Preferred shape: `eslint-disable-next-line` with a rationale.** The
  disable applies to exactly one line and the rationale lives on the
  same line, right after a `--` separator:

  ```ts
  // eslint-disable-next-line @typescript-eslint/no-floating-promises -- fire-and-forget timer; rejection logged to OutputChannel
  setTimeout(() => this._refresh(), 300);
  ```

  The `--` form is readable in diffs, greppable by rule name, and
  explicit about _why_ the rule doesn't apply here.

- **File-level `/* eslint-disable <rule> */`** — reserved for files
  where the rule genuinely doesn't apply at all (generated code, test
  scaffolding with an intentional structural shape the rule rejects).
  Requires a JSDoc-style rationale comment at the top of the file
  explaining the scope:

  ```ts
  /* eslint-disable @typescript-eslint/require-await --
   * Test stub factories synthesise IShelfService implementations
   * whose method signatures return Promise<T>; the no-await stub
   * bodies are intentional to match the interface contract.
   */
  ```

- **Blanket `/* eslint-disable */`** — don't. If more than one rule is
  genuinely noise for a file, list them by name in a file header so the
  next reader sees which rules you meant to silence and can reconsider
  each one independently.

- **Review expectation.** Every new disable is a reviewer finding. The
  reviewer either accepts the rationale or asks you to rewrite the code
  so the rule passes. Code that silently introduces disables under the
  radar regresses the lint baseline — we've spent several phases
  cleaning it up and the zero-warning gate exists so the work stays
  done.

#### Pre-approved disables

A narrow set of disables is already accepted in this repo and does not
need per-PR review. Reviewers may still push back, but the onus is on
the reviewer to justify tightening — the patterns below have been
audited and land the "disable is cheaper than rewrite" way.

- **`@typescript-eslint/require-await` on interface-contract methods
  whose body is legitimately synchronous.** Several `ChangelistService`
  entry points (`setActiveChangelist`, `getActiveChangelist`,
  `getChangelistForFile`) return `Promise<T>` because the interface
  contract commits to an async shape even though the current
  implementation resolves synchronously — a future cache-miss path
  (deferred storage read, lazy revalidation) will actually await, and
  the public signature should not churn when that lands. Any symmetric
  `ShelfService` / other service method with the same interface-first
  rationale qualifies. Use `eslint-disable-next-line` with a rationale
  naming the interface contract.

- **File-level `require-await` disable for test-stub factory files that
  follow the variadic-`unknown[]` `throwError` pattern
  (see [`docs/testing.md` section 3](docs/testing.md#section-3-the-testsurface-idiom)).**
  Those factories synthesise service implementations whose method
  signatures return `Promise<T>`; the no-await stub bodies are
  intentional because the whole point is that every method throws. A
  JSDoc-style file-header disable with a pointer to the pattern doc is
  the right shape.

### Upgrading `@typescript-eslint`

Each `@typescript-eslint` minor/major bump ships new rules. We treat
rule adoption as a deliberate engineering decision, not a default, so
the bump goes through a triage pass:

1. **Must-adopt.** The new rule catches a bug class we've seen in
   production, or tightens type safety on a hot path (e.g. a rule that
   would have caught `no-floating-promises`-style bugs before they
   shipped). Enable it in `.eslintrc.json`. Fix the call sites. Update
   [`docs/testing.md` section 6](docs/testing.md#section-6-lint-rules-that-catch-real-bugs)
   with a one-paragraph "why this rule" note.

2. **Opt-in.** Cosmetic but improves grep/readability (e.g.
   `consistent-type-imports`, `prefer-nullish-coalescing`). Enable at
   the cost of one focused refactor phase; don't mix with unrelated
   work.

3. **Skip.** Requires widespread rewrites for ambiguous benefit, or the
   rule is known-buggy on a shape we rely on. Document the skip reason
   with a line comment in `.eslintrc.json`:

   ```jsonc
   // Skipped: would require rewriting ~200 call sites with no
   //         observed bug class; revisit if the team grows past ~10.
   "@typescript-eslint/prefer-readonly-parameter-types": "off",
   ```

4. **Process (single rule / small bump).** Open a task per rule
   decision (must-adopt, opt-in, or skip-with-rationale). Adopt each
   must-adopt / opt-in rule in a focused phase — the Phase 1-4 lint
   cleanups (no-floating-promises, require-await, no-unsafe-\*,
   residuals) are the exemplar. Each phase lands with a senior +
   tech-lead review; the CI gate moves to zero-warnings once all
   must-adopt rules are clean.

5. **Process (bulk bump, 5+ new rules).** One task per rule is noise.
   Instead open one _parent_ triage task with a must-adopt / opt-in /
   skip table covering every new rule in the bump. Spawn sub-tasks
   only for the must-adopt and opt-in rows — each of those still gets
   its own focused phase + review. Skip-with-rationale entries land
   inline as line comments in `.eslintrc.json` directly from the
   parent task, no sub-task needed.

6. **Optional: quarterly skip revisit.** Skipped rules can age into
   must-adopt (the team grows, the hot path shifts, a bug class the
   rule catches shows up in production). A quarterly pass over the
   `.eslintrc.json` skip list — re-checking each rationale against the
   current codebase shape — is cheap and keeps the skip list from
   calcifying. No rule is permanently skipped; the comment explains
   _why today_ it's skipped, not _why forever_.

## Tests

Unit tests use mocha with ts-node and run directly from TypeScript source. Property-based tests (fast-check) run from compiled JS.

Per-test timeouts (raised in Wave A R1/R2 to absorb CPU-contention flakes
the original defaults were susceptible to):

- `test:unit` — 30s (`.mocharc.json` `timeout`). Wave A R2 raised this from
  10s after a `ChangelistService.test.ts` `before each` hook flaked once
  under load. Re-running the file alone passed in 8s — same pattern as
  the property-suite flake R1 caught: a single slow test legitimately
  needs more headroom on a busy host.
- `test:property` — 60s (`package.json` `test:property` script). Wave A R1
  raised this from 30s. The fast-check shrinking pass for some property
  suites legitimately exceeds 30s on a busy machine; 60s is a
  margin-of-safety choice that does not change pass rates on a quiet host.

Both raises are CI-friendly: the 99th-percentile actual run time on a
quiet host is well under the new ceilings, so the timeouts only fire on
genuine hangs.

```bash
# Unit tests (uses .mocharc.json — runs from src/)
npx mocha

# Unit tests — single file
npx mocha --grep "GitService"

# Property-based tests
npm run test:property

# Property-based tests — single file
npx mocha --require ts-node/register --timeout 60000 test/property/stashRoundTrip.property.test.ts

# All in-process tests together (lint + unit + property)
npm test

# VS Code integration tests (launches Extension Host)
npm run test:ext-host
npm run test:e2e
```

### Gate tiers

There are two gates, and which one you owe depends on what you changed.

- **`npm test` — the per-change gate.** Runs on every edit. It chains
  lint (`--max-warnings 0`), `tsc`, the structural guards
  (`check:all`), and the in-process `test:unit` + `test:property`
  suites. Fast and mock-level: the VS Code API is faked, so no real
  Extension Host or git subprocess is exercised. This is the gate you
  run constantly while iterating.

- **`npm run gate:full` — the pre-merge gate.** Runs `npm test` first
  (fastest-first, so lint/type/unit failures surface before the slow
  lanes), then the two runtime tiers: `test:ext-host` (boots a real VS
  Code host, activates the extension, asserts every declared command
  registers) and `test:e2e` (runs each command against a real temp-dir
  git repo and verifies the effect by re-reading git state). On macOS a
  real VS Code is downloaded and launched by the test runner, so no
  `xvfb` is needed locally; the runtime lanes take roughly 12-14 minutes
  and will briefly pop up transient VS Code windows that close
  themselves.

**`npm run gate:full` is REQUIRED before merging any change that touches:**

- a webview (the Git tool window, commit tool window, merge view, or any
  HTML/script builder),
- an explorer, editor, or SCM command (anything under
  `intellig.explorer.*`, `intellig.editor.*`, `intellig.commit.*`,
  `intellig.branch.*`, and the like),
- command registration or wiring (adding, renaming, or re-routing a
  command handler), or
- a context menu (the `menus` / `submenus` blocks in `package.json`).

**Why this matters.** This project's day-to-day workflow is local-only:
changes land on local `main` and the runtime lanes in CI
(`.github/workflows/ci.yml`) only run once work is pushed. The
develop-and-merge cycle never triggers CI, so the ext-host and e2e
lanes effectively never run during development unless you run them. The
only thing keeping those suites green is `gate:full` being run locally
before a merge.

Two concrete failure modes this catches, both of which slipped past the
mock-level `npm test`:

- **Specs rot silently.** Because nobody ran `test:e2e` per change,
  three e2e specs (tags and commit-revert coverage) had quietly gone
  stale on `main` and had to be repaired before an unrelated explorer
  fix could merge. Mock unit tests stayed green the whole time and gave
  no signal.

- **Runtime and wiring bugs escape the mocks.** The explorer
  context-menu Git ops targeted the wrong path because `asRelativePath`
  behaves differently against a real workspace than against the mock —
  only an e2e run against a real repo surfaces it. Likewise a webview
  script that threw on `acquireVsCodeApi` looked fine to the unit
  suite (which never loads the webview) and only failed when a real
  Extension Host evaluated the script. `gate:full` is the lane that
  exercises both.

> **Known future test-infra task.** Multi-repo e2e fixtures (running
> the e2e suite against a workspace with more than one repository) are
> not yet wired — canonicalizing the `runTests.ts` sentinel to enable
> them surfaces a flaky clipboard test that needs its own fix first.

## Local Development

```bash
# 1. Compile the extension
npm run compile

# 2. Open this folder in VS Code, then press F5
#    This launches the Extension Development Host with the extension loaded.

# Or use watch mode for continuous compilation:
npm run watch
# Then press F5 in VS Code to launch the Extension Development Host.
```

## Packaging

Maintainers: release checks and publishing are in [docs/RELEASING.md](docs/RELEASING.md).

```bash
# Install vsce if you don't have it
npm install -g @vscode/vsce

# Package as .vsix
npx vsce package

# Install the .vsix in VS Code:
#   Extensions panel → ⋯ → Install from VSIX...
```

The `vscode:prepublish` script chains a `prepublish:guard`
([`scripts/prepublish-guard.mjs`](scripts/prepublish-guard.mjs)) that
refuses to package when LICENSE / icon / CHANGELOG date / SECURITY.md
contact are still placeholders. The guard reads its placeholder
fingerprints from
[`scripts/prerelease-state.json`](scripts/prerelease-state.json) —
add a new entry there (not in the script) when a 5th placeholder
class lands; update `placeholderHash` there (not in the script)
when the icon is replaced. If you see a `[prepublish-guard] FAIL:
…` message during `npx vsce package`, fill in the indicated
placeholder and try again.

### Structural guards

The repo ships a set of CI-time structural guards as a complement
to per-site unit specs (rationale + maintenance contract:
[ADR-007](docs/adr/ADR-007-structural-guards-as-complementary-tool.md)).
Each guard has its own npm-script alias under `check:*`; CI runs
them as named steps so a regression points at the offending
class. Run a single guard locally as `npm run check:<name>`:

| `check:` script                     | Guard                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `check:quickpick-state`             | `IShelf/Stash/BranchComparisonViewState` carry no `error` field (TL-74)            |
| `check:action-toasts`               | `vscode.window.show*Message` calls don't leak unsanitized git stderr (TL-72/78/79) |
| `check:config-coherence`            | README config tables match `package.json` schema defaults                          |
| `check:vsix-clean`                  | `vsce ls` output excludes every forbidden file class                               |
| `check:100-gate`                    | 1.0.0 gate checklist + structural gate (2) (TL-96)                                 |
| `check:publish-vsix`                | Refuses any `*-dogfood.vsix` filename (TL-95)                                      |
| `check:output-channel-test-surface` | OutputChannel test seam not used in production (Cluster C, TL-58)                  |

`npm run check:all` runs every structural guard in sequence — the
recommended pre-push smoke. CI keeps the steps named individually
so failures point at a specific guard rather than the umbrella.
Adding a new guard means: ship the script + ADR-007 maintenance-
contract header + an `check:<name>` npm alias + an entry in this
table + an entry in `check:all` + a CI step. All six places must
land together; reviewers will catch any miss.

> **Note (transient):** `check:output-channel-test-surface` lands
> with Cluster C (TL-58); until that branch merges to main,
> `npm run check:all` will fail at this step with an opaque
> "Missing script" error. Run individual `check:*` scripts from
> the table above in the meantime, or skip the umbrella entirely.
> TL-100 (#229) tracks the CI-side collapse of the individual
> guard steps into a single `npm run check:all` step once Cluster
> C lands the missing alias.

## Changelog cadence

`CHANGELOG.md` follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Workflow:

1. Every wave-squash that changes user-visible behavior appends a
   bullet to the `## [Unreleased]` section at the top of
   `CHANGELOG.md`. Categorize under `### Added`, `### Changed`,
   `### Fixed`, `### Removed`, or `### Deprecated`.
2. At release time, rename `[Unreleased]` to the new version with
   today's date, then add a fresh empty `[Unreleased]` block at the
   top.

Example before release:

```markdown
## [Unreleased]

### Added

- New `intellig.foo` config knob that does foo.

## [0.1.0] - 2026-05-XX

…
```

Example after `0.2.0` release:

```markdown
## [Unreleased]

## [0.2.0] - 2026-06-12

### Added

- New `intellig.foo` config knob that does foo.

## [0.1.0] - 2026-05-XX

…
```

The pre-publish guard refuses to package when the top dated entry is
still a `YYYY-MM-DD` placeholder, so the rename-and-date step cannot
be skipped accidentally.

## Versioning policy

IntelliG follows [semver](https://semver.org/), with the following
0.x carve-outs and the 1.0.0 gate explicitly enumerated:

- **0.x** — settings, commands, and on-disk storage shapes may change
  in minor bumps. Every breaking change in 0.x ships with a
  deprecation note in `CHANGELOG.md`. Forward-compatible storage
  round-trip (see [ADR-003](docs/adr/ADR-003-storage-forward-compat-round-trip.md))
  ensures old state files survive minor bumps without data loss.

  **Deprecated-field retirement timeline.** Each deprecated config
  field is removed from the schema two minor versions after its
  deprecation lands, giving users one full minor cycle to migrate
  via runtime auto-migration (when applicable) plus the
  `deprecationMessage` chrome in the settings UI. Concretely:
  `intellig.useIntelliJKeymap` is deprecated as of v0.1.0 and will
  be removed from the schema in v0.3.0. Subsequent deprecations
  follow the same N → N+2 retirement window unless the
  CHANGELOG entry explicitly states otherwise.

- **1.0.0** — gates on **all** of:
  1. `LICENSE` finalized (real terms, not placeholder).
  2. Experimental flags (`useCommitToolWindow`,
     `useTabbedGitToolWindow`) graduated through the explicit
     sub-protocol below — neither still labeled "Experimental" in
     the schema description nor still gated `false` by default.
  3. `.git`-as-file (linked worktrees, submodules with detached
     gitdir) supported, or explicitly documented as out-of-scope.
  4. At least one full quarterly cycle of user feedback against a
     0.x release where conditions 1-3 are already met.

### Experimental-flag graduation sub-protocol

Each experimental flag follows this pipeline before 1.0.0:

1. **Default-flip in a 0.x minor.** The flag's default flips from
   `false` to `true` in a tagged 0.x release. The flag remains
   in the schema with `default: true` so users on the previous
   default can roll back via settings. CHANGELOG entry calls out
   the flip and the rollback knob.
2. **Quarterly feedback window.** At least one full quarter of
   real-user usage on the new default. The OutputChannel + GitHub
   issues become the data source.
3. **Decision (one of three).**
   - **Remove** — promote to non-optional behavior; delete the flag
     from the schema. Keep storage round-trip preservation so a
     downgrade to a 0.x version that still reads the flag survives.
   - **Keep** — flag stays opt-out (default `true`) but remains
     a documented setting. Common when the behavior should be
     dominant but a small population legitimately wants the
     legacy mode.
   - **Rollback** — feedback was negative; default-flip back to
     `false` in a 0.x patch and re-enter step 1 with revised
     defaults (or shelve indefinitely).

Each flag's pipeline state is tracked inline in the
`contributes.configuration.properties[<flag>].description` text
("Experimental — flipping to default in 0.M.0 / next quarterly
review YYYY-MM-DD").

### 1.0.0 gate checklist

Track the four conditions inline as the project approaches 1.0.0.

- [ ] (1) `LICENSE` finalized — real terms in tree.
- [ ] (2) Experimental flags graduated:
  - [ ] `intellig.useCommitToolWindow` — pipeline state: …
  - [ ] `intellig.useTabbedGitToolWindow` — pipeline state: …
- [ ] (3) `.git`-as-file behavior decided:
  - [ ] Supported, OR
  - [ ] Documented out-of-scope in README.
- [ ] (4) Quarterly feedback cycle complete with conditions 1-3
      met. Cycle start date: …. Cycle end date: ….

**Gates (1) and (2) are structurally enforced.** Marking the
checkbox does not bypass either check.

- **Gate (1) — LICENSE finalized.** Enforced by
  `scripts/prepublish-guard.mjs` via the `license` fingerprint in
  `scripts/prerelease-state.json`: a placeholder LICENSE blocks
  `vsce package` regardless of checkbox state. The fingerprint
  flags any LICENSE that contains ≥2 of the configured placeholder
  markers (`License pending`, `PLACEHOLDER`, `evaluation purposes
only`); a real EULA can legitimately contain one phrase in
  isolation, two together is the trip threshold.
- **Gate (2) — Experimental flags graduated.** Enforced by
  `scripts/check-100-gate.sh` running parse logic against
  `package.json` (TL-96): each experimental flag must be either
  (i) absent from `contributes.configuration.properties` (Remove
  decision) OR (ii) have `default !== false` AND no longer mention
  "Experimental" in its `description` / `markdownDescription`.

Gates (3) and (4) remain markdown-checkbox by their nature (the
`.git`-as-file scope decision and the time-bounded user-feedback
cycle aren't mechanically checkable from `package.json` shape
alone). TL-98 (#226) tracks promoting gate (3) once Cluster A's
TL-87 lands a structural marker for `.git`-as-file support.

Pre-1.0.0 releases are 0.MINOR.PATCH; the parity of MINOR has no
special meaning.

## Project Structure

Source lives under `src/`, grouped into topical directories by feature
area rather than one flat `services/` folder. Each topical directory
owns its services, views, dialogs, and an `interfaces/` subfolder for
the matching TypeScript interfaces. The `src/services/` folder is kept
thin on purpose — only the public barrel and the DI composition root
live there.

```
src/
├── git-core/          # Core git plumbing: GitService, RebaseService,
│   ├── gitToolWindow/ #   the git tool window UI (tightly bound to IGitService),
│   │   ├── html/      #   plus git-domain utils that used to live in utils/:
│   │   └── tabs/      #   gitCli, gitParser, gitError, commitGraph,
│   └── interfaces/    #   commitSort, repoScan
├── branches/          # Branch list / popup / context menu / comparison view
│   └── interfaces/
├── blame/             # Annotate-with-git-blame services + inline/gutter providers
│   └── interfaces/
├── commits/           # Commit dialog, commit tool window, commit-row context menu
├── conflicts/         # Three-way merge view + conflict resolution
│   └── interfaces/
├── patches/           # Patch apply / create / shelf-import
│   └── interfaces/
├── changelists/       # Changelist storage + ops
│   └── interfaces/
├── shelf/             # Shelf and stash UI + services
│   └── interfaces/
├── rebase/            # Interactive rebase editor + progress view
│   └── interfaces/
├── sync/              # Pull / push / auto-fetch
│   └── interfaces/
├── ui-shell/          # Cross-cutting UI services and dialogs:
│   └── interfaces/    #   GitToolWindowProvider (panel host), StatusBarService,
│                      #   NotificationService, KeymapService, ConsoleService, ResetDialog
├── config/            # ConfigurationService + interface
│   └── interfaces/
├── services/          # Kept thin: services barrel (index.ts) +
│   └── interfaces/    #   ExtensionServices.ts (DI composition root);
│                      #   interfaces/ re-exports from the topical locations above
├── utils/             # Generic, domain-agnostic utilities (cache, atomic write,
│   └── logger/        #   webview bases, graph renderer, etc.)
│       └── sinks/     #   logger/ holds the structured logger subtree
├── extension.ts       # Extension entry point
└── test/
    ├── mocks/         # VS Code API mock for testing outside Extension Host
    ├── unit/          # Unit tests (mocha + assert)
    ├── property/      # Property-based tests (mocha + fast-check)
    ├── typed/         # Type-level tests
    ├── ext-host/      # Extension Host smoke tests
    ├── e2e/           # End-to-end suites
    └── suite/         # VS Code integration tests
```

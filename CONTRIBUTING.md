# Contributing to IntelliG

Thanks for your interest in contributing to IntelliG.

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
# Compile TypeScript to JavaScript (output in out/)
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
[`docs/testing.md` §6](docs/testing.md#6-lint-rules-that-catch-real-bugs)
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
  explicit about *why* the rule doesn't apply here.

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
  (see [`docs/testing.md` §3](docs/testing.md#3-the-testsurface-idiom)).**
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
   [`docs/testing.md` §6](docs/testing.md#6-lint-rules-that-catch-real-bugs)
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
   cleanups (no-floating-promises, require-await, no-unsafe-*,
   residuals) are the exemplar. Each phase lands with a senior +
   tech-lead review; the CI gate moves to zero-warnings once all
   must-adopt rules are clean.

5. **Process (bulk bump, 5+ new rules).** One task per rule is noise.
   Instead open one *parent* triage task with a must-adopt / opt-in /
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
   *why today* it's skipped, not *why forever*.

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

# Property-based tests (compile first, run from out/)
npm run compile
npx mocha --no-config --require out/test/setup.js 'out/test/property/**/*.property.test.js' --timeout 60000 --exit

# Property-based tests — single file
npm run compile
npx mocha --no-config --require out/test/setup.js 'out/test/property/stashRoundTrip.property.test.js' --timeout 60000 --exit

# All tests together (unit + property)
npm run compile
npx mocha --timeout 60000
npx mocha --no-config --require out/test/setup.js 'out/test/property/**/*.property.test.js' --timeout 60000 --exit

# VS Code integration tests (launches Extension Host)
npm test
```

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

## Release Dogfood

Before declaring an extension change done, press F5 (see [Local Development](#local-development)) to launch the Extension Development Host and verify each of the following. Automated tests do not cover runtime behavior like idle-loop detection, CPU usage, or UX regressions.

1. **Activation is silent.** Open a workspace with a git repo. Wait 60 seconds. The dev-host console and the Git Output channel must show activation messages only once and stay quiet afterward. Repeating subprocess spam (`Git: status`, `Git: log` cycling) indicates a refresh loop — do not ship.

2. **CPU settles.** After activation, switch to the dev host and do nothing for 30 seconds. Check Activity Monitor / Task Manager for the extension host process. CPU should drop to near-zero when idle.

3. **Golden-path features work.** Run one command from each major area:
   - Log tab: open the Git tool window; commits render.
   - Branch menu: right-click a branch → "Show Diff with Working Tree" opens diff tabs.
   - Commit tool window (if `intellig.useCommitToolWindow` is on): Local Changes + Shelf tabs render.
   - Push/pull: `IntelliG: Push` and `IntelliG: Pull` work against a test remote.
   - Rebase: interactive rebase of the last 2 commits opens the editor; pick/squash succeed.
   - Shelf: `IntelliG: Shelve Silently`, then `IntelliG: Show Shelf List`.
   - Conflicts: create a merge conflict (`git merge <conflicting-branch>`); the resolve dialog opens; "Accept Yours" / "Accept Theirs" / "Abort" each succeed.

4. **Flags toggle cleanly.** Toggle `intellig.useCommitToolWindow` and `intellig.useTabbedGitToolWindow` off → on → off. Views rebind without activation errors or stale state.

5. **Multi-repo discovery.** Open a workspace folder containing two `.git` subfolders (e.g. `~/work/` with `~/work/projectA/.git` and `~/work/projectB/.git`). Verify both are discovered — the IntelliG branch popup or status bar should let you switch between them, and `getRepositories()` (via the Git tool window) should list both.

6. **Mid-session new-repo detection.** Inside an open workspace folder, run `git init newproj/`. Verify the new repo is auto-detected without a window reload — it should show up in the branch popup / repo picker within a few seconds.

7. **Output channel readable.** Open `Output → IntelliG`. Verify the channel exists and is readable for at least one error path — for example, force a known-bad `IntelliG: Import Patches into Shelf` operation (point at a non-applicable patch) and confirm sanitized per-file diagnostics appear in the channel.

8. **Deactivation is clean.** Close the dev host. It exits within ~2 seconds. No orphaned `node` processes in Activity Monitor.

If any of the above fails: do not ship.

## Packaging

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

### Publishing to the Marketplace

The publish flow expects a **non-dogfood** vsix filename. There are
two build paths:

- **Real publish** — `npx --yes @vscode/vsce@2.24.0 package` (no
  env vars set). Output: `intellig-<version>.vsix`. The
  prepublish guard runs and asserts the tree has no placeholders.
  This is the artifact you upload to the Marketplace.
- **Local dogfood** — `npm run package:dogfood`. Output:
  `intellig-<version>-dogfood.vsix` (note the `-dogfood` suffix).
  Engages the placeholder bypass; the resulting .vsix is for local
  install only and MUST NOT be uploaded.

> **Shell requirement.** Both build paths assume a POSIX shell
> (sh / bash / zsh). The `package:dogfood` npm script uses inline
> `KEY=VALUE` env-var prefixes and `${npm_package_version}`
> expansion in `--out`, neither of which native cmd.exe /
> PowerShell handle. Windows maintainers should run from Git Bash
> or WSL.

`npm run check:publish-vsix -- <path>` is a filename-based safety
net that refuses to proceed when the path matches `*-dogfood.vsix`
(TL-95). The leading `--` is required so npm forwards `<path>` to
the script instead of consuming it as an npm option (without it,
the script sees zero args, no-ops, and the safety net is silently
defeated). Wire it into your publish script before invoking
`vsce publish`:

```bash
# Pseudo publish flow
vsix="intellig-$(node -p 'require("./package.json").version').vsix"
npx --yes @vscode/vsce@2.24.0 package          # writes $vsix
npm run check:publish-vsix -- "$vsix"          # refuses if *-dogfood.vsix
npx --yes @vscode/vsce@2.24.0 publish -i "$vsix"
```

#### One-time publisher setup

Before the first publish you need a Microsoft account, a Marketplace
publisher entry, and an Azure DevOps Personal Access Token (PAT).

1. Sign in at <https://marketplace.visualstudio.com/manage> with the
   Microsoft account that will own the extension.
2. Confirm the publisher ID `intellig-vscode` exists and you own it,
   or create it.
3. Generate a PAT at <https://dev.azure.com/> → top-right avatar →
   **Personal Access Tokens** → **New Token**:
   - **Organization**: "All accessible organizations" (Marketplace
     tokens require this — a single-org PAT will be rejected by
     `vsce login`).
   - **Scopes**: Custom defined → check **Marketplace → Manage**.
   - Copy the token immediately; it cannot be viewed again.
4. Authenticate `vsce` with the PAT:

   ```bash
   npx --yes @vscode/vsce@2.24.0 login intellig-vscode
   # Paste the PAT when prompted.
   ```

   The credential is cached under `~/.vsce/` for subsequent
   `publish` runs; you do not need to re-login on every release.

#### First-release dogfood checklist

Before running `vsce publish`, confirm the artifact actually works
when installed (F5 / Extension Development Host runs source, not the
packaged `.vsix`, so it bypasses `.vscodeignore`, the manifest, and
the icon path — none of which F5 exercises):

```bash
# 1. Inspect the manifest as the Marketplace will render it.
unzip -p intellig-<version>.vsix extension.vsixmanifest | grep -E \
  "Identity|Description|GalleryFlags|Source|Support|Learn"

# 2. Confirm the file list (no .kiro/, no src/, no internal docs).
npx --yes @vscode/vsce@2.24.0 ls

# 3. Install into your real VS Code (not the Dev Host).
code --install-extension intellig-<version>.vsix
# In VS Code: Cmd-Shift-P → 'Developer: Reload Window'.
# Use the extension for a few minutes against a real repo.

# 4. (optional) Roll back when done.
code --uninstall-extension intellig-vscode.intellig
```

If `code` is not on your `PATH`: open VS Code, Cmd-Shift-P,
`Shell Command: Install 'code' command in PATH`. Or use the GUI:
Cmd-Shift-P, `Extensions: Install from VSIX...`, browse to the
`.vsix`.

#### Publishing the artifact

Run from a clean tree with the version-bumped `package.json` already
committed and pushed. The Marketplace ingests whatever is in the
uploaded `.vsix` — the source repo state at publish time is not
checked, but matching the two avoids drift between the published
artifact and tagged history.

```bash
# Build the .vsix (placeholder guard runs automatically).
npx --yes @vscode/vsce@2.24.0 package

# Publish the EXACT .vsix you just inspected, not a re-built one
# (--packagePath bypasses vsce's implicit re-package).
npx --yes @vscode/vsce@2.24.0 publish \
  --packagePath intellig-<version>.vsix
```

The listing typically appears at
<https://marketplace.visualstudio.com/items?itemName=intellig-vscode.intellig>
within five to ten minutes. The Marketplace runs an automated virus
scan; if it flags, you get an email.

#### Pre-release channel (optional)

If you want a wider but opt-in test audience before promoting to the
stable channel, publish with `--pre-release`. Users have to toggle
"Pre-Release Version" in the VS Code Extensions UI to see it.

```bash
npx --yes @vscode/vsce@2.24.0 publish \
  --pre-release \
  --packagePath intellig-<version>.vsix
```

This is independent of `"preview": true` in `package.json`, which
controls the listing's PREVIEW badge. The two can be combined or
used separately.

#### What you cannot undo

- A specific version cannot be deleted from the Marketplace. To fix
  a bad release, ship `<version>+1` with the fix and rely on auto-
  update; users on the bad version migrate forward.
- The entire extension can be unpublished, but reusing the same
  publisher + extension ID later is restricted by Microsoft.
- Removing `"preview": true` is one-way per version. Once a version
  is published as preview, that flag stays for that version; the
  next version can drop it.

### Publishing to Open VSX

The VS Code Marketplace is Microsoft's gallery and is not used by
non-Microsoft Code-OSS forks (Kiro, VSCodium, Cursor, Theia-based
IDEs). Those IDEs read from [Open VSX](https://open-vsx.org), an
Eclipse-Foundation-run alternative gallery. Publishing to both
makes IntelliG installable across the entire VS Code-derived
ecosystem with a single artifact (the same `.vsix` works in both).

#### One-time Open VSX setup

1. Sign in at <https://open-vsx.org/login> with GitHub.
2. Create a namespace matching your `package.json` `"publisher"`
   field — visit <https://open-vsx.org/user-settings/namespaces>,
   click **Create namespace**, use the same publisher ID as
   the Marketplace setup (e.g., `KaHoChan`).
3. Generate an Open VSX token at
   <https://open-vsx.org/user-settings/tokens> → **Generate new
   token**. Copy it immediately; the value is shown only once.
4. Export the token in the shell that will run the publish:

   ```bash
   export OPEN_VSX_TOKEN='<token>'
   ```

   Add it to your shell profile (`~/.zshrc`, `~/.bashrc`) or store
   in a gitignored `.env.publish` you source before publishing.
   **Never commit the token.**

#### Publishing the artifact

The `.vsix` you built for the Marketplace works on Open VSX without
modification. Upload via `ovsx`:

```bash
npx --yes ovsx@latest publish intellig-<version>.vsix \
  -p "$OPEN_VSX_TOKEN"
```

Open VSX runs an automated check and the listing typically appears
within a few minutes at:

```
https://open-vsx.org/extension/<publisher>/<name>
```

### `npm run release` (combined publish flow)

`scripts/publish.sh` automates the build + dual-gallery publish so
shipping a release is one command. The script:

1. Refuses to run if the working tree is dirty, the current branch
   isn't `main`, or local `main` is out of sync with `origin/main`.
2. Cleans `out/` and rebuilds the `.vsix` from scratch (avoids the
   stale-`out/` class of bug that ships duplicate compiled JS when
   files have moved).
3. Runs the same `check:publish-vsix` filename guard as the manual
   flow.
4. Prints the manifest's identity / description / gallery flags so
   you can spot-check before bytes leave your machine.
5. Publishes to the Marketplace via `vsce publish --packagePath`,
   then publishes the same artifact to Open VSX via `ovsx publish`.
6. Prints the listing URLs.

#### Common invocations

```bash
# Dry-run: build + inspect, do not publish.
npm run release:dry

# Publish whatever is in package.json today (no version bump).
npm run release

# Bump version then exit (you commit + push, then re-run plain `release`).
bash scripts/publish.sh patch       # 0.1.1 → 0.1.2
bash scripts/publish.sh minor       # 0.1.2 → 0.2.0
bash scripts/publish.sh 0.3.0       # explicit

# Publish to only one gallery (useful when one is down).
bash scripts/publish.sh --skip-ovsx
bash scripts/publish.sh --skip-vsce
```

The version-bump path **deliberately exits without publishing** so
you have a chance to commit + push the bump before the artifact
goes out. Mismatched source-tree-vs-published-artifact state is
the #1 source of confusion when chasing a release bug; the script
refuses to enable it.

#### Pre-flight checklist

Before running `npm run release`, manually verify:

- [ ] CHANGELOG.md has a dated entry for the version (no
      `[Unreleased]` content unless it belongs there).
- [ ] Lint, unit tests, property tests pass (`npm run lint &&
      npm run test:unit && npm run test:property`).
- [ ] You've installed the rebuilt `.vsix` locally and dogfooded
      it briefly. The gallery upload is what users will get; F5
      doesn't exercise it. (Use `--dry-run` to produce the
      `.vsix`, install via `code --install-extension`, then
      re-run without `--dry-run` once you're satisfied.)
- [ ] `OPEN_VSX_TOKEN` is exported (or you're passing
      `--skip-ovsx`).

### Tag-triggered GitHub Action (recommended for routine releases)

`.github/workflows/publish.yml` runs `scripts/publish.sh`'s build
+ dual-publish flow on GitHub's runners whenever you push a semver
tag (e.g. `v0.1.2`, `v0.2.0`). The Action:

1. Checks out the tagged commit.
2. Runs lint, unit tests, and property tests as gates — a tag
   pushed against a broken commit refuses to publish.
3. Verifies the tag's numeric portion matches `package.json`'s
   `version` field on that commit (so `git tag v0.2.0` on a commit
   where `package.json` says `0.1.5` fails fast).
4. Builds the `.vsix`, refuses dogfood-suffixed artifacts, and
   prints the manifest for the run log.
5. Publishes to the Marketplace via `vsce publish --pat`.
6. Publishes the same `.vsix` to Open VSX via `ovsx publish`.
7. Uploads the `.vsix` as a workflow artifact (90-day retention)
   so you can audit what shipped against the tagged source.

#### One-time GitHub setup

The Action needs two secrets. Add them at:
**repo → Settings → Secrets and variables → Actions → New
repository secret.**

- `VSCE_PAT` — Azure DevOps PAT under publisher `KaHoChan` with
  the **Marketplace → Manage** scope and "All accessible
  organizations" set as the org. (Same PAT used for local
  `vsce login`; you can reuse it.)
- `OPEN_VSX_TOKEN` — Open VSX token from
  <https://open-vsx.org/user-settings/tokens>.

Both tokens are write-only secrets — once stored, you cannot read
them back through the GitHub UI. Re-create them when they expire
(Azure PATs typically expire after 90 days).

#### Triggering a release

Once `package.json` is bumped, CHANGELOG entry is dated, and the
commit is on `main`:

```bash
# From a clean main with the bump committed + pushed.
git tag v0.1.2
git push origin v0.1.2
```

Watch the run at **repo → Actions → Publish**. End-to-end takes
~3 minutes on a clean run.

#### Failure modes and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `tag version does not match package.json` | Tagged a commit where `package.json` is at a different version. | Delete the tag locally + on origin (`git tag -d`, `git push origin :refs/tags/<tag>`), bump `package.json`, commit, push, re-tag. |
| `VSCE_PAT secret is not set` | Secret missing or renamed. | Add it at repo → Settings → Secrets → Actions. |
| `vsce publish ... 401` | PAT expired. | Generate a new PAT at <https://dev.azure.com/>, update the `VSCE_PAT` secret. |
| `ovsx publish ... 403` | Open VSX token revoked or namespace mismatch. | Confirm the token's owner has the `KaHoChan` namespace; regenerate the token if needed. |
| `version 0.1.X already exists` | You re-tagged an already-published version. | Bump to `0.1.X+1` (Marketplace will not let you overwrite). |

#### Local script vs. Action

The local `scripts/publish.sh` and the Action publish the same way
and produce identical artifacts. Use whichever is more convenient
for the moment:

- Local script: faster feedback loop while you're iterating on
  release tooling itself, or when the Action is misconfigured and
  you want to ship anyway. Tokens stay on your laptop.
- Action: hands-off, no local setup needed, audit log is the
  workflow run, secrets live in GitHub. Best for routine releases
  once the pipeline is stable.

### Structural guards

The repo ships a set of CI-time structural guards as a complement
to per-site unit specs (rationale + maintenance contract:
[ADR-007](docs/adr/ADR-007-structural-guards-as-complementary-tool.md)).
Each guard has its own npm-script alias under `check:*`; CI runs
them as named steps so a regression points at the offending
class. Run a single guard locally as `npm run check:<name>`:

| `check:` script | Guard |
|---|---|
| `check:quickpick-state` | `IShelf/Stash/BranchComparisonViewState` carry no `error` field (TL-74) |
| `check:action-toasts` | `vscode.window.show*Message` calls don't leak unsanitized git stderr (TL-72/78/79) |
| `check:config-coherence` | README config tables match `package.json` schema defaults |
| `check:vsix-clean` | `vsce ls` output excludes every forbidden file class |
| `check:100-gate` | 1.0.0 gate checklist + structural gate (2) (TL-96) |
| `check:publish-vsix` | Refuses any `*-dogfood.vsix` filename (TL-95) |
| `check:output-channel-test-surface` | OutputChannel test seam not used in production (Cluster C, TL-58) |

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

## Backlog tracking

Open follow-up tasks are tracked in the team's TaskList (the same
system that drives wave dispatches). To find them, use whatever
TaskList interface your tooling provides; the canonical IDs for
open follow-ups deferred from prior waves are listed below as
forward references so future contributors can grep for them.

- **TL-92** — ADR-README: define the trigger criterion for the
  "~12-entry topical regroup" guidance.
- **TL-93** — pre-publish placeholder consolidation into a single
  `prerelease-state.json` (or similar) so all checks read from
  one source.

This section is intentionally short — the TaskList is authoritative
for state. Cite tasks here only when a future contributor would
otherwise be unable to discover them via grep.

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
│   └── interfaces/    #   commitSort, optimizedCommitGraph, repoScan
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

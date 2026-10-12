# Releasing IntelliG

Maintainer-only steps for checking and publishing a release. Contributors do
not need any of this: see [CONTRIBUTING.md](../CONTRIBUTING.md).

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

## Publishing to the Marketplace

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

### One-time publisher setup

Before the first publish you need a Microsoft account, a Marketplace
publisher entry, and an Azure DevOps Personal Access Token (PAT).

1. Sign in at <https://marketplace.visualstudio.com/manage> with the
   Microsoft account that will own the extension.
2. Confirm the publisher ID `KaHoChan` exists and you own it,
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
   npx --yes @vscode/vsce@2.24.0 login KaHoChan
   # Paste the PAT when prompted.
   ```

   The credential is cached under `~/.vsce/` for subsequent
   `publish` runs; you do not need to re-login on every release.

### First-release dogfood checklist

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
code --uninstall-extension KaHoChan.intellig
```

If `code` is not on your `PATH`: open VS Code, Cmd-Shift-P,
`Shell Command: Install 'code' command in PATH`. Or use the GUI:
Cmd-Shift-P, `Extensions: Install from VSIX...`, browse to the
`.vsix`.

### Publishing the artifact

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
<https://marketplace.visualstudio.com/items?itemName=KaHoChan.intellig>
within five to ten minutes. The Marketplace runs an automated virus
scan; if it flags, you get an email.

### Pre-release channel (optional)

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

### What you cannot undo

- A specific version cannot be deleted from the Marketplace. To fix
  a bad release, ship `<version>+1` with the fix and rely on auto-
  update; users on the bad version migrate forward.
- The entire extension can be unpublished, but reusing the same
  publisher + extension ID later is restricted by Microsoft.
- Removing `"preview": true` is one-way per version. Once a version
  is published as preview, that flag stays for that version; the
  next version can drop it.

## Publishing to Open VSX

The VS Code Marketplace is Microsoft's gallery and is not used by
non-Microsoft Code-OSS forks (Kiro, VSCodium, Cursor, Theia-based
IDEs). Those IDEs read from [Open VSX](https://open-vsx.org), an
Eclipse-Foundation-run alternative gallery. Publishing to both
makes IntelliG installable across the entire VS Code-derived
ecosystem with a single artifact (the same `.vsix` works in both).

### One-time Open VSX setup

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

### Publishing the artifact

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

## `npm run release` (combined publish flow)

`scripts/publish.sh` automates the build + dual-gallery publish so
shipping a release is one command. The script:

1. Refuses to run if the working tree is dirty, the current branch
   isn't `main`, or local `main` is out of sync with `origin/main`.
2. Cleans `dist/` and rebuilds the `.vsix` from scratch (avoids the
   stale-artifact class of bug that ships duplicate compiled JS when
   files have moved).
3. Runs the same `check:publish-vsix` filename guard as the manual
   flow.
4. Prints the manifest's identity / description / gallery flags so
   you can spot-check before bytes leave your machine.
5. Publishes to the Marketplace via `vsce publish --packagePath`,
   then publishes the same artifact to Open VSX via `ovsx publish`.
6. Prints the listing URLs.

### Common invocations

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

### Pre-flight checklist

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

## Tag-triggered GitHub Action (recommended for routine releases)

`.github/workflows/publish.yml` runs `scripts/publish.sh`'s build

- dual-publish flow on GitHub's runners whenever you push a semver
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

### One-time GitHub setup

The Action reads two secrets. Add them at:
**repo → Settings → Secrets and variables → Actions → New
repository secret.**

- `OPEN_VSX_TOKEN` — **REQUIRED**. Open VSX token from
  <https://open-vsx.org/user-settings/tokens>. The Open VSX publish
  step fails the run if this is missing.
- `VSCE_PAT` — **OPTIONAL**. Azure DevOps PAT under publisher
  `KaHoChan` with the **Marketplace → Manage** scope and "All
  accessible organizations" set as the org. When this secret isn't
  set, the Marketplace publish step **skips with a clear log line
  instead of failing**. Add it later to enable automated Marketplace
  publishing without editing the workflow. Until then, upload the
  built `.vsix` manually at
  <https://marketplace.visualstudio.com/manage/publishers/KaHoChan>.

Both tokens are write-only secrets — once stored, you cannot read
them back through the GitHub UI. Re-create them when they expire
(Azure PATs typically expire after 90 days).

### Triggering a release

The Action runs against `main` only. First make sure the version
bump and dated CHANGELOG entry are committed and pushed, then
trigger the workflow one of two ways:

**Option A — manual dispatch (recommended when CLI tag-push isn't
available).** No git tag command needed; the workflow creates and
pushes the tag itself.

1. Open <https://github.com/KHC831/intellig/actions/workflows/publish.yml>.
2. Click **"Run workflow"** (right side of the workflow header).
3. The "Use workflow from" dropdown stays on `main`.
4. Leave the **Version** input blank to use the version currently
   in `package.json` on `main`. (If you fill it in, it must match
   `package.json` — the workflow refuses mismatches as a safety
   net.)
5. Click the green **"Run workflow"** button.

The workflow runs the lint / unit / property gates, creates and
pushes a `v<version>` tag, builds the `.vsix`, and publishes to
both galleries. End-to-end takes ~3 minutes.

**Option B — push a tag from the CLI.**

```bash
# From a clean main with the bump committed + pushed.
git tag v0.1.2
git push origin v0.1.2
```

The workflow runs against the tagged commit and proceeds through
the same gates and publish steps as Option A.

Watch progress for either path at
**<https://github.com/KHC831/intellig/actions/workflows/publish.yml>**.

### Failure modes and fixes

| Symptom                                       | Cause                                                           | Fix                                                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `tag version does not match package.json`     | Tagged a commit where `package.json` is at a different version. | Delete the tag locally + on origin (`git tag -d`, `git push origin :refs/tags/<tag>`), bump `package.json`, commit, push, re-tag. |
| `ℹ VSCE_PAT secret is not set — skipping ...` | Marketplace secret deliberately unset.                          | Expected when running tokenless. Upload the built `.vsix` manually at the Marketplace publisher page.                             |
| `vsce publish ... 401`                        | PAT expired.                                                    | Generate a new PAT, update the `VSCE_PAT` secret.                                                                                 |
| `OPEN_VSX_TOKEN secret is not set`            | Open VSX secret missing.                                        | Add it at repo → Settings → Secrets → Actions.                                                                                    |
| `ovsx publish ... 403`                        | Open VSX token revoked or namespace mismatch.                   | Confirm the token's owner has the `KaHoChan` namespace; regenerate the token if needed.                                           |
| `version 0.1.X already exists`                | You re-tagged an already-published version.                     | Bump to `0.1.X+1` (Marketplace will not let you overwrite).                                                                       |

### Local script vs. Action

The local `scripts/publish.sh` and the Action publish the same way
and produce identical artifacts. Use whichever is more convenient
for the moment:

- Local script: faster feedback loop while you're iterating on
  release tooling itself, or when the Action is misconfigured and
  you want to ship anyway. Tokens stay on your laptop.
- Action: hands-off, no local setup needed, audit log is the
  workflow run, secrets live in GitHub. Best for routine releases
  once the pipeline is stable.

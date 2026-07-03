# Test coverage & the patch-coverage gate

## What exists today

- **`npm run coverage`** runs `c8` over the **unit lane only** and writes
  `coverage/coverage-final.json` (istanbul format).
- **`npm run check:patch-coverage`** (`scripts/check-patch-coverage.mjs`) diffs
  `src` against the PR base, maps each changed _executable_ line to a `c8`
  statement hit, and fails below `PATCH_COVERAGE_MIN` (default 80%).
- CI runs it as a PR-only `patch-coverage` job (`.github/workflows/ci.yml`).

The gate is honest but **not airtight**: the coverage report only reflects the
unit lane. Code that is exercised solely by the **e2e** (`test/e2e`) and
**ext-host** (`test/ext-host`) lanes — which boot a real VS Code Extension Host
— is invisible to it. We paper over that with `scripts/patch-coverage-ignore.json`
(activation wiring, Views, `ExtensionServices`). Every entry there is coverage
debt the unit lane can't see; the ignore list is a workaround, not the goal.

This document describes how to make the gate airtight by **merging coverage
across all lanes**, so the ignore manifest can shrink toward empty.

## The idea: one raw-coverage directory, many processes

Node has built-in V8 coverage. Set `NODE_V8_COVERAGE=<dir>` for any Node process
and it writes raw V8 coverage JSON to `<dir>` on exit. `c8` is just a front-end
over this: it sets `NODE_V8_COVERAGE`, runs the command, then converts the raw
files to an istanbul report (applying source maps).

The key facts that make merging possible:

1. **Every lane is a Node process** — the unit/property lanes run under `mocha`
   directly; the e2e/ext-host lanes run `@vscode/test-electron`'s `runTests`,
   which spawns a VS Code subprocess whose **extension host is a Node process**.
2. **Raw V8 files accumulate** — point every process at the _same_ directory and
   each writes its own `coverage-*.json`. `c8 report` over that directory unions
   them.
3. **Source maps bridge compiled JS back to TS** — the unit lane runs TS via
   `ts-node`; the e2e/ext-host lanes run the compiled `out-test/` JS plus the
   `dist/extension.js` bundle, both with `.js.map` sidecars. `c8` reads the
   maps and attributes both back to `src/**/*.ts`, so the merged report is in
   TS terms.

## Steps to make it airtight

### 1. Choose a shared raw-coverage directory

Use one directory for the whole run, e.g. `coverage/tmp`. Clear it once at the
start; never clear it between lanes.

### 2. Run the unit/property lanes writing raw V8 there

Run `c8` with `--temp-directory` pointed at the shared dir and **defer
reporting** (`--no-clean` so it doesn't wipe other lanes' files; report later):

```jsonc
// package.json (illustrative)
"coverage:unit": "c8 --temp-directory=coverage/tmp --clean=false --reporter=none mocha --require ts-node/register 'test/unit/**/*.test.ts'"
```

`--clean=false` (a.k.a. `--no-clean`) is essential — otherwise each `c8`
invocation wipes the directory and you lose the other lanes' raw files.

### 3. Instrument the VS Code host subprocess

`runTests` accepts `extensionTestsEnv`, which is forwarded into the spawned VS
Code process's environment. Set `NODE_V8_COVERAGE` there so the extension host
writes raw coverage into the same shared directory.

In **`test/e2e/runTests.ts`** and **`test/ext-host/runTests.ts`**, extend the
existing `runTests({ ... })` call (currently at `test/e2e/runTests.ts:32`):

```ts
const covDir = process.env.NODE_V8_COVERAGE; // set by the coverage npm script
const exitCode = await runTests({
  extensionDevelopmentPath,
  extensionTestsPath,
  launchArgs: [tempWorkspace, '--disable-extensions', '--disable-workspace-trust'],
  // Forward V8 coverage into the host process so e2e/ext-host execution is
  // recorded into the same shared directory the unit lane writes to.
  extensionTestsEnv: covDir ? { NODE_V8_COVERAGE: path.resolve(covDir) } : undefined,
});
```

Then invoke the lane with the env var set so it propagates:

```jsonc
"coverage:e2e": "cross-env NODE_V8_COVERAGE=coverage/tmp npm run test:e2e",
"coverage:ext-host": "cross-env NODE_V8_COVERAGE=coverage/tmp npm run test:ext-host"
```

Notes:

- Use an **absolute path** for `NODE_V8_COVERAGE` — the host's working directory
  differs from the launcher's, and a relative path would scatter files.
- The host records the **`dist/extension.js` bundle**; its `.js.map` must
  exist (it does — `npm run build:extension` emits a source map). Confirm
  `dist/extension.js.map` is present before merging.
- `--disable-extensions` does not affect coverage of _our_ extension; it only
  prevents third-party extensions from loading.

### 4. Merge into one istanbul report

After all lanes have run, convert the accumulated raw files once:

```jsonc
"coverage:report": "c8 report --temp-directory=coverage/tmp --src src --include 'src/**/*.ts' --exclude 'src/**/*.d.ts' --reporter=json --reporter=text-summary --report-dir=coverage"
```

A wrapper that ties it together:

```jsonc
"coverage:all": "rimraf coverage/tmp && npm run coverage:unit && npm run coverage:e2e && npm run coverage:ext-host && npm run coverage:report"
```

### 5. Point the gate at the merged report and prune the ignore list

`check-patch-coverage.mjs` already reads `coverage/coverage-final.json`
(override with `COVERAGE_FILE`). Once `coverage:all` produces a merged report,
the gate is airtight. Then **remove entries from
`scripts/patch-coverage-ignore.json`** that the e2e/ext-host lanes now cover
(re-run the gate; anything that stops showing as uncovered can leave the list).
The target end-state is an empty `ignore` array.

## CI wiring

The current `patch-coverage` job runs only the unit lane. To go airtight,
replace `npm run coverage` in that job with `npm run coverage:all` and run it on
a Linux runner with `xvfb` (the e2e/ext-host lanes need a display):

```yaml
- run: xvfb-run -a npm run coverage:all
- name: Enforce patch coverage on changed lines
  env:
    PATCH_COVERAGE_BASE: origin/${{ github.event.pull_request.base.ref }}
  run: npm run check:patch-coverage
```

Trade-off: this job then pays the full e2e/ext-host wall-time (~12–14 min) on
every PR, versus the current ~1 min unit-only run. If that is too slow, keep the
fast unit-only gate as the **required** check and run `coverage:all` as a
**nightly** `schedule` job that reports drift, rather than blocking every PR.

## Gotchas / things that bite

- **Don't let `c8` clean the temp dir mid-run.** Every lane after the first must
  use `--clean=false` (or only the launcher clears `coverage/tmp`, once).
- **Absolute `NODE_V8_COVERAGE` path**, always — the host CWD is not the repo
  root.
- **Source maps are mandatory.** No `.js.map` ⇒ coverage lands on `out/*.js`
  and the gate (which keys on `src/**/*.ts`) sees the file as having no entry.
- **Exclude `dist/`, `out-test/`, `test/`** from the report (`--include
'src/**/*.ts'`) so test code doesn't dilute the numbers.
- **Inline webview scripts** (the big template literals in
  `provider/scriptBuilder.ts`, `html/*Html.ts`) are covered as _string literals_
  when their builder function runs — c8 marks those lines covered, so they are
  not a false-positive source. Logic that runs _inside_ the webview via
  `eval`/`new Function` in jsdom is **not** instrumented; if you add such a path,
  cover it at the host boundary or exclude it explicitly.
- **Flaky host shutdown.** If VS Code is killed rather than exiting cleanly, V8
  may not flush coverage. Ensure the suite lets the host exit normally (the
  existing launchers already return an exit code rather than `SIGKILL`).

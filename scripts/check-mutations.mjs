#!/usr/bin/env node
/**
 * Mutation lane (golden rule 12): for every entry in mutation-manifest.json,
 * neuter the named defence and prove the named test dies without it.
 *
 * A defence that a reviewer had to notice is missing is not a gate — this
 * makes "did we prove the test would catch a regression here" a re-runnable
 * fact instead of a one-time review finding. Runs in ONE throwaway detached
 * worktree, never the developer's tree: a crashed run must not leave a
 * mutation behind, so every mutation is applied and reverted inside a
 * directory nothing else depends on.
 *
 * An entry's `test` field names a FILE — several entries can share one, and
 * mutating one defence can break more than one test in it (a whole suite
 * `describe` sharing setup, say). `title` names the exact test whose title
 * must appear among the mutated run's failures: the file going red only
 * proves SOME assertion in it died, not the one this entry claims to fence.
 *
 * What tree does the worktree validate? The WORKING tree, not just the last
 * commit: `git stash create` snapshots tracked modifications (staged or not)
 * into a throwaway commit object without touching the index or working tree
 * (unlike `git stash push`), and the worktree is built from that snapshot. A
 * developer who weakens a fenced defence and runs `gate:full` before
 * committing gets the real answer, not a silent re-proof of the previous
 * commit. Residual gap: `git stash create` does not capture untracked files
 * (a brand-new manifest entry's target file that was never `git add`-ed) —
 * `git add` it first, or this lane still validates the committed tree for
 * that one file. The tree actually validated is printed at startup so this
 * is never silent either way.
 *
 * A run is killed mid-flight (Ctrl-C, or a CI timeout) as often as it runs to
 * completion — each manifest entry spawns a mocha process, tens of
 * seconds of wall-clock. Every subprocess call runs ASYNCHRONOUSLY
 * (child_process.execFile, never the *Sync family) for exactly this reason:
 * Node only delivers a queued signal to a `process.on('SIGINT', …)` handler
 * when the call stack unwinds back to the event loop, and a *Sync child
 * process call blocks the thread for its whole duration without yielding —
 * so a script built on execFileSync cannot react to Ctrl-C until the ENTIRE
 * run finishes on its own, making the handler dead code in practice. The
 * async form lets the handler fire within one subprocess's lifetime, kill
 * that subprocess, and tear the worktree down before exiting. A run that WAS
 * killed before the handler could react at all (`kill -9`, or a crash before
 * it's installed) leaves an orphaned `mutation-lane-<pid>` worktree behind —
 * reclaimed at the next run's startup the same way
 * test/helpers/scratchRoot.ts reclaims abandoned scratch dirs: sweep every
 * `mutation-lane-*` entry whose owning pid is no longer alive, not just this
 * run's own.
 *
 * Usage: node scripts/check-mutations.mjs
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'mutation-manifest.json');
// Never workspace-notes/tmp — the test-scratch sweep in test/helpers/scratchRoot.ts
// self-heals that directory on every unit run and would delete a live worktree.
// Named per-process so two concurrent runs (two agents, or a dev running this
// alongside `npm test`) get independent worktrees instead of racing one path.
const WORKTREES_ROOT = path.join(REPO_ROOT, 'workspace-notes', 'worktrees');
const WORKTREE_NAME_RE = /^mutation-lane-(\d+)$/;
const WORKTREE_DIR = path.join(WORKTREES_ROOT, `mutation-lane-${process.pid}`);

function readManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(raw);
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error(`mutation-manifest.json must be a non-empty array (got ${typeof manifest})`);
  }
  const seenIds = new Set();
  for (const entry of manifest) {
    for (const field of ['id', 'file', 'anchor', 'mutation', 'test', 'title', 'why']) {
      if (entry[field] === undefined) {
        throw new Error(`manifest entry missing "${field}": ${JSON.stringify(entry)}`);
      }
    }
    if (seenIds.has(entry.id)) {
      throw new Error(`duplicate manifest id: ${entry.id}`);
    }
    seenIds.add(entry.id);
    if (entry.mutation.kind !== 'delete-line' && entry.mutation.kind !== 'replace') {
      throw new Error(`${entry.id}: mutation.kind must be "delete-line" or "replace"`);
    }
    if (entry.mutation.kind === 'replace' && typeof entry.mutation.with !== 'string') {
      throw new Error(`${entry.id}: mutation.kind "replace" needs a string "with"`);
    }
  }
  return manifest;
}

/** The one subprocess in flight, so a signal handler can kill it before tearing down. */
let currentChild = null;

/** Run `cmd` asynchronously — see the file header for why never *Sync. */
function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: 'utf8', ...opts }, (error, stdout, stderr) => {
      currentChild = null;
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
    currentChild = child;
  });
}

/**
 * Whether a process id is still running. Mirrors
 * test/helpers/scratchRoot.ts's pidIsAlive (signal 0, EPERM means alive and
 * owned by someone else) — this file can't import that one's internals (its
 * own header says production code must not call its test-only export), so
 * the technique is reimplemented here. `kill` is injected the same way, so
 * the EPERM arm and reclaim decisions are fault-testable without depending
 * on a real other-owned process existing wherever this runs.
 */
function pidIsAlive(pid, kill = (p, s) => process.kill(p, s)) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * A pid-named worktree older than this is reclaimed even if something is
 * running under that pid: pids are recycled, so a leaked worktree can be
 * adopted by an unrelated long-lived process and would otherwise never be
 * swept. Mirrors test/helpers/scratchRoot.ts's STALE_ROOT_MS.
 */
const STALE_WORKTREE_MS = 24 * 60 * 60 * 1000;

/**
 * Pure decision: which `mutation-lane-*` directory names are abandoned — a
 * pid that is not this process and either is not alive or names a worktree
 * old enough that the pid it once belonged to has surely moved on.
 * Separated from the filesystem/git calls in reclaimStaleWorktrees() so the
 * selection logic is testable without touching real worktree state.
 *
 * `isStale` has no default and is validated up front: the mtime arm closes
 * the pid-recycle hole, and `isAlive(pid) || isStale(entry)` short-circuits
 * on a dead pid — the common case — so a caller that forgets to pass it
 * would otherwise only crash on the rare recycled-pid run. Checking the
 * type before the loop makes a dropped argument fail on every run instead.
 */
function staleWorktreeNames(dirEntries, selfPid, isAlive, isStale) {
  if (typeof isStale !== 'function') {
    throw new TypeError('staleWorktreeNames requires an isStale(entry) function');
  }
  const stale = [];
  for (const entry of dirEntries) {
    const match = WORKTREE_NAME_RE.exec(entry);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    if (pid === selfPid) {
      continue;
    }
    if (!isAlive(pid) || isStale(entry)) {
      stale.push(entry);
    }
  }
  return stale;
}

/**
 * Whether `entry`'s worktree directory (under `root`, defaulting to the real
 * WORKTREES_ROOT) was last touched long enough ago that no run still owns it.
 * `root` is a parameter, not a closed-over constant, so this is testable
 * against a scratch directory instead of the real worktree tree.
 */
function isStaleWorktree(entry, root = WORKTREES_ROOT) {
  try {
    return Date.now() - fs.statSync(path.join(root, entry)).mtimeMs > STALE_WORKTREE_MS;
  } catch {
    // Unreadable: leave it to the liveness check rather than guessing.
    return false;
  }
}

/**
 * Remove every `mutation-lane-*` worktree under WORKTREES_ROOT whose owning
 * pid is gone, or whose pid is alive but the worktree is stale (the pid was
 * recycled onto an unrelated process — the same two-arm reclaim policy
 * test/helpers/scratchRoot.ts uses for its own per-pid dirs: a liveness
 * check plus a stale-mtime fallback, not liveness alone). Runs before this
 * process registers its own worktree, so a prior crashed run (killed before
 * its signal handler could tear down, or killed with `-9`) is reclaimed
 * instead of accumulating forever.
 */
async function reclaimStaleWorktrees() {
  let entries;
  try {
    entries = fs.readdirSync(WORKTREES_ROOT);
  } catch {
    return;
  }
  for (const entry of staleWorktreeNames(entries, process.pid, pidIsAlive, isStaleWorktree)) {
    const dir = path.join(WORKTREES_ROOT, entry);
    console.log(`mutation lane: reclaiming worktree left by a dead process: ${dir}`);
    try {
      await sh('git', ['worktree', 'remove', '--force', dir], { cwd: REPO_ROOT });
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      try {
        // Repo-global, not scoped to this one worktree: it deregisters every
        // worktree whose directory is already missing, not just this lane's.
        // Harmless here — prune only removes registrations already dead.
        await sh('git', ['worktree', 'prune'], { cwd: REPO_ROOT });
      } catch {
        // Best-effort — an unreclaimed registration is a nuisance, not data loss.
      }
    }
  }
}

/**
 * The commit-ish to build the worktree from: a snapshot of the current
 * working tree (tracked modifications, staged or not) via `git stash
 * create`, which returns an object name without touching the index or
 * working tree — never HEAD alone, or a defence weakened but not yet
 * committed would be invisible to this lane.
 *
 * Returns `{ target, message }` rather than printing itself: the two
 * distinct routes that fall back to HEAD (a `git stash create` command
 * failure — e.g. mid-merge/mid-rebase, "Cannot save the current index
 * state" — versus an empty result, which itself splits into "nothing
 * changed" and "the only changes are untracked, which `git stash create`
 * never snapshots") each get their own honest message. Printing one fixed
 * "working tree has no uncommitted changes to snapshot" line for all three
 * would be false for two of them: a `stash create` failure says nothing
 * about whether the tree has changes (mid-merge trees always do), and an
 * untracked-only tree by definition has changes on disk.
 *
 * `runGit` is injected (defaults to the real `git`, run in REPO_ROOT) so
 * each route is unit-testable without a real git repository.
 */
async function resolveValidationTarget(runGit = (args) => sh('git', args, { cwd: REPO_ROOT })) {
  let stashObject = '';
  try {
    stashObject = (await runGit(['stash', 'create'])).trim();
  } catch (error) {
    return {
      target: 'HEAD',
      message: `mutation lane: could not snapshot the working tree (${String(error.message ?? error)}); validating HEAD instead — this checks the last COMMIT, not whatever uncommitted or in-progress (e.g. mid-merge/mid-rebase) state is actually on disk.`,
    };
  }
  if (stashObject.length > 0) {
    return {
      target: stashObject,
      message: `mutation lane: validating the WORKING TREE (snapshot ${stashObject.slice(0, 12)}, uncommitted changes included; untracked files excluded).`,
    };
  }
  const statusOut = await runGit(['status', '--porcelain']);
  const hasUntracked = statusOut.split('\n').some((line) => line.startsWith('??'));
  if (hasUntracked) {
    return {
      target: 'HEAD',
      message:
        'mutation lane: validating HEAD — the working tree has only UNTRACKED changes, which `git stash create` cannot snapshot (a brand-new manifest entry target must be `git add`-ed first).',
    };
  }
  return {
    target: 'HEAD',
    message: 'mutation lane: validating HEAD (the working tree is clean — no changes to snapshot).',
  };
}

/** Create the one throwaway worktree, detached at the validation target. */
async function setupWorktree(target) {
  await reclaimStaleWorktrees();
  fs.mkdirSync(WORKTREES_ROOT, { recursive: true });
  if (fs.existsSync(WORKTREE_DIR)) {
    // A prior crashed run under THIS pid left this behind (pids are not
    // recycled within one process's own lifetime, but a leftover directory
    // from a previous invocation that reused this pid is possible) — remove
    // it before making a fresh one, rather than reusing possibly-mutated
    // content.
    try {
      await sh('git', ['worktree', 'remove', '--force', WORKTREE_DIR], { cwd: REPO_ROOT });
    } catch {
      fs.rmSync(WORKTREE_DIR, { recursive: true, force: true });
      await sh('git', ['worktree', 'prune'], { cwd: REPO_ROOT });
    }
  }
  await sh('git', ['worktree', 'add', '--detach', WORKTREE_DIR, target], { cwd: REPO_ROOT });
  const nodeModulesLink = path.join(WORKTREE_DIR, 'node_modules');
  if (!fs.existsSync(nodeModulesLink)) {
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), nodeModulesLink, 'dir');
  }
}

let torndown = false;
async function teardownWorktree() {
  if (torndown) {
    return;
  }
  torndown = true;
  try {
    await sh('git', ['worktree', 'remove', '--force', WORKTREE_DIR], { cwd: REPO_ROOT });
  } catch (error) {
    // Best-effort — a leftover worktree is a nuisance, not silent data loss,
    // and this must not throw out of a signal handler masking a real failure.
    console.error(`warning: failed to remove mutation-lane worktree: ${String(error)}`);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.error(`\nmutation lane: ${signal} received, tearing down worktree before exit.`);
    if (currentChild) {
      try {
        currentChild.kill('SIGTERM');
      } catch {
        // Best-effort — the child may already be exiting on its own.
      }
    }
    teardownWorktree()
      .catch(() => {
        // Already logged inside teardownWorktree.
      })
      .finally(() => {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  });
}

/**
 * mocha's JSON reporter writes its report as ONE JSON object, but not
 * necessarily the only thing on stdout: anything the code under test prints
 * (a stray `console.log` left in a spec) lands ahead of it, and a plain
 * `JSON.parse(stdout)` throws on that leading text even though the run
 * itself executed and its report is sitting right there. Scans every `{` in
 * `stdout` as a candidate start, extracts the balanced (quote-aware) object
 * beginning there, and returns the first one that both parses and has the
 * shape a mocha report has (a numeric `stats.tests`) — never just "the
 * first thing that parses", since stray output could itself contain valid,
 * differently-shaped JSON.
 */
/** Same scan as extractMochaReport, but also returns the exact [start, end)
 * span of the report's own JSON text — so a caller can tell the report's
 * PAYLOAD (test titles, failure messages — arbitrary text a test author
 * wrote) apart from everything ts-node/mocha printed around it. */
function extractMochaReportSpan(stdout) {
  for (let i = stdout.indexOf('{'); i !== -1; i = stdout.indexOf('{', i + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < stdout.length; j++) {
      const ch = stdout[j];
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (ch === '\\') {
          esc = true;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(stdout.slice(i, j + 1));
            if (parsed && typeof parsed.stats?.tests === 'number') {
              return { report: parsed, start: i, end: j + 1 };
            }
          } catch {
            // Balanced braces, but not valid JSON (or not a mocha report) —
            // keep scanning from the next '{'.
          }
          break;
        }
      }
    }
  }
  return null;
}

function extractMochaReport(stdout) {
  return extractMochaReportSpan(stdout)?.report ?? null;
}

/**
 * Classify one mocha JSON-reporter run. The runner's only historical
 * question was "did mocha exit non-zero" — which is also true for at least
 * four unrelated causes, each of which must read as its own outcome rather
 * than the single, misleading "does not currently compile/run":
 *
 *   - a real TypeScript diagnostic (ts-node refused to compile the mutated
 *     file, or a `require()` in the mocharc list throws before mocha loads
 *     a single spec) — the only case that actually means "does not
 *     compile/run";
 *   - mocha's own JSON report is missing or unparseable (a crash before the
 *     reporter ran at all — `stdout` never contains one), distinct from —
 *   - a stray `console.log` (or other output) printed AHEAD of a perfectly
 *     good report, which `extractMochaReport` recovers;
 *   - the child process was killed by a signal (Ctrl-C, a CI timeout) —
 *     an interrupted run proves nothing about the named assertion either
 *     way, and must not be reported as a compile/run failure of the file
 *     under test.
 *
 * A run that legitimately executed zero tests (a `before`/`beforeEach` hook
 * that throws) still fails closed as `compileFailure`, since it proves
 * nothing about the named assertion — but is reported as exactly that, not
 * conflated with the other three.
 */
function classifyRun({ stdout, stderr, signal = null }) {
  const output = `${stdout}${stderr}`;
  if (signal) {
    return {
      executed: 0,
      compileFailure: true,
      killed: true,
      passed: false,
      output,
      reason: `killed by ${signal} before it could complete`,
    };
  }
  // A real ts-node/tsc diagnostic can land in two places: raw stdout/stderr
  // text printed before mocha's JSON reporter ever runs (a require()-time
  // throw), or — when ts-node fails to compile a file mocha already loaded —
  // repeated verbatim into every failing test's OWN `err.message`. Neither of
  // those is a TITLE: a test author's title/fullTitle is prose they wrote
  // (e.g. a test asserting some other tool's error text is formatted
  // correctly can legitimately contain "error TS1234:"), so only the error
  // MESSAGES are searched, never the titles, to tell the two apart.
  const span = extractMochaReportSpan(stdout);
  const report = span?.report ?? null;
  const outsideReport = span ? stdout.slice(0, span.start) + stdout.slice(span.end) + stderr : output;
  const failureMessages = (report?.failures ?? [])
    .map((f) => f.err?.message ?? '')
    .join('\n');
  const hasTsDiagnostic = /error TS\d+:/.test(outsideReport) || /error TS\d+:/.test(failureMessages);
  const executed = report?.stats?.tests ?? 0;
  const failures = report?.stats?.failures ?? 0;
  if (hasTsDiagnostic) {
    return {
      executed,
      compileFailure: true,
      killed: false,
      passed: false,
      output,
      reason: 'a TypeScript diagnostic appeared in the output',
    };
  }
  if (!report) {
    return {
      executed: 0,
      compileFailure: true,
      killed: false,
      passed: false,
      output,
      reason: "mocha's JSON report never appeared in the output — a crash before the reporter ran",
    };
  }
  if (executed === 0) {
    return {
      executed: 0,
      compileFailure: true,
      killed: false,
      passed: false,
      output,
      reason: 'mocha executed zero tests (e.g. a hook threw before any test ran)',
    };
  }
  return {
    executed,
    compileFailure: false,
    killed: false,
    passed: failures === 0,
    // Rule 12 fences the DEFENCE, not just the file it lives in: the file
    // going red proves only that SOME test in it died, and a file shared by
    // several manifest entries can die on a sibling's assertion while the
    // one this entry names stays green. Titles let checkEntry require the
    // NAMED test specifically.
    failedTitles: (report.failures ?? []).map((f) => f.title),
    // Every LEAF title mocha ran in this file, pass or fail — lets checkEntry
    // refuse to trust a title match that two different `it()`s (in different
    // `describe`s) could both satisfy.
    allTitles: (report.tests ?? []).map((t) => t.title),
    output,
    reason: null,
  };
}

/** Run mocha on one test file inside the worktree, classified per classifyRun. */
async function runTest(relTestFile) {
  let stdout = '';
  let stderr = '';
  let signal = null;
  try {
    stdout = await sh(
      'npx',
      ['mocha', '--require', 'ts-node/register', '--reporter', 'json', relTestFile],
      {
        cwd: WORKTREE_DIR,
        timeout: 120000,
      }
    );
  } catch (error) {
    stdout = String(error.stdout ?? '');
    stderr = String(error.stderr ?? '');
    signal = error.signal ?? null;
  }
  return classifyRun({ stdout, stderr, signal });
}

function applyMutation(absFile, entry, occurrences) {
  const src = fs.readFileSync(absFile, 'utf8');
  const idx = src.indexOf(entry.anchor);
  if (entry.mutation.kind === 'replace') {
    const mutated = src.slice(0, idx) + entry.mutation.with + src.slice(idx + entry.anchor.length);
    fs.writeFileSync(absFile, mutated);
    return;
  }
  // delete-line: remove the whole line the anchor's start falls on.
  const lineStart = src.lastIndexOf('\n', idx) + 1;
  let lineEnd = src.indexOf('\n', idx);
  lineEnd = lineEnd === -1 ? src.length : lineEnd + 1;
  const mutated = src.slice(0, lineStart) + src.slice(lineEnd);
  fs.writeFileSync(absFile, mutated);
  void occurrences;
}

async function checkEntry(entry) {
  const started = Date.now();
  const absFile = path.join(WORKTREE_DIR, entry.file);
  const absTest = path.join(WORKTREE_DIR, entry.test);

  if (!fs.existsSync(absFile)) {
    return fail(entry, `file does not exist in the worktree: ${entry.file}`, started);
  }
  if (!fs.existsSync(absTest)) {
    return fail(entry, `test file does not exist: ${entry.test}`, started);
  }

  const src = fs.readFileSync(absFile, 'utf8');
  const occurrences = src.split(entry.anchor).length - 1;
  if (occurrences === 0) {
    return fail(
      entry,
      `anchor not found in ${entry.file} — the defence moved or was deleted; update the manifest`,
      started
    );
  }
  if (occurrences > 1) {
    return fail(
      entry,
      `anchor is AMBIGUOUS in ${entry.file} (${occurrences} occurrences) — narrow it to one exact match`,
      started
    );
  }

  // Baseline: the named test must actually execute and pass on unmutated
  // source. A baseline that never ran (a pre-existing compile error) or one
  // that ran and failed proves nothing about the mutation below.
  const baseline = await runTest(entry.test);
  if (baseline.killed) {
    return fail(
      entry,
      `baseline run was ${baseline.reason} — an interrupted run proves nothing about ${entry.test}`,
      started
    );
  }
  if (baseline.compileFailure) {
    return fail(
      entry,
      `baseline never executed — ${entry.test} does not currently compile/run (${baseline.reason}); this entry proves nothing:\n${baseline.output}`,
      started
    );
  }
  if (!baseline.passed) {
    return fail(
      entry,
      `baseline is already RED before any mutation — this entry proves nothing:\n${baseline.output}`,
      started
    );
  }
  // The "named test died" check below matches by LEAF title, not the full
  // describe path — if the file runs two `it()`s with that same leaf text
  // (in different `describe`s), a mutation could satisfy this entry by
  // killing the OTHER one and this check could not tell the difference.
  const sameTitleCount = baseline.allTitles.filter((t) => t === entry.title).length;
  if (sameTitleCount > 1) {
    return fail(
      entry,
      `"${entry.title}" is not a unique leaf title in ${entry.test} (${sameTitleCount} tests share it) — ` +
        `the failed-title check below cannot tell which one died; rename the test or narrow this entry's title`,
      started
    );
  }

  applyMutation(absFile, entry, occurrences);
  let mutated;
  try {
    mutated = await runTest(entry.test);
  } finally {
    // Always restore from git, regardless of the mutation's shape — never
    // trust the mutation logic to be its own undo.
    await sh('git', ['checkout', '--', entry.file], { cwd: WORKTREE_DIR });
  }

  if (mutated.killed) {
    return fail(
      entry,
      `mutated run was ${mutated.reason} — an interrupted run proves nothing about ${entry.test}`,
      started
    );
  }
  if (mutated.compileFailure) {
    return fail(
      entry,
      `the mutation did not compile; it must change behaviour, not break the build (${mutated.reason}):\n${mutated.output}`,
      started
    );
  }
  if (mutated.passed) {
    return fail(
      entry,
      `the named test PASSED under mutation — this defence is unfenced.\nwhy this defence exists: ${entry.why}`,
      started
    );
  }
  // The file went red, but rule 12 fences the ONE named test, not "some
  // test in this file" — a file shared by several entries can die on a
  // sibling's assertion while the one this entry claims to prove stays
  // green under mutation, and the exit code alone can't tell those apart.
  if (!mutated.failedTitles.includes(entry.title)) {
    return fail(
      entry,
      `${entry.test} failed under mutation, but not on the named test "${entry.title}" — ` +
        `it failed on: ${mutated.failedTitles.map((t) => `"${t}"`).join(', ') || '(no titles reported)'}. ` +
        `This entry does not prove the named test dies without the defence:\n${mutated.output}`,
      started
    );
  }

  return { id: entry.id, ok: true, ms: Date.now() - started };
}

function fail(entry, message, started) {
  return { id: entry.id, ok: false, message, ms: Date.now() - started };
}

async function main() {
  const manifest = readManifest();
  const overallStart = Date.now();
  const { target, message } = await resolveValidationTarget();
  console.log(message);
  await setupWorktree(target);
  const results = [];
  try {
    for (const entry of manifest) {
      const result = await checkEntry(entry);
      results.push(result);
      const status = result.ok ? 'ok' : 'FAIL';
      console.log(`[${status}] ${entry.id} (${result.ms}ms)`);
      if (!result.ok) {
        console.error(`  ${result.message}`);
      }
    }
  } finally {
    await teardownWorktree();
  }

  const failures = results.filter((r) => !r.ok);
  const totalMs = Date.now() - overallStart;
  console.log(
    `\nmutation lane: ${results.length - failures.length}/${results.length} passed, ${(totalMs / 1000).toFixed(1)}s wall-clock`
  );
  if (failures.length > 0) {
    console.error(`\n${failures.length} unfenced or broken manifest entr${failures.length === 1 ? 'y' : 'ies'}:`);
    for (const f of failures) {
      console.error(`  - ${f.id}: ${f.message}`);
    }
    process.exit(1);
  }
}

// Comparing a raw `file://` string against argv[1] fails on any path with a
// space, `#`, `%`, or non-ASCII character: import.meta.url percent-encodes,
// argv[1] does not. Resolving both to plain filesystem paths fixes that, but
// import.meta.url is also canonicalized against symlinks and path.resolve is
// not — realpath argv[1] too, so a symlinked script or directory still runs.
const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === fs.realpathSync(path.resolve(process.argv[1]));
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export {
  classifyRun,
  extractMochaReport,
  isStaleWorktree,
  pidIsAlive,
  resolveValidationTarget,
  staleWorktreeNames,
  STALE_WORKTREE_MS,
  WORKTREE_NAME_RE,
};

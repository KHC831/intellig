/**
 * Companion spec for scripts/check-mutations.mjs.
 *
 * The mutation lane's own defence: a run that never executed the named test
 * (a TypeScript compile error, or a require()-time crash that kills mocha
 * before it loads any spec) must classify as a FAILED entry, never as "the
 * mutation was caught". These pin classifyRun() against the real output
 * shapes captured from both failure modes, plus the ordinary pass/fail
 * shapes, and pin the stale-worktree reclaim decision.
 */
import '../../setup';
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-mutations.mjs');

interface CheckMutationsModule {
  classifyRun: (r: { stdout: string; stderr: string; signal?: string | null }) => {
    executed: number;
    compileFailure: boolean;
    killed: boolean;
    passed: boolean;
    failedTitles: string[];
    allTitles?: string[];
    reason: string | null;
    output: string;
  };
  extractMochaReport: (stdout: string) => { stats: { tests: number } } | null;
  pidIsAlive: (pid: number, kill?: (pid: number, signal: 0) => void) => boolean;
  resolveValidationTarget: (
    runGit?: (args: string[]) => Promise<string>
  ) => Promise<{ target: string; message: string }>;
  staleWorktreeNames: (
    entries: readonly string[],
    selfPid: number,
    isAlive: (pid: number) => boolean,
    isStale: (entry: string) => boolean
  ) => string[];
  isStaleWorktree: (entry: string, root?: string) => boolean;
  STALE_WORKTREE_MS: number;
  WORKTREE_NAME_RE: RegExp;
}

async function loadScript(): Promise<CheckMutationsModule> {
  const mod: unknown = await import(SCRIPT);
  return mod as CheckMutationsModule;
}

describe('check-mutations classifyRun', () => {
  // Captured verbatim from a real run of `npx mocha --require ts-node/register
  // --reporter json` against a mutation that orphans a symbol under
  // noUnusedLocals: mocha reports one "failure" per test in the suite, each
  // carrying the SAME TSError — the named assertion never executed.
  const TS_COMPILE_ERROR_STDOUT = JSON.stringify({
    stats: { suites: 1, tests: 6, passes: 0, pending: 0, failures: 6 },
    failures: [
      {
        title: 'stamps the pick with the repo the row was rendered from',
        err: {
          message:
            "⨯ Unable to compile TypeScript:\nsrc/commits/webview/ctwContextMenu.ts(105,10): error TS6133: 'sameTarget' is declared but its value is never read.\n",
          name: 'TSError',
        },
      },
    ],
  });

  // Captured verbatim from a mutation whose require()-time crash (an ESM
  // module hitting __dirname before mocha's reporter initialises) kills the
  // process before any JSON is ever written to stdout.
  const REQUIRE_CRASH_STDERR =
    '\n✖ ERROR: ReferenceError: __dirname is not defined in ES module scope\n' +
    '    at file:///repo/test/helpers/scratchRoot.ts:21:42\n';

  it('reports compileFailure for a TypeScript diagnostic even though mocha reports tests executed', async () => {
    const { classifyRun } = await loadScript();
    const r = classifyRun({ stdout: TS_COMPILE_ERROR_STDOUT, stderr: '' });
    assert.strictEqual(
      r.compileFailure,
      true,
      'a TSxxxx diagnostic must never read as a caught mutation'
    );
    assert.strictEqual(r.passed, false);
  });

  it('reports compileFailure for a require()-time crash that produced zero executed tests', async () => {
    const { classifyRun } = await loadScript();
    const r = classifyRun({ stdout: '', stderr: REQUIRE_CRASH_STDERR });
    assert.strictEqual(r.executed, 0);
    assert.strictEqual(
      r.compileFailure,
      true,
      'zero executed tests must never read as a caught mutation'
    );
    assert.strictEqual(r.passed, false);
  });

  it('reports passed=false, compileFailure=false when the named test actually fails on an assertion', async () => {
    const { classifyRun } = await loadScript();
    const stdout = JSON.stringify({
      stats: { suites: 1, tests: 6, passes: 5, pending: 0, failures: 1 },
      failures: [
        {
          title: 'drops a menu reply that does not match the right-click still pending',
          err: { message: 'the stale reply must not open a menu', name: 'AssertionError' },
        },
      ],
    });
    const r = classifyRun({ stdout, stderr: '' });
    assert.strictEqual(r.compileFailure, false);
    assert.strictEqual(r.passed, false, 'a real assertion failure is what proves the defence');
  });

  it('reports passed=true when every test executes and none fail (the unfenced case)', async () => {
    const { classifyRun } = await loadScript();
    const stdout = JSON.stringify({
      stats: { suites: 1, tests: 6, passes: 6, pending: 0, failures: 0 },
      failures: [],
    });
    const r = classifyRun({ stdout, stderr: '' });
    assert.strictEqual(r.compileFailure, false);
    assert.strictEqual(r.passed, true);
  });

  it('reports failedTitles from the mocha report, for the named-test check', async () => {
    const { classifyRun } = await loadScript();
    const stdout = JSON.stringify({
      stats: { suites: 1, tests: 2, passes: 1, pending: 0, failures: 1 },
      failures: [{ title: 'the one that must die', err: { message: 'boom' } }],
    });
    const r = classifyRun({ stdout, stderr: '' });
    assert.deepStrictEqual(r.failedTitles, ['the one that must die']);
  });

  // A stray console.log ahead of mocha's own JSON report must not make this
  // misread a run that actually executed and passed (or failed) as "does
  // not currently compile/run".
  it('recovers the mocha report past output the code under test printed first', async () => {
    const { classifyRun } = await loadScript();
    const report = JSON.stringify({
      stats: { suites: 1, tests: 1, passes: 1, pending: 0, failures: 0 },
      failures: [],
    });
    const stdout = `a line the code under test printed\n${report}\n`;
    const r = classifyRun({ stdout, stderr: '' });
    assert.strictEqual(
      r.compileFailure,
      false,
      'polluted-but-present output must not read as a compile failure'
    );
    assert.strictEqual(r.executed, 1);
    assert.strictEqual(r.passed, true);
  });

  // A run killed by a signal (Ctrl-C, a CI timeout) proves nothing about the
  // file under test either way — it must not be reported the same as "does
  // not currently compile/run".
  it('reports killed=true, distinct from a compile failure, when the child was killed by a signal', async () => {
    const { classifyRun } = await loadScript();
    const r = classifyRun({ stdout: '', stderr: '', signal: 'SIGTERM' });
    assert.strictEqual(r.killed, true);
    assert.strictEqual(r.compileFailure, true, 'still fails closed');
    assert.strictEqual(r.passed, false);
    assert.match(r.reason ?? '', /SIGTERM/);
  });

  it('reports a distinct reason when no mocha report ever appears in the output (a true crash)', async () => {
    const { classifyRun } = await loadScript();
    const r = classifyRun({ stdout: 'segfault or similar, no JSON anywhere', stderr: '' });
    assert.strictEqual(r.executed, 0);
    assert.strictEqual(r.compileFailure, true);
    assert.strictEqual(r.killed, false);
    assert.match(r.reason ?? '', /never appeared/);
  });

  it('reports a distinct reason for zero tests executed with a valid report (a hook threw)', async () => {
    const { classifyRun } = await loadScript();
    const stdout = JSON.stringify({
      stats: { suites: 1, tests: 0, passes: 0, pending: 0, failures: 1 },
      failures: [{ title: '"before all" hook', err: { message: 'setup exploded' } }],
    });
    const r = classifyRun({ stdout, stderr: '' });
    assert.strictEqual(r.executed, 0);
    assert.strictEqual(r.compileFailure, true);
    assert.strictEqual(r.killed, false);
    assert.match(r.reason ?? '', /zero tests/);
  });

  // hasTsDiagnostic must not match a test's own TITLE describing
  // TypeScript-diagnostic text (not an actual ts-node/tsc failure) as a
  // compile failure.
  it('does not misread a real test title that happens to contain "error TS1234:" as a compile diagnostic', async () => {
    const { classifyRun } = await loadScript();
    const stdout = JSON.stringify({
      stats: { suites: 1, tests: 2, passes: 1, pending: 0, failures: 1 },
      failures: [
        {
          title: 'formats error TS2304: Cannot find name for the user',
          err: {
            message: 'expected the message to be truncated at 80 chars',
            name: 'AssertionError',
          },
        },
      ],
    });
    const r = classifyRun({ stdout, stderr: '' });
    assert.strictEqual(
      r.compileFailure,
      false,
      'a title describing a TS diagnostic is test-authored prose, not a real compile failure'
    );
    assert.strictEqual(r.passed, false, 'the assertion failure itself is still reported');
  });

  it('still reports compileFailure when the diagnostic-shaped text is in the FAILURE MESSAGE, not just the title', async () => {
    const { classifyRun } = await loadScript();
    const stdout = JSON.stringify({
      stats: { suites: 1, tests: 1, passes: 0, pending: 0, failures: 1 },
      failures: [
        {
          title: 'some test',
          err: { message: '⨯ Unable to compile TypeScript:\nfoo.ts(1,1): error TS6133: unused.\n' },
        },
      ],
    });
    const r = classifyRun({ stdout, stderr: '' });
    assert.strictEqual(
      r.compileFailure,
      true,
      'a real diagnostic in err.message must still fail closed'
    );
  });

  // The named-test check compares LEAF titles, so two `it()`s with the same
  // leaf text in different `describe`s are interchangeable to it —
  // checkEntry must refuse to trust such a match (checkEntry's own
  // spec-level coverage is out of reach here since it needs a worktree; this
  // pins the data classifyRun hands checkEntry to make that guard possible).
  it('reports allTitles with every leaf title mocha ran, including duplicates across different describes', async () => {
    const { classifyRun } = await loadScript();
    const stdout = JSON.stringify({
      stats: { suites: 2, tests: 2, passes: 2, pending: 0, failures: 0 },
      failures: [],
      tests: [
        { title: 'behaves correctly', fullTitle: 'Widget A behaves correctly' },
        { title: 'behaves correctly', fullTitle: 'Widget B behaves correctly' },
      ],
    });
    const r = classifyRun({ stdout, stderr: '' });
    assert.deepStrictEqual(r.allTitles, ['behaves correctly', 'behaves correctly']);
  });
});

describe('check-mutations extractMochaReport', () => {
  it('returns null when stdout contains no JSON object at all', async () => {
    const { extractMochaReport } = await loadScript();
    assert.strictEqual(extractMochaReport('nothing here'), null);
  });

  it('skips a leading JSON object that is not shaped like a mocha report', async () => {
    const { extractMochaReport } = await loadScript();
    const unrelated = JSON.stringify({ foo: 'bar' });
    const report = JSON.stringify({ stats: { tests: 3 } });
    const found = extractMochaReport(`${unrelated}\n${report}\n`);
    assert.deepStrictEqual(found, { stats: { tests: 3 } });
  });
});

describe('check-mutations resolveValidationTarget', () => {
  it('validates the snapshot when git stash create returns an object', async () => {
    const { resolveValidationTarget } = await loadScript();
    const runGit = async (args: string[]): Promise<string> => {
      assert.deepStrictEqual(args, ['stash', 'create']);
      return 'abc123def456\n';
    };
    const { target, message } = await resolveValidationTarget(runGit);
    assert.strictEqual(target, 'abc123def456');
    assert.match(message, /WORKING TREE/);
  });

  // Route A: `git stash create` itself fails (mid-merge/mid-rebase). The
  // message must say a snapshot could not be taken, never claim the tree is
  // clean — a mid-merge tree always has uncommitted changes.
  it('reports the real git failure, not a false "clean tree" claim, when stash create fails', async () => {
    const { resolveValidationTarget } = await loadScript();
    const runGit = async (args: string[]): Promise<string> => {
      if (args[0] === 'stash') {
        throw new Error('Cannot save the current index state: needs merge');
      }
      return '';
    };
    const { target, message } = await resolveValidationTarget(runGit);
    assert.strictEqual(target, 'HEAD');
    assert.match(message, /could not snapshot/);
    assert.doesNotMatch(message, /clean/i, `must not claim the tree is clean:\n${message}`);
  });

  // Route B1: stash create returns empty AND the tree has untracked-only
  // changes — git stash create never captures those, so HEAD is what gets
  // validated, and the message must say so honestly.
  it('reports untracked-only changes distinctly, when stash create is empty but status is not', async () => {
    const { resolveValidationTarget } = await loadScript();
    const runGit = async (args: string[]): Promise<string> => {
      if (args[0] === 'stash') {
        return '';
      }
      return '?? newfile.ts\n';
    };
    const { target, message } = await resolveValidationTarget(runGit);
    assert.strictEqual(target, 'HEAD');
    assert.match(message, /untracked/i);
  });

  // Route B2: stash create returns empty and the tree is genuinely clean.
  it('reports a genuinely clean tree distinctly', async () => {
    const { resolveValidationTarget } = await loadScript();
    const runGit = async (args: string[]): Promise<string> => {
      if (args[0] === 'stash') {
        return '';
      }
      return '';
    };
    const { target, message } = await resolveValidationTarget(runGit);
    assert.strictEqual(target, 'HEAD');
    assert.match(message, /clean/i);
  });
});

describe('check-mutations stale-worktree reclaim', () => {
  it('reclaims a mutation-lane directory whose pid is not alive and is not this process', async () => {
    const { staleWorktreeNames } = await loadScript();
    const isAlive = (pid: number): boolean => pid === 111;
    const stale = staleWorktreeNames(
      ['mutation-lane-111', 'mutation-lane-222', 'mutation-lane-333', 'not-a-worktree'],
      333,
      isAlive,
      () => false
    );
    assert.deepStrictEqual(stale, ['mutation-lane-222']);
  });

  it('never reclaims its own pid even if the injected liveness check says dead', async () => {
    // A defence-in-depth: the caller must never be able to make this process
    // remove the worktree it is currently using.
    const { staleWorktreeNames } = await loadScript();
    const stale = staleWorktreeNames(
      ['mutation-lane-42'],
      42,
      () => false,
      () => false
    );
    assert.deepStrictEqual(stale, []);
  });

  it('ignores entries that are not shaped like mutation-lane-<pid>', async () => {
    const { staleWorktreeNames, WORKTREE_NAME_RE } = await loadScript();
    assert.strictEqual(WORKTREE_NAME_RE.test('mutation-lane-abc'), false);
    const stale = staleWorktreeNames(
      ['mutation-lane-abc', 'unrelated-dir'],
      1,
      () => false,
      () => false
    );
    assert.deepStrictEqual(stale, []);
  });

  it('reclaims a directory whose pid IS alive but whose mtime is old (the pid was recycled onto an unrelated process)', async () => {
    const { staleWorktreeNames } = await loadScript();
    const isAlive = (): boolean => true;
    const isStale = (entry: string): boolean => entry === 'mutation-lane-222';
    const stale = staleWorktreeNames(
      ['mutation-lane-111', 'mutation-lane-222'],
      333,
      isAlive,
      isStale
    );
    assert.deepStrictEqual(stale, ['mutation-lane-222']);
  });

  it('does not reclaim a directory that is both alive and fresh', async () => {
    const { staleWorktreeNames } = await loadScript();
    const stale = staleWorktreeNames(
      ['mutation-lane-111'],
      333,
      () => true,
      () => false
    );
    assert.deepStrictEqual(stale, []);
  });

  it('never reclaims its own pid even if the mtime check says stale', async () => {
    const { staleWorktreeNames } = await loadScript();
    const stale = staleWorktreeNames(
      ['mutation-lane-42'],
      42,
      () => true,
      () => true
    );
    assert.deepStrictEqual(stale, []);
  });

  it('throws rather than silently skip the staleness check when isStale is omitted for a live pid', async () => {
    // isStale has no default: a caller that forgets to wire it must fail
    // loudly, not fall back to liveness-only reclaim.
    const { staleWorktreeNames } = await loadScript();
    assert.throws(() => {
      (staleWorktreeNames as unknown as (e: string[], p: number, a: () => boolean) => string[])(
        ['mutation-lane-111'],
        333,
        () => true
      );
    }, /isStale/);
  });

  it('throws when isStale is omitted, even on an all-dead-pid entry list that never reaches the mtime branch', async () => {
    // isAlive() short-circuits the || before isStale() is ever called when
    // the pid is dead — the common case, since a leaked worktree's pid is
    // usually gone by the time reclaim runs. A dropped isStale argument
    // must not survive that branch undetected.
    const { staleWorktreeNames } = await loadScript();
    assert.throws(() => {
      (staleWorktreeNames as unknown as (e: string[], p: number, a: () => boolean) => string[])(
        ['mutation-lane-111'],
        333,
        () => false
      );
    }, /isStale/);
  });
});

describe('check-mutations isStaleWorktree', () => {
  it('is true when the directory mtime is older than STALE_WORKTREE_MS', async () => {
    const { isStaleWorktree, STALE_WORKTREE_MS } = await loadScript();
    const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'stale-worktree-'));
    const dir = path.join(root, 'mutation-lane-111');
    fs.mkdirSync(dir);
    const old = new Date(Date.now() - STALE_WORKTREE_MS - 1000);
    fs.utimesSync(dir, old, old);

    assert.strictEqual(isStaleWorktree('mutation-lane-111', root), true);
  });

  it('is false when the directory mtime is fresh', async () => {
    const { isStaleWorktree } = await loadScript();
    const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'stale-worktree-'));
    fs.mkdirSync(path.join(root, 'mutation-lane-111'));

    assert.strictEqual(isStaleWorktree('mutation-lane-111', root), false);
  });

  it('is false (not thrown) when the directory does not exist', async () => {
    const { isStaleWorktree } = await loadScript();
    const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'stale-worktree-'));

    assert.strictEqual(isStaleWorktree('mutation-lane-does-not-exist', root), false);
  });
});

describe('check-mutations pidIsAlive', () => {
  it('returns true when the signal delivers without throwing', async () => {
    const { pidIsAlive } = await loadScript();
    assert.strictEqual(
      pidIsAlive(123, () => undefined),
      true
    );
  });

  it('returns true on EPERM — the pid exists, owned by someone else', async () => {
    const { pidIsAlive } = await loadScript();
    const kill = (): void => {
      const error = new Error('not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    };
    assert.strictEqual(pidIsAlive(123, kill), true);
  });

  it('returns false on ESRCH — no such process', async () => {
    const { pidIsAlive } = await loadScript();
    const kill = (): void => {
      const error = new Error('no such process') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    };
    assert.strictEqual(pidIsAlive(123, kill), false);
  });
});

describe('check-mutations runs when spawned from a path containing a space', () => {
  // import.meta.url percent-encodes; process.argv[1] does not. A naive
  // string comparison between the two makes main() never run on any
  // checkout path containing a space, #, %, or non-ASCII character — the
  // script exits 0 having done nothing. mutation-manifest.json is written
  // empty so readManifest() throws synchronously, before any git command
  // runs — this is what keeps the spec itself free of worktree side effects,
  // not statement order alone: GIT_CEILING_DIRECTORIES also stops any git
  // call this fixture might reach from walking up into the real repository
  // it happens to be nested under.
  function runFromScriptsDir(
    scriptsDir: string,
    root: string
  ): { status: number | null; stderr: string } {
    const result = spawnSync('node', [path.join(scriptsDir, path.basename(SCRIPT))], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
    });
    return { status: result.status, stderr: result.stderr };
  }

  const REPO_ROOT = path.resolve(__dirname, '../../..');

  /** Every `worktree <path>` line `git worktree list --porcelain` reports for
   * the real repo, right now. */
  function realWorktreePaths(): string[] {
    const r = spawnSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    return (r.stdout ?? '')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
  }

  /**
   * No mutation-lane worktree registered in the real repo's `.git/worktrees`
   * during the run — a DELTA over `git worktree list --porcelain` taken
   * before and after, not a directory read against an absolute path. A
   * directory read can never observe a leak here (the spawned copy derives
   * its own WORKTREES_ROOT from its own REPO_ROOT, one level above
   * scriptsDir, never the real repo — check-mutations.mjs:57-64), so it
   * would only ever fire falsely, on an unrelated worktree some concurrent
   * run already had registered before this test started. The delta only
   * flags a worktree that appeared during this call.
   */
  function assertNoRealWorktreeLeak(before: readonly string[], after: readonly string[]): void {
    const added = after.filter((p) => !before.includes(p));
    assert.deepStrictEqual(
      added.filter((p) => path.basename(p).startsWith('mutation-lane-')),
      [],
      'a fixture-only run must never register a new worktree in the real repo'
    );
  }

  it('invokes main() and reports the manifest error, rather than silently exiting 0', () => {
    const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'space-'));
    const scriptsDir = path.join(root, 'r22 spaced', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(scriptsDir, path.basename(SCRIPT)));
    fs.writeFileSync(path.join(scriptsDir, 'mutation-manifest.json'), '[]', 'utf8');

    const before = realWorktreePaths();
    const { status, stderr } = runFromScriptsDir(scriptsDir, root);
    const after = realWorktreePaths();

    assert.notStrictEqual(status, 0, 'a spaced script path must not silently no-op');
    assert.ok(
      /non-empty array/.test(stderr),
      `expected main() to run and reach readManifest's validation; stderr:\n${stderr}`
    );
    assertNoRealWorktreeLeak(before, after);
  });

  it('invokes main() when spawned through a symlinked scripts directory', () => {
    // import.meta.url resolves through a symlink to the file's real path;
    // process.argv[1] does not, unless it is realpath'd too — this is the
    // other half of the isMain fix, reproduced with a real symlink rather
    // than a space in the name.
    const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'symlink-'));
    const realScriptsDir = path.join(root, 'real', 'scripts');
    fs.mkdirSync(realScriptsDir, { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(realScriptsDir, path.basename(SCRIPT)));
    fs.writeFileSync(path.join(realScriptsDir, 'mutation-manifest.json'), '[]', 'utf8');
    const linkedRoot = path.join(root, 'linked');
    fs.symlinkSync(path.join(root, 'real'), linkedRoot, 'dir');
    const linkedScriptsDir = path.join(linkedRoot, 'scripts');

    const before = realWorktreePaths();
    const { status, stderr } = runFromScriptsDir(linkedScriptsDir, root);
    const after = realWorktreePaths();

    assert.notStrictEqual(status, 0, 'a symlinked script path must not silently no-op');
    assert.ok(
      /non-empty array/.test(stderr),
      `expected main() to run and reach readManifest's validation; stderr:\n${stderr}`
    );
    assertNoRealWorktreeLeak(before, after);
  });
});

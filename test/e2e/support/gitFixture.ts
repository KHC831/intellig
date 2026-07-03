/**
 * Tier-2 command E2E — git fixture helper.
 *
 * Builds a throwaway git repo on disk for a single test, optionally wired up
 * with a matching bare "origin" remote over `file://`, then tears everything
 * down in the test's `afterEach`. Every test gets its own temp directory —
 * the whole point of the Tier-2 suite is isolation, so no fixture is ever
 * shared across tests.
 *
 * The helper is deliberately thin: `execGit` spawns real `git`, and we use
 * vanilla POSIX paths. Windows CI is not in the current target matrix, but
 * the interface is kept path-separator-safe for future parity.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Result of a real `git` subprocess invocation.
 */
export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `git` with the given args, resolving once it exits. Throws on a
 * non-zero exit code UNLESS `opts.allowNonZero` is true — in which case the
 * caller inspects `exitCode` themselves.
 */
export async function execGit(
  cwd: string,
  args: string[],
  opts: { allowNonZero?: boolean; input?: string } = {}
): Promise<GitResult> {
  // The live extension in the test host runs its own git against the same
  // fixture (watcher-driven status refresh takes .git/index.lock briefly).
  // A test-side mutation colliding with it fails 128 "index.lock: File
  // exists" — an environmental race, not a defect in either party. Do what
  // git's own error message tells a human to do: wait and retry, bounded.
  const LOCK_RETRIES = 5;
  for (let attempt = 0; ; attempt++) {
    const result = await execGitOnce(cwd, args, { ...opts, allowNonZero: true });
    const locked = result.exitCode === 128 && /index\.lock['"]?: File exists/.test(result.stderr);
    if (locked && attempt < LOCK_RETRIES) {
      await new Promise((r) => setTimeout(r, 120));
      continue;
    }
    if (result.exitCode !== 0 && !opts.allowNonZero) {
      throw new Error(
        `git ${args.join(' ')} (cwd=${cwd}) exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      );
    }
    return result;
  }
}

async function execGitOnce(
  cwd: string,
  args: string[],
  opts: { allowNonZero?: boolean; input?: string } = {}
): Promise<GitResult> {
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        // Pin author/committer identity so fixtures are deterministic and do
        // not pick up whatever the developer has in their real ~/.gitconfig.
        GIT_AUTHOR_NAME: 'IntelliG E2E',
        GIT_AUTHOR_EMAIL: 'e2e@intellig.test',
        GIT_COMMITTER_NAME: 'IntelliG E2E',
        GIT_COMMITTER_EMAIL: 'e2e@intellig.test',
        // Disable any global hooks, templates, or LFS that might contaminate
        // the fixture.
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      const exitCode = typeof code === 'number' ? code : 1;
      if (exitCode !== 0 && !opts.allowNonZero) {
        reject(
          new Error(
            `git ${args.join(' ')} (cwd=${cwd}) exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`
          )
        );
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/** Options for {@link createFixtureRepo}. */
export interface FixtureOpts {
  /** Number of commits to pre-populate on the default branch. Default: 3. */
  commits?: number;
  /** Additional branches to create off the given commit index (0-based). */
  branches?: Array<{ name: string; fromCommit?: number }>;
  /** Tags to create. `atCommit` is 0-based over the initial commits. */
  tags?: Array<{ name: string; atCommit?: number; message?: string }>;
  /**
   * If true, create a bare repo as `origin` via `file://` and push the
   * default branch to it. The bare remote lives next to the working repo.
   */
  withRemote?: boolean;
  /** If true, create an unstaged working-tree modification on file `unstaged.txt`. */
  withUnstagedChanges?: boolean;
  /** If true, stage a modification on file `staged.txt`. */
  withStagedChanges?: boolean;
  /** Name of the default branch to use. Default: 'main'. */
  defaultBranch?: string;
}

/** A live fixture repo. Call `cleanup()` in `afterEach`. */
export interface Fixture {
  rootPath: string;
  remotePath?: string;
  defaultBranch: string;
  /**
   * Absolute cleanup — removes both the working and remote repos if present.
   *
   * @remarks
   * Returns a `Promise<void>` so callers can `await` the WRAPPER for
   * teardown ordering: when paired with `await clearWorkspace()` the
   * combined sequence is "drain async loadRepository tails → dispose
   * watchers → drain again → remove fixture directory", which prevents
   * the structural race where `loadRepository`'s tail spawns git against
   * a directory `fs.rmSync` already deleted (yielding ENOENT that gets
   * swallowed and resurrects stale `_repositories` cache entries — see
   * `clearWorkspace` JSDoc for the full chain).
   *
   * The underlying disk removal is still `fs.rmSync(..., { recursive })`
   * because it is blocking and best-effort: errors are swallowed so a
   * failing `afterEach` doesn't mask the test's own failure.
   */
  cleanup: () => Promise<void>;
}

/**
 * Allocate a fresh temp dir and initialise a git repo inside it per the
 * supplied options. Optionally wires a bare remote as `origin`.
 */
export async function createFixtureRepo(opts: FixtureOpts = {}): Promise<Fixture> {
  const defaultBranch = opts.defaultBranch ?? 'main';
  const commitCount = opts.commits ?? 3;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-e2e-'));
  const rootPath = path.join(tmpBase, 'repo');
  fs.mkdirSync(rootPath);

  // git init + default branch. `-b` is available on git >= 2.28.
  await execGit(rootPath, ['init', '-b', defaultBranch]);

  // Locally-scoped config — GIT_* env vars cover author/committer, but some
  // subcommands still read `user.name`/`user.email` from config. Set them
  // explicitly to keep every path happy.
  await execGit(rootPath, ['config', 'user.name', 'IntelliG E2E']);
  await execGit(rootPath, ['config', 'user.email', 'e2e@intellig.test']);
  await execGit(rootPath, ['config', 'commit.gpgsign', 'false']);
  await execGit(rootPath, ['config', 'tag.gpgsign', 'false']);
  // Keep line-endings stable and force noop autocrlf so fixtures are
  // portable across dev machines.
  await execGit(rootPath, ['config', 'core.autocrlf', 'false']);

  // Seed commits.
  for (let i = 0; i < commitCount; i++) {
    const filePath = path.join(rootPath, `file${i}.txt`);
    fs.writeFileSync(filePath, `content-${i}\n`);
    await execGit(rootPath, ['add', `file${i}.txt`]);
    await execGit(rootPath, ['commit', '-m', `commit ${i}`]);
  }

  // Collect the commit hashes (oldest → newest) for later refs.
  const logResult = await execGit(rootPath, ['log', '--pretty=format:%H', '--reverse']);
  const hashes = logResult.stdout.split('\n').filter((s) => s.length > 0);

  // Branches off specific commits.
  if (opts.branches) {
    for (const b of opts.branches) {
      const baseIdx = b.fromCommit ?? hashes.length - 1;
      const base = hashes[baseIdx];
      if (!base) {
        throw new Error(
          `fixture: branch ${b.name} requested from commit ${baseIdx} but only ${hashes.length} exist`
        );
      }
      await execGit(rootPath, ['branch', b.name, base]);
    }
  }

  // Tags at specific commits.
  if (opts.tags) {
    for (const t of opts.tags) {
      const atIdx = t.atCommit ?? hashes.length - 1;
      const at = hashes[atIdx];
      if (!at) {
        throw new Error(
          `fixture: tag ${t.name} requested at commit ${atIdx} but only ${hashes.length} exist`
        );
      }
      if (t.message) {
        await execGit(rootPath, ['tag', '-a', t.name, at, '-m', t.message]);
      } else {
        await execGit(rootPath, ['tag', t.name, at]);
      }
    }
  }

  // Optional working-tree dirt.
  if (opts.withStagedChanges) {
    const staged = path.join(rootPath, 'staged.txt');
    fs.writeFileSync(staged, 'staged content v1\n');
    await execGit(rootPath, ['add', 'staged.txt']);
  }
  if (opts.withUnstagedChanges) {
    const unstaged = path.join(rootPath, 'unstaged.txt');
    fs.writeFileSync(unstaged, 'unstaged content\n');
    // If we want an unstaged modification rather than an untracked file,
    // commit it first then modify.
    await execGit(rootPath, ['add', 'unstaged.txt']);
    await execGit(rootPath, ['commit', '-m', 'add unstaged.txt']);
    fs.writeFileSync(unstaged, 'unstaged content (modified)\n');
  }

  // Optional bare remote wired as `origin`.
  let remotePath: string | undefined;
  if (opts.withRemote) {
    remotePath = path.join(tmpBase, 'origin.git');
    fs.mkdirSync(remotePath);
    await execGit(remotePath, ['init', '--bare', '-b', defaultBranch]);
    await execGit(rootPath, ['remote', 'add', 'origin', `file://${remotePath}`]);
    await execGit(rootPath, ['push', '-u', 'origin', defaultBranch]);
    // Push any extra branches too so `fetch`/`pull` tests have something to see.
    if (opts.branches) {
      for (const b of opts.branches) {
        await execGit(rootPath, ['push', 'origin', b.name]);
      }
    }
  }

  return {
    rootPath,
    ...(remotePath ? { remotePath } : {}),
    defaultBranch,
    cleanup: async (): Promise<void> => {
      // Best-effort — don't let cleanup errors mask test failures. The
      // method is async only so the caller can `await` it for ordering;
      // the body is still synchronous `fs.rmSync` because the on-disk
      // removal must complete before we hand back.
      try {
        fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Ignore — the OS will reap on reboot if something holds the dir open.
      }
    },
  };
}

/**
 * Rev-parse a ref to its full 40-char SHA. Throws if the ref is unknown.
 */
export async function revParse(cwd: string, ref: string): Promise<string> {
  const r = await execGit(cwd, ['rev-parse', ref]);
  return r.stdout.trim();
}

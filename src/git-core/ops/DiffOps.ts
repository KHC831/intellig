import { readConfig } from '../../config/configKeys';
import { ResultAsync, errAsync } from 'neverthrow';
import {
  IRepository,
  IDiff,
  IBlameLine,
  IRefDiffFile,
  CherryMark,
} from '../interfaces/IGitService';
import { buildGitArgs, revParseVerified, literalPathspec } from '../gitCli';
import { GitError, classifyGitCommandError } from '../errors';
import { parseDiff, parseBlame } from '../gitParser';
import { parseNameStatus } from '../nameStatus';
import { sortCommitsStable } from '../commitSort';
import { diffIgnorePolicyFlags, normalizeDiffIgnorePolicy } from '../diffIgnorePolicy';
import { IGitOpsContext } from './GitOpsContext';
import { getOutputChannel } from '../../utils/outputChannel';
import { isHexObjectId } from '../gitDirMarkers';

/**
 * Diff / blame / changed-files / merge-base / cherry-mark operations
 * extracted from the {@link GitService} façade. Stateless: reaches the live
 * GitCli lazily through {@link IGitOpsContext}.
 */
export class DiffOps {
  constructor(private readonly ctx: IGitOpsContext) {}

  /**
   * Resolve the user's configured diff whitespace ignore policy
   * (`intellig.diff.ignorePolicy`) into git whitespace flags. Returns an empty
   * array for the default (no-ignore) policy, so content diffs behave exactly
   * as before unless the user opts in. Mirrors IntelliJ's diff-viewer "Ignore
   * whitespace" dropdown — see {@link diffIgnorePolicyFlags}. The flags are
   * fixed literals (never user text), so splicing them into the argv is
   * injection-safe.
   */
  private whitespaceFlags(): string[] {
    const raw = readConfig('diff.ignorePolicy');
    return diffIgnorePolicyFlags(normalizeDiffIgnorePolicy(raw));
  }

  /**
   * Compute `git log --cherry-mark --left-right` classifications
   * between `baseRef` and HEAD.
   *
   * Under the hood we invoke:
   *
   *   git log --cherry-mark --left-right --pretty=format:%H %m HEAD...<baseRef>
   *
   * Each output line is `<hex-object-id> <mark>` (SHA-1 or SHA-256). We parse
   * into a Map so the Log tab can O(1)-look-up a given commit's classification.
   * Errors resolve to an empty map (caller gracefully degrades — non-critical).
   */
  async getCherryMarks(repo: IRepository, baseRef: string): Promise<Map<string, CherryMark>> {
    const out = new Map<string, CherryMark>();
    if (!baseRef) {
      return out;
    }

    try {
      // %m emits one of `<`, `>`, `=`, `+`, `-` per commit per --cherry-mark docs.
      // `baseRef` is user-controlled; splice via buildGitArgs.
      const result = await this.ctx.gitCli.exec(
        buildGitArgs(
          'log',
          ['--cherry-mark', '--left-right', '--pretty=format:%H %m'],
          [`HEAD...${baseRef}`]
        ),
        {
          cwd: repo.rootUri.fsPath,
          throwOnError: false,
        }
      );
      if (result.exitCode !== 0) {
        // Non-zero exit is a genuine fault here (a missing baseRef would have
        // short-circuited above), not an expected domain outcome — log so a real
        // failure isn't indistinguishable from "no cherry marks".
        getOutputChannel().appendLine(
          `[git] getCherryMarks exited ${result.exitCode} (degrading to no highlights): ${result.stderr.trim() || '<no stderr>'}`
        );
        return out;
      }
      if (!result.stdout) {
        return out;
      }
      const lines = result.stdout.split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) {
          continue;
        }
        // Format: "<hash> <mark>" — hash is a full 40/64-hex object id
        // (SHA-256-ready), mark is one char.
        const space = line.indexOf(' ');
        if (space < 0) {
          continue;
        }
        const hash = line.substring(0, space);
        if (!isHexObjectId(hash)) {
          continue;
        }
        const mark = line.substring(space + 1).trim();
        if (isCherryMark(mark)) {
          out.set(hash, mark);
        }
      }
      // eslint-disable-next-line no-restricted-syntax -- cherry marks are a non-essential visual cue; the UI degrades to "no highlights" rather than surfacing an error toast, but the fault is logged below.
    } catch (error) {
      // Degrade to "no highlights" rather than surfacing an error toast for a
      // non-essential visual cue — but log so a real spawn/system fault leaves a
      // trail instead of silently becoming an empty cherry-map.
      getOutputChannel().appendLine(
        `[git] getCherryMarks failed (degrading to no highlights): ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return out;
  }

  getDiff(repo: IRepository, path: string, staged?: boolean): ResultAsync<IDiff, GitError> {
    const args = ['diff'];
    if (staged) {
      args.push('--cached');
    }
    args.push(...this.whitespaceFlags());
    // literalPathspec runs synchronously here, outside ResultAsync.fromPromise
    // below — a throw (e.g. an empty path) would otherwise escape this
    // method entirely rather than surfacing as an Err the caller's absorb
    // boundary (GitService.getDiff's .match()) can log and degrade from.
    try {
      args.push('--', literalPathspec(path));
    } catch (error) {
      return errAsync(classifyGitCommandError(error));
    }

    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath }),
      classifyGitCommandError
    ).map((result) => {
      const diffs = parseDiff(result.stdout);
      // Return the first diff or an empty diff
      return diffs[0] || { path, status: 'modified', hunks: [], binary: false };
    });
  }

  getCommitDiff(repo: IRepository, hash: string): ResultAsync<IDiff[], GitError> {
    return ResultAsync.fromPromise(this._commitDiff(repo, hash), classifyGitCommandError);
  }

  private async _commitDiff(repo: IRepository, hash: string): Promise<IDiff[]> {
    // `hash` is user-controlled; splice via buildGitArgs so a
    // hostile ref like `--upload-pack=evil` cannot land as a flag.
    const result = await this.ctx.gitCli.exec(
      buildGitArgs('show', ['--format=', ...this.whitespaceFlags()], [hash]),
      {
        cwd: repo.rootUri.fsPath,
      }
    );

    return parseDiff(result.stdout);
  }

  /**
   * Get the combined diff for multiple commits.
   * This calculates the cumulative changes across all selected commits,
   * showing the total changes from the oldest commit's parent to the newest commit.
   *
   * The method sorts commits by their commit date to find the range,
   * then computes the diff between the oldest commit's parent and the newest commit.
   *
   * @param repo - The repository
   * @param commits - Array of commit hashes (can be in any order)
   * @returns Array of diffs representing the combined changes
   */
  getMultiCommitDiff(repo: IRepository, commits: string[]): ResultAsync<IDiff[], GitError> {
    return ResultAsync.fromPromise(this._multiCommitDiff(repo, commits), classifyGitCommandError);
  }

  private async _multiCommitDiff(repo: IRepository, commits: string[]): Promise<IDiff[]> {
    if (commits.length === 0) {
      return [];
    }

    // For a single commit, just return its diff
    if (commits.length === 1) {
      return this._commitDiff(repo, commits[0]);
    }

    const cwd = repo.rootUri.fsPath;

    // Get commit dates + parents to sort them chronologically.
    // We need the oldest and newest commits to compute the range, and we
    // need parent hashes so `sortCommitsStable` can resolve date ties
    // topologically (parent-before-child) rather than by hash-alphabetical
    // alone. Same-second timestamps are common in imported histories and
    // squash-and-rebase flows; ordering a child before its parent would
    // push the diff "base" past the child and silently drop edits.
    const commitInfos: { hash: string; commitDate: Date; parents: string[] }[] = [];

    for (const hash of commits) {
      // `%cI` (commit-date ISO-8601) + `%P` (space-separated parent hashes),
      // separated by a tab so we can split unambiguously.
      // `hash` is user-controlled; splice via buildGitArgs.
      const result = await this.ctx.gitCli.exec(
        buildGitArgs('show', ['-s', '--format=%cI%x09%P'], [hash]),
        { cwd }
      );
      if (result.exitCode === 0 && result.stdout.trim()) {
        const [iso, parentsLine = ''] = result.stdout.trim().split('\t');
        const parents = parentsLine.split(/\s+/).filter((p) => p.length > 0);
        commitInfos.push({
          hash,
          commitDate: new Date(iso),
          parents,
        });
      }
    }

    if (commitInfos.length === 0) {
      return [];
    }

    // Deterministic sort: primary by commit date, secondary by
    // parent-before-child (topological) inside date-tied groups, and only
    // falling back to hash-alphabetical when no parent edge disambiguates.
    // See `src/utils/commitSort.ts` for the full rationale.
    const sortedInfos = sortCommitsStable(commitInfos);

    const oldestCommit = sortedInfos[0].hash;
    const newestCommit = sortedInfos[sortedInfos.length - 1].hash;

    // Get the parent of the oldest commit to use as the base, via
    // revParseVerified (a flagless rev-parse echoes a literal
    // `--end-of-options` line into stdout, corrupting the base ref).
    // If the oldest commit has no parent (initial commit), use the empty tree.
    const parent = await revParseVerified(this.ctx.gitCli, cwd, `${oldestCommit}^`);
    // Git's magic empty-tree SHA when there is no parent.
    const baseRef = parent ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

    // Restrict the range diff to only the paths the SELECTED commits actually
    // touched. Without this scoping a non-contiguous selection (pick A and C,
    // skip B) surfaced every file B changed too — the range `A^..C` includes B.
    // IntelliJ unions the selected commits' own change lists
    // (VcsLogUtil.collectChanges → zipChanges); scoping the range diff to the
    // union of touched paths is the git-native equivalent: a path touched only
    // by an unselected intermediate commit is excluded, while a path several
    // selected commits changed shows its net effect across the range.
    // Both refs are user-controlled (baseRef may be a computed parent SHA;
    // newestCommit is direct user input) and the paths ride behind `--` via
    // buildGitArgs, which wraps each one `:(literal)` (PATH_SLOT_KIND['diff'])
    // so a touched path holding `*`, `?` or `[` cannot also match a same-shaped
    // neighbour outside the selected commits. When no touched paths are
    // discovered (should not happen for real non-empty commits), fall back to
    // the UNSCOPED range diff rather than hiding a real change.
    const touchedPaths = await this._collectTouchedPaths(cwd, commits);
    const diffResult = await this.ctx.gitCli.exec(
      buildGitArgs(
        'diff',
        this.whitespaceFlags(),
        [baseRef, newestCommit],
        touchedPaths.length > 0 ? touchedPaths : undefined
      ),
      {
        cwd,
      }
    );

    return parseDiff(diffResult.stdout);
  }

  /**
   * Union of the file paths the given commits touched, via
   * `git show --name-only -z --format=` per commit. `-z` keeps non-ASCII /
   * special-character paths verbatim (git otherwise C-quotes them). Used to
   * scope the multi-commit range diff to only the selected commits' changes.
   */
  private async _collectTouchedPaths(cwd: string, commits: string[]): Promise<string[]> {
    const touched = new Set<string>();
    for (const commit of commits) {
      const res = await this.ctx.gitCli.exec(
        buildGitArgs('show', ['--name-only', '-z', '--format='], [commit]),
        { cwd }
      );
      if (res.exitCode !== 0) {
        continue;
      }
      for (const name of res.stdout.split('\0')) {
        if (name.length > 0) {
          touched.add(name);
        }
      }
    }
    return [...touched];
  }

  /**
   * List files that differ between the given ref and the working tree.
   * Uses `git diff --name-status -z <ref>` for robust parsing (NUL-delimited,
   * so paths with whitespace or non-ASCII characters are handled correctly).
   */
  getChangedFilesAgainstWorkingTree(
    repo: IRepository,
    ref: string
  ): ResultAsync<IRefDiffFile[], GitError> {
    return ResultAsync.fromPromise(
      this._changedFilesAgainstWorkingTree(repo, ref),
      classifyGitCommandError
    );
  }

  /**
   * List files that differ between two refs (`git diff --name-status -z
   * <refA> <refB>`). Same parser and injection discipline as the
   * working-tree variant; both refs splice via buildGitArgs.
   */
  getChangedFilesBetweenRefs(
    repo: IRepository,
    refA: string,
    refB: string
  ): ResultAsync<IRefDiffFile[], GitError> {
    return ResultAsync.fromPromise(
      this._changedFilesForDiffArgs(repo, [refA, refB]),
      classifyGitCommandError
    );
  }

  private async _changedFilesAgainstWorkingTree(
    repo: IRepository,
    ref: string
  ): Promise<IRefDiffFile[]> {
    return this._changedFilesForDiffArgs(repo, [ref]);
  }

  private async _changedFilesForDiffArgs(
    repo: IRepository,
    refs: string[]
  ): Promise<IRefDiffFile[]> {
    // refs are user-controlled; splice via buildGitArgs.
    const result = await this.ctx.gitCli.exec(buildGitArgs('diff', ['--name-status', '-z'], refs), {
      cwd: repo.rootUri.fsPath,
    });

    if (result.exitCode !== 0) {
      return [];
    }

    return parseNameStatus(result.stdout);
  }

  /**
   * Compute the merge-base of two refs.
   *
   * Wraps `git merge-base --end-of-options <refA> <refB>`. Returns the
   * common-ancestor SHA on success, or `undefined` when:
   *   - the refs share no common ancestor (git exits with code 1), or
   *   - the refs are unknown (git exits with code 128 and writes a
   *     "fatal: ..." line to stderr), or
   *   - any other non-zero exit (defensive — caller treats as no path).
   *
   * `--end-of-options` separates options from
   * positional refs, so a hostile ref string like `--upload-pack=evil`
   * can never be interpreted by git as an option flag. The host-side
   * caller in {@link GitToolWindowProvider.setFocusedBranch} also
   * validates branch names against the live branchMap before invoking
   * this method (defense in depth — neither layer alone is sufficient).
   *
   * Used by the Git tool window's branch-focus feature.
   */
  getMergeBase(
    repo: IRepository,
    refA: string,
    refB: string
  ): ResultAsync<string | undefined, GitError> {
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(['merge-base', '--end-of-options', refA, refB], {
        cwd: repo.rootUri.fsPath,
      }),
      classifyGitCommandError
    ).map((result) => {
      // A non-zero exit (no common ancestor, unknown refs, …) or empty output
      // is the expected domain absence → Ok(undefined). A spawn/system fault
      // arrives as an Err above and is NOT collapsed into "no merge base".
      if (result.exitCode !== 0) {
        return undefined;
      }
      const sha = result.stdout.trim();
      return sha.length > 0 ? sha : undefined;
    });
  }

  /**
   * Load a file's content as of a specific revision — the "Get version" /
   * open-revision path in file history.
   *
   * Wraps `git show <rev>:<path>`. The `<rev>:<path>` spec is a single
   * positional object argument; `buildGitArgs` inserts `--end-of-options`
   * before it so a hostile ref like `--upload-pack=evil` can never be parsed
   * as a flag (`rev` + `path` are validated structurally, never shell-spliced).
   *
   * Mirrors IntelliJ's `GitFileRevision.loadContent` →
   * `GitFileUtils.getFileContent`
   * (git4idea/backend/src/util/GitFileUtils.kt), which materialises the blob
   * via `git cat-file -p <rev>:<path>`; `git show <rev>:<path>` is the
   * equivalent already used by the `intellig-git:` content provider.
   *
   * Returns the file content on success, or an empty string when the file does
   * not exist at that revision (git exits non-zero) — the caller surfaces an
   * empty document rather than an error for the common "added later" case.
   */
  getFileAtRevision(repo: IRepository, path: string, rev: string): ResultAsync<string, GitError> {
    return ResultAsync.fromPromise(
      this.ctx.gitCli.exec(buildGitArgs('show', [], [`${rev}:${path}`]), {
        cwd: repo.rootUri.fsPath,
      }),
      classifyGitCommandError
      // A non-zero exit (the file does not exist at that revision) is the
      // expected domain absence → empty content. A spawn/system fault arrives
      // as an Err above and is NOT collapsed into "".
    ).map((result) => (result.exitCode !== 0 ? '' : result.stdout));
  }

  getBlame(repo: IRepository, path: string): ResultAsync<IBlameLine[], GitError> {
    // `path` is user-controlled; splice with `--` separator
    // via buildGitArgs so a path that starts with `-` cannot collapse
    // into a flag (e.g., `--git-dir=evil`).
    return ResultAsync.fromPromise(
      // git-path-quote-exempt: blame porcelain is parsed for hunks and commit metadata; its quoted `filename` line is never read
      this.ctx.gitCli.exec(buildGitArgs('blame', ['--porcelain'], [], [path]), {
        cwd: repo.rootUri.fsPath,
      }),
      classifyGitCommandError
    ).map((result) => (result.exitCode !== 0 ? [] : parseBlame(result.stdout)));
  }
}

/** Type guard for a single-char `git log --cherry-mark` output. */
function isCherryMark(value: string): value is CherryMark {
  return value === '=' || value === '+' || value === '-' || value === '<' || value === '>';
}

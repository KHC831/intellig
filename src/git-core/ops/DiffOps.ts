import * as vscode from 'vscode';
import {
  IRepository,
  IDiff,
  IBlameLine,
  IRefDiffFile,
  CherryMark,
} from '../interfaces/IGitService';
import { buildGitArgs } from '../gitCli';
import { parseDiff, parseBlame } from '../gitParser';
import { sortCommitsStable } from '../commitSort';
import { diffIgnorePolicyFlags, normalizeDiffIgnorePolicy } from '../diffIgnorePolicy';
import { IGitOpsContext } from './GitOpsContext';

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
    const raw = vscode.workspace.getConfiguration('intellig.diff').get<string>('ignorePolicy');
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
   * Each output line is `<40-hex> <mark>`. We parse into a Map so the Log tab
   * can O(1)-look-up a given commit's classification. Errors resolve to an
   * empty map (caller gracefully degrades — the feature is non-critical).
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
      if (result.exitCode !== 0 || !result.stdout) {
        return out;
      }
      const lines = result.stdout.split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) {
          continue;
        }
        // Format: "<hash> <mark>" — hash is 40 hex, mark is one char.
        const space = line.indexOf(' ');
        if (space !== 40) {
          continue;
        }
        const hash = line.substring(0, 40);
        const mark = line.substring(space + 1).trim();
        if (isCherryMark(mark)) {
          out.set(hash, mark);
        }
      }
    } catch {
      // Swallow — the UI degrades to "no highlights" rather than surfacing
      // an error toast for a non-essential visual cue.
    }
    return out;
  }

  async getDiff(repo: IRepository, path: string, staged?: boolean): Promise<IDiff> {
    const args = ['diff'];
    if (staged) {
      args.push('--cached');
    }
    args.push(...this.whitespaceFlags());
    args.push('--', path);

    const result = await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath });
    const diffs = parseDiff(result.stdout);

    // Return the first diff or an empty diff
    return (
      diffs[0] || {
        path,
        status: 'modified',
        hunks: [],
        binary: false,
      }
    );
  }

  async getCommitDiff(repo: IRepository, hash: string): Promise<IDiff[]> {
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
  async getMultiCommitDiff(repo: IRepository, commits: string[]): Promise<IDiff[]> {
    if (commits.length === 0) {
      return [];
    }

    // For a single commit, just return its diff
    if (commits.length === 1) {
      return this.getCommitDiff(repo, commits[0]);
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

    // Get the parent of the oldest commit to use as the base
    // If the oldest commit has no parent (initial commit), use the empty tree
    // `oldestCommit` is user-controlled; splice via buildGitArgs.
    const parentResult = await this.ctx.gitCli.exec(
      buildGitArgs('rev-parse', [], [`${oldestCommit}^`]),
      { cwd }
    );

    let baseRef: string;
    if (parentResult.exitCode === 0 && parentResult.stdout.trim()) {
      baseRef = parentResult.stdout.trim();
    } else {
      // No parent - use empty tree SHA (Git's magic empty tree)
      baseRef = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    }

    // Get the diff between the base and the newest commit.
    // Both refs are user-controlled (well, baseRef may be a
    // computed parent SHA; newestCommit is direct user input). Splice
    // via buildGitArgs.
    const diffResult = await this.ctx.gitCli.exec(
      buildGitArgs('diff', this.whitespaceFlags(), [baseRef, newestCommit]),
      {
        cwd,
      }
    );

    return parseDiff(diffResult.stdout);
  }

  /**
   * List files that differ between the given ref and the working tree.
   * Uses `git diff --name-status -z <ref>` for robust parsing (NUL-delimited,
   * so paths with whitespace or non-ASCII characters are handled correctly).
   */
  async getChangedFilesAgainstWorkingTree(repo: IRepository, ref: string): Promise<IRefDiffFile[]> {
    // `ref` is user-controlled; splice via buildGitArgs.
    const result = await this.ctx.gitCli.exec(
      buildGitArgs('diff', ['--name-status', '-z'], [ref]),
      {
        cwd: repo.rootUri.fsPath,
      }
    );

    if (result.exitCode !== 0) {
      return [];
    }

    // `git diff --name-status -z` output format:
    //   <status>\0<path>\0                  for M/A/D/T/U entries
    // <status>\0<oldPath>\0<newPath>\0 for R/C entries (status can be `R100`, ``, …)
    const tokens = result.stdout.split('\0').filter((t) => t.length > 0);
    const files: IRefDiffFile[] = [];
    let i = 0;
    while (i < tokens.length) {
      const rawStatus = tokens[i];
      const statusChar = rawStatus.charAt(0).toUpperCase();
      i += 1;

      if (statusChar === 'R' || statusChar === 'C') {
        const oldPath = tokens[i];
        const newPath = tokens[i + 1];
        i += 2;
        if (newPath) {
          files.push({
            path: newPath,
            status: statusChar,
            oldPath,
          });
        }
      } else if (
        statusChar === 'M' ||
        statusChar === 'A' ||
        statusChar === 'D' ||
        statusChar === 'T' ||
        statusChar === 'U'
      ) {
        const filePath = tokens[i];
        i += 1;
        if (filePath) {
          files.push({
            path: filePath,
            status: statusChar,
          });
        }
      } else {
        // Unknown status; skip the following path token to stay aligned.
        i += 1;
      }
    }

    return files;
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
  async getMergeBase(repo: IRepository, refA: string, refB: string): Promise<string | undefined> {
    try {
      const result = await this.ctx.gitCli.exec(['merge-base', '--end-of-options', refA, refB], {
        cwd: repo.rootUri.fsPath,
      });
      if (result.exitCode !== 0) {
        return undefined;
      }
      const sha = result.stdout.trim();
      return sha.length > 0 ? sha : undefined;
    } catch {
      // Defensive: GitCli throws on spawn errors / disposed repos.
      // Trap T-8 — caller treats undefined as "no path-to-merge-base".
      return undefined;
    }
  }

  async getBlame(repo: IRepository, path: string): Promise<IBlameLine[]> {
    // `path` is user-controlled; splice with `--` separator
    // via buildGitArgs so a path that starts with `-` cannot collapse
    // into a flag (e.g., `--git-dir=evil`).
    const result = await this.ctx.gitCli.exec(buildGitArgs('blame', ['--porcelain'], [], [path]), {
      cwd: repo.rootUri.fsPath,
    });

    if (result.exitCode !== 0) {
      return [];
    }

    return parseBlame(result.stdout);
  }
}

/** Type guard for a single-char `git log --cherry-mark` output. */
function isCherryMark(value: string): value is CherryMark {
  return value === '=' || value === '+' || value === '-' || value === '<' || value === '>';
}

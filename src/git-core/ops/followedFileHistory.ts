import { buildGitArgs, type GitCli } from '../gitCli';
import { sortCommitsStable } from '../commitSort';
import { parseNameStatus } from '../nameStatus';
import { ICommit, IFileHistoryOptions, IRepository } from '../interfaces/IGitService';
import { getOutputChannel } from '../../utils/outputChannel';

/** Runs `git log` for one path, with `--follow` when `follow` is set. */
export type FileLogRunner = (
  path: string,
  options: IFileHistoryOptions | undefined,
  follow: boolean
) => Promise<ICommit[]>;

/** How many renames made inside merge commits one history walks back through. */
const MAX_MERGE_RENAMES = 10;

/**
 * A file's history across renames, including a rename made inside a merge
 * commit (IntelliJ's GitFileHistory walks renames itself for this).
 *
 * `git log --follow` loses such a rename, and what it loses depends on the
 * git version: 2.50 stops at the merge, 2.56 returns the merged-in side
 * without the merge. So the plain log for the path, which always holds the
 * merge, is merged in, and when the oldest commit is a merge whose parent had
 * the file under another name, the history continues under that name from
 * that parent.
 */
export async function followedFileHistory(
  gitCli: GitCli,
  repo: IRepository,
  path: string,
  options: IFileHistoryOptions | undefined,
  runLog: FileLogRunner,
  renamesLeft = MAX_MERGE_RENAMES
): Promise<ICommit[]> {
  const [followed, plain] = await Promise.all([
    runLog(path, options, true),
    runLog(path, options, false),
  ]);
  let commits = newestFirst([...followed, ...plain]);

  const oldest = commits[commits.length - 1];
  if (oldest !== undefined && oldest.parents.length > 1 && renamesLeft > 0) {
    for (const parent of oldest.parents) {
      const from = await renamedFrom(gitCli, repo, parent, oldest.hash, path);
      if (from !== undefined) {
        const older = await followedFileHistory(
          gitCli,
          repo,
          from,
          { ...options, branch: parent },
          runLog,
          renamesLeft - 1
        );
        commits = newestFirst([...commits, ...older]);
      }
    }
  }

  const max = options?.maxCount;
  return max !== undefined && max > 0 ? commits.slice(0, max) : commits;
}

/** The path `path` had in `parent`, when `merge` renamed it relative to that parent. */
async function renamedFrom(
  gitCli: GitCli,
  repo: IRepository,
  parent: string,
  merge: string,
  path: string
): Promise<string | undefined> {
  const result = await gitCli.exec(
    buildGitArgs('diff', ['--name-status', '-z', '-M'], [parent, merge]),
    { cwd: repo.rootUri.fsPath }
  );
  if (result.exitCode !== 0) {
    getOutputChannel().appendLine(
      `[git] getFileHistory rename lookup exited ${result.exitCode} (history stops at the merge): ${result.stderr.trim() || '<no stderr>'}`
    );
    return undefined;
  }
  return parseNameStatus(result.stdout).find((f) => f.status === 'R' && f.path === path)?.oldPath;
}

/** Distinct commits, newest first, each before its parents. */
function newestFirst(commits: readonly ICommit[]): ICommit[] {
  const distinct = new Map<string, ICommit>();
  for (const c of commits) {
    if (!distinct.has(c.hash)) {
      distinct.set(c.hash, c);
    }
  }
  return sortCommitsStable([...distinct.values()]).reverse();
}

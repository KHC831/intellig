import {
  ICommit,
  IAuthor,
  IBranch,
  ITag,
  IFileStatus,
  IStash,
  IRemote,
  IHead,
  IUpstream,
  IDiff,
  IHunk,
  IBlameLine,
  StatusCode,
  FileStatus,
  BranchType,
  DiffLineType,
  RepositoryState,
} from './interfaces/IGitService';

/**
 * Parse Git status output (porcelain v1 format) into file status objects.
 *
 * @param output - The output from `git status --porcelain`
 * @returns Array of file status objects
 */
export function parseStatus(output: string): IFileStatus[] {
  const files: IFileStatus[] = [];
  const lines = output.split('\n').filter((line) => line.length > 0);

  for (const line of lines) {
    if (line.length < 3) {
      continue;
    }

    const indexStatus = line[0] as StatusCode;
    const workTreeStatus = line[1] as StatusCode;
    let path = line.substring(3);
    let renamed: string | undefined;

    // Handle renamed files (format: "R  old -> new")
    if (indexStatus === 'R' || workTreeStatus === 'R') {
      const arrowIndex = path.indexOf(' -> ');
      if (arrowIndex !== -1) {
        renamed = path.substring(0, arrowIndex);
        path = path.substring(arrowIndex + 4);
      }
    }

    // Handle copied files (format: "C  original -> copy")
    if (indexStatus === 'C' || workTreeStatus === 'C') {
      const arrowIndex = path.indexOf(' -> ');
      if (arrowIndex !== -1) {
        renamed = path.substring(0, arrowIndex);
        path = path.substring(arrowIndex + 4);
      }
    }

    files.push({
      path,
      indexStatus,
      workTreeStatus,
      renamed,
    });
  }

  return files;
}

/**
 * Convert status codes to human-readable file status.
 *
 * @param indexStatus - The index status code
 * @param workTreeStatus - The work tree status code
 * @returns The file status
 */
export function statusCodeToFileStatus(
  indexStatus: StatusCode,
  workTreeStatus: StatusCode
): FileStatus {
  // Check for conflicts first
  if (indexStatus === 'U' || workTreeStatus === 'U') {
    return 'conflicted';
  }

  // Check index status
  switch (indexStatus) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'M':
      return 'modified';
  }

  // Check work tree status
  switch (workTreeStatus) {
    case '?':
      return 'untracked';
    case '!':
      return 'ignored';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'M':
      return 'modified';
  }

  return 'modified';
}

/**
 * Parse Git log output into commit objects.
 * Expects format: %H<sep>%h<sep>%an<sep>%ae<sep>%aI<sep>%cn<sep>%ce<sep>%cI<sep>%P<sep>%s%n%b
 *
 * Wave I — separator switched from `|` to `\x1f` (ASCII Unit Separator,
 * RFC 1345). The previous pipe separator collided with author/committer
 * names containing `|` (legitimate in Unicode-name policies, common in
 * imported histories) and silently corrupted every downstream field.
 * `\x1f` is in the C0 control range and never appears in a normalised
 * git ident or commit subject.
 *
 * @param output - The output from `git log` with the specified format
 * @param separator - The field separator (default: `\x1f`)
 * @returns Array of commit objects
 */
export function parseLog(output: string, separator: string = '\x1f'): ICommit[] {
  const commits: ICommit[] = [];
  const entries = output.split('\0').filter((entry) => entry.trim().length > 0);

  for (const entry of entries) {
    const lines = entry.split('\n');
    if (lines.length === 0) {
      continue;
    }

    const firstLine = lines[0];
    const parts = firstLine.split(separator);

    if (parts.length < 10) {
      continue;
    }

    const [
      hash,
      shortHash,
      authorName,
      authorEmail,
      authorDateStr,
      committerName,
      committerEmail,
      commitDateStr,
      parentsStr,
      subject,
    ] = parts;

    const body = lines.slice(1).join('\n').trim() || undefined;
    const parents = parentsStr ? parentsStr.split(' ').filter((p) => p.length > 0) : [];

    commits.push({
      hash,
      shortHash,
      message: subject,
      body,
      author: {
        name: authorName,
        email: authorEmail,
      },
      committer: {
        name: committerName,
        email: committerEmail,
      },
      parents,
      authorDate: new Date(authorDateStr),
      commitDate: new Date(commitDateStr),
    });
  }

  return commits;
}

/**
 * Parse a single commit from Git show output.
 *
 * Wave I — separator default switched to `\x1f` to match `parseLog`.
 *
 * @param output - The output from `git show` with the specified format
 * @param separator - The field separator (default: `\x1f`)
 * @returns The commit object, or undefined if parsing fails
 */
export function parseCommit(output: string, separator: string = '\x1f'): ICommit | undefined {
  const commits = parseLog(output, separator);
  return commits.length > 0 ? commits[0] : undefined;
}

/**
 * Parse Git branch output into branch objects.
 *
 * @param output - The output from `git branch -a --format`
 * @returns Array of branch objects
 */
export function parseBranches(output: string): IBranch[] {
  const branches: IBranch[] = [];
  const lines = output.split('\n').filter((line) => line.trim().length > 0);

  for (const line of lines) {
    // Format: refname|objectname|upstream|HEAD
    const parts = line.split('|');
    if (parts.length < 4) {
      continue;
    }

    const [refname, commit, upstream, head] = parts;

    // Wave F — filter out git's pseudo-refs for detached HEAD / rebase /
    // bisect / cherry-pick. These appear in `git branch -a --format` output
    // as parenthesized strings (e.g. `(HEAD detached at 5eed84b)`,
    // `(no branch, rebasing main)`). They have a real commit hash and
    // `%(HEAD) === '*'` set, but they are NOT branches — they're
    // descriptive labels git writes when no symbolic ref exists.
    //
    // Letting them pass as `type='local'` branches caused a "is not a
    // commit" failure in `_handleNewBranchFrom` (the parenthesized name
    // was passed verbatim to `git checkout -b <new> <startPoint>`), and
    // visible bogus entries in the branch tree + log chips. Detached
    // state is surfaced separately via `repo.head?.commit` (see
    // `StatusBarService:273-276`, `BranchPopup:704-707`).
    //
    // Real branches always emit `refs/heads/...` / `refs/remotes/...` /
    // `refs/tags/...` as their `%(refname)` value, so even a legitimate
    // branch named literally `(foo)` is emitted as `refs/heads/(foo)` and
    // survives this filter (the trimmed refname starts with `r`, not `(`).
    // Only git's parenthesized PSEUDO-REFS (which never carry the `refs/...`
    // prefix because they aren't real refs) match `^\(.*\)$`.
    if (/^\(.*\)$/.test(refname.trim())) {
      continue;
    }

    const isHead = head === '*';

    let name = refname;
    let type: BranchType = 'local';

    // Determine branch type and clean up name
    if (refname.startsWith('refs/heads/')) {
      name = refname.substring('refs/heads/'.length);
      type = 'local';
    } else if (refname.startsWith('refs/remotes/')) {
      name = refname.substring('refs/remotes/'.length);
      type = 'remote';
    } else if (refname.startsWith('refs/tags/')) {
      name = refname.substring('refs/tags/'.length);
      type = 'tag';
    }

    let upstreamInfo: IUpstream | undefined;
    if (upstream && upstream.length > 0) {
      const upstreamParts = upstream.split('/');
      if (upstreamParts.length >= 2) {
        upstreamInfo = {
          remote: upstreamParts[0],
          name: upstreamParts.slice(1).join('/'),
        };
      }
    }

    branches.push({
      name,
      type,
      commit,
      upstream: upstreamInfo,
      isHead,
    });
  }

  return branches;
}

/**
 * Parse Git tag output into tag objects.
 *
 * Wave I R1 — separator switched from `|` to `\x1f` (ASCII Unit Separator).
 * The previous pipe separator collided with tagger names containing `|`
 * (legitimate in Unicode-name policies, common in imported histories) and
 * silently corrupted every downstream field. `\x1f` is in the C0 control
 * range and never appears in a normalised git ident or tag subject.
 * Mirrors the `parseLog` Wave I switch.
 *
 * @param output - The output from `git tag -l --format`
 * @param separator - The field separator (default: `\x1f`)
 * @returns Array of tag objects
 */
export function parseTags(output: string, separator: string = '\x1f'): ITag[] {
  const tags: ITag[] = [];
  const lines = output.split('\n').filter((line) => line.trim().length > 0);

  for (const line of lines) {
    // Format: refname<sep>objectname<sep>objecttype<sep>taggername<sep>taggeremail<sep>taggerdate<sep>subject
    const parts = line.split(separator);
    if (parts.length < 3) {
      continue;
    }

    const [refname, commit, objectType, taggerName, taggerEmail, taggerDate, subject] = parts;

    let name = refname;
    if (name.startsWith('refs/tags/')) {
      name = name.substring('refs/tags/'.length);
    }

    const isAnnotated = objectType === 'tag';

    let tagger: IAuthor | undefined;
    let date: Date | undefined;

    if (isAnnotated && taggerName && taggerEmail) {
      tagger = {
        name: taggerName,
        email: taggerEmail,
      };
      if (taggerDate) {
        date = new Date(taggerDate);
      }
    }

    tags.push({
      name,
      commit,
      message: subject || undefined,
      tagger,
      date,
      isAnnotated,
    });
  }

  return tags;
}

/**
 * Parse Git stash list output into stash objects.
 *
 * @param output - The output from `git stash list`
 * @returns Array of stash objects
 */
export function parseStashList(output: string): IStash[] {
  const stashes: IStash[] = [];
  const lines = output.split('\n').filter((line) => line.trim().length > 0);

  for (const line of lines) {
    // Format: stash@{N}: WIP on branch: message
    // or: stash@{N}: On branch: message
    const match = line.match(/^stash@\{(\d+)\}:\s*(?:WIP on|On)\s+([^:]+):\s*(.*)$/);
    if (match) {
      const [, indexStr, branch, message] = match;
      stashes.push({
        index: parseInt(indexStr, 10),
        message: message || `WIP on ${branch}`,
        date: new Date(), // Git stash list doesn't include date by default
        branch,
      });
    }
  }

  return stashes;
}

/**
 * Parse Git remote output into remote objects.
 *
 * @param output - The output from `git remote -v`
 * @returns Array of remote objects
 */
export function parseRemotes(output: string): IRemote[] {
  const remoteMap = new Map<string, IRemote>();
  const lines = output.split('\n').filter((line) => line.trim().length > 0);

  for (const line of lines) {
    // Format: name\turl (fetch|push)
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (match) {
      const [, name, url, type] = match;

      let remote = remoteMap.get(name);
      if (!remote) {
        remote = { name };
        remoteMap.set(name, remote);
      }

      if (type === 'fetch') {
        remote.fetchUrl = url;
      } else {
        remote.pushUrl = url;
      }
    }
  }

  return Array.from(remoteMap.values());
}

/**
 * Parse HEAD information from various Git commands.
 *
 * @param branchOutput - Output from `git symbolic-ref HEAD` or `git rev-parse HEAD`
 * @param commitOutput - Output from `git rev-parse HEAD`
 * @param upstreamOutput - Output from `git rev-parse --abbrev-ref @{upstream}`
 * @param aheadBehindOutput - Output from `git rev-list --left-right --count HEAD...@{upstream}`
 * @returns The HEAD information
 */
export function parseHead(
  branchOutput: string,
  commitOutput: string,
  upstreamOutput?: string,
  aheadBehindOutput?: string
): IHead {
  let name: string | undefined;
  const commit = commitOutput.trim();

  // Parse branch name
  const branchTrimmed = branchOutput.trim();
  if (branchTrimmed.startsWith('refs/heads/')) {
    name = branchTrimmed.substring('refs/heads/'.length);
  } else if (!branchTrimmed.startsWith('refs/') && branchTrimmed.length > 0) {
    name = branchTrimmed;
  }

  // Parse upstream
  let upstream: IUpstream | undefined;
  if (upstreamOutput) {
    const upstreamTrimmed = upstreamOutput.trim();
    if (upstreamTrimmed.length > 0) {
      const slashIndex = upstreamTrimmed.indexOf('/');
      if (slashIndex !== -1) {
        upstream = {
          remote: upstreamTrimmed.substring(0, slashIndex),
          name: upstreamTrimmed.substring(slashIndex + 1),
        };
      }
    }
  }

  // Parse ahead/behind
  let ahead = 0;
  let behind = 0;
  if (aheadBehindOutput) {
    const parts = aheadBehindOutput.trim().split(/\s+/);
    if (parts.length >= 2) {
      ahead = parseInt(parts[0], 10) || 0;
      behind = parseInt(parts[1], 10) || 0;
    }
  }

  return {
    name,
    commit,
    upstream,
    ahead,
    behind,
  };
}

/**
 * Parse repository state from Git status.
 *
 * @param gitDir - Path to the .git directory
 * @param statusOutput - Output from `git status`
 * @returns The repository state
 */
export function parseRepositoryState(statusOutput: string): RepositoryState {
  const lowerOutput = statusOutput.toLowerCase();

  if (
    lowerOutput.includes('rebase in progress') ||
    lowerOutput.includes('interactive rebase in progress')
  ) {
    return 'rebasing';
  }
  if (
    lowerOutput.includes('merge in progress') ||
    lowerOutput.includes('you have unmerged paths')
  ) {
    return 'merging';
  }
  if (lowerOutput.includes('cherry-pick in progress')) {
    return 'cherry-picking';
  }
  if (lowerOutput.includes('revert in progress')) {
    return 'reverting';
  }

  return 'idle';
}

/**
 * Parse unified diff output into diff objects.
 *
 * @param output - The unified diff output
 * @returns Array of diff objects
 */
export function parseDiff(output: string): IDiff[] {
  const diffs: IDiff[] = [];
  const diffBlocks = output.split(/^diff --git /m).filter((block) => block.trim().length > 0);

  for (const block of diffBlocks) {
    const lines = block.split('\n');
    if (lines.length === 0) {
      continue;
    }

    // Parse file paths from first line: a/path b/path
    const pathMatch = lines[0].match(/^a\/(.+)\s+b\/(.+)$/);
    if (!pathMatch) {
      continue;
    }

    const [, oldPath, newPath] = pathMatch;
    const path = newPath;

    // Determine file status
    let status: FileStatus = 'modified';
    let binary = false;

    for (const line of lines) {
      if (line.startsWith('new file mode')) {
        status = 'added';
      } else if (line.startsWith('deleted file mode')) {
        status = 'deleted';
      } else if (line.startsWith('rename from')) {
        status = 'renamed';
      } else if (line.startsWith('copy from')) {
        status = 'copied';
      } else if (line.includes('Binary files')) {
        binary = true;
      }
    }

    // Parse hunks
    const hunks = parseHunks(lines);

    diffs.push({
      path,
      oldPath: oldPath !== newPath ? oldPath : undefined,
      status,
      hunks,
      binary,
    });
  }

  return diffs;
}

/**
 * Parse hunks from diff lines.
 *
 * @param lines - The diff lines
 * @returns Array of hunk objects
 */
export function parseHunks(lines: string[]): IHunk[] {
  const hunks: IHunk[] = [];
  let currentHunk: IHunk | undefined;

  for (const line of lines) {
    // Hunk header: @@ -oldStart,oldLines +newStart,newLines @@ optional context
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);

    if (hunkMatch) {
      // Save previous hunk
      if (currentHunk) {
        hunks.push(currentHunk);
      }

      const [, oldStartStr, oldLinesStr, newStartStr, newLinesStr] = hunkMatch;

      currentHunk = {
        oldStart: parseInt(oldStartStr, 10),
        oldLines: oldLinesStr ? parseInt(oldLinesStr, 10) : 1,
        newStart: parseInt(newStartStr, 10),
        newLines: newLinesStr ? parseInt(newLinesStr, 10) : 1,
        header: line,
        lines: [],
      };

      continue;
    }

    // Parse diff lines within a hunk
    if (currentHunk) {
      let type: DiffLineType;
      let content = line;

      if (line.startsWith('+')) {
        type = 'add';
        content = line.substring(1);
      } else if (line.startsWith('-')) {
        type = 'delete';
        content = line.substring(1);
      } else if (line.startsWith(' ') || line === '') {
        type = 'context';
        content = line.substring(1);
      } else {
        // Skip non-diff lines (like "\ No newline at end of file")
        continue;
      }

      currentHunk.lines.push({
        type,
        content,
      });
    }
  }

  // Don't forget the last hunk
  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}

/**
 * Parse Git blame output into blame line objects.
 *
 * @param output - The output from `git blame --porcelain`
 * @returns Array of blame line objects
 */
export function parseBlame(output: string): IBlameLine[] {
  const blameLines: IBlameLine[] = [];
  const lines = output.split('\n');

  let currentCommit = '';
  let currentAuthor = '';
  let currentAuthorEmail = '';
  let currentDate: Date | undefined;
  let currentMessage = '';
  let currentLine = 0;
  let previousCommit: string | undefined;
  // Emitted by git blame's `previous <sha> <path>` header when -M/-C detect
  // that the line was in a different file at the parent commit.
  let previousFilename: string | undefined;

  for (const line of lines) {
    // Commit line: hash origLine finalLine [numLines]
    const commitMatch = line.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/);
    if (commitMatch) {
      const [, hash, , finalLineStr] = commitMatch;
      currentCommit = hash;
      currentLine = parseInt(finalLineStr, 10);
      continue;
    }

    // Author
    if (line.startsWith('author ')) {
      currentAuthor = line.substring('author '.length);
      continue;
    }

    // Author email
    if (line.startsWith('author-mail ')) {
      currentAuthorEmail = line.substring('author-mail '.length).replace(/[<>]/g, '');
      continue;
    }

    // Author time
    if (line.startsWith('author-time ')) {
      const timestamp = parseInt(line.substring('author-time '.length), 10);
      currentDate = new Date(timestamp * 1000);
      continue;
    }

    // Summary (commit message)
    if (line.startsWith('summary ')) {
      currentMessage = line.substring('summary '.length);
      continue;
    }

    // Previous commit (+ optional path when -M/-C active).
    //
    // Format: `previous <sha> <path>` — `path` is the file name at the
    // parent commit, which differs from the current path when git detected a
    // rename/move. We capture both so callers can annotate-previous against
    // the correct file.
    if (line.startsWith('previous ')) {
      const rest = line.substring('previous '.length);
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx >= 0) {
        previousCommit = rest.substring(0, spaceIdx);
        previousFilename = rest.substring(spaceIdx + 1);
      } else {
        previousCommit = rest;
        previousFilename = undefined;
      }
      continue;
    }

    // Content line (starts with tab)
    if (line.startsWith('\t')) {
      blameLines.push({
        line: currentLine,
        commit: currentCommit,
        author: currentAuthor,
        authorEmail: currentAuthorEmail,
        date: currentDate || new Date(),
        message: currentMessage,
        previousCommit,
        previousFilename,
      });

      // Reset per-line headers.
      previousCommit = undefined;
      previousFilename = undefined;
    }
  }

  return blameLines;
}

/**
 * Format a log format string for Git.
 * Returns the format string to use with `git log --format`.
 *
 * Wave I — default separator switched to `\x1f` (ASCII Unit Separator)
 * to keep author/committer names with literal `|` round-tripping. Old
 * default of `|` is retained as a legal value for explicit overrides
 * (the parser still accepts it).
 *
 * @param separator - The field separator (default: `\x1f`)
 * @returns The format string
 */
export function getLogFormat(separator: string = '\x1f'): string {
  return `%H${separator}%h${separator}%an${separator}%ae${separator}%aI${separator}%cn${separator}%ce${separator}%cI${separator}%P${separator}%s%n%b`;
}

/**
 * Format a branch format string for Git.
 *
 * @returns The format string
 */
export function getBranchFormat(): string {
  return '%(refname)|%(objectname)|%(upstream:short)|%(HEAD)';
}

/**
 * Format a tag format string for Git.
 *
 * Wave I R1 — default separator switched to `\x1f` (ASCII Unit Separator)
 * to match the `parseTags` post-Wave-I default. The previous `|`
 * collided with tagger names containing literal pipes. Callers that need
 * to keep the legacy `|` separator can pass it explicitly.
 *
 * @param separator - The field separator (default: `\x1f`)
 * @returns The format string
 */
export function getTagFormat(separator: string = '\x1f'): string {
  return `%(refname)${separator}%(*objectname)%(objectname)${separator}%(objecttype)${separator}%(taggername)${separator}%(taggeremail)${separator}%(taggerdate:iso)${separator}%(subject)`;
}

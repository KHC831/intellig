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
} from './interfaces/IGitService';

/**
 * Parse Git status output (porcelain v1 format) into file status objects.
 *
 * Production callers run `git status --porcelain -z`, whose entries are
 * NUL-terminated and whose paths are emitted VERBATIM — so non-ASCII, space,
 * quote, backslash, and even embedded-newline filenames survive intact (the
 * default `core.quotePath=true` newline format C-quotes and double-quotes such
 * names, handing the conflict-resolution flow a path that points at no file).
 *
 * The output is dispatched by shape: any NUL byte means `-z` and is parsed
 * NUL-aware; otherwise the legacy newline/`->` form is parsed (older inputs and
 * test fixtures). A name containing a newline can only be produced under `-z`
 * (which is NUL-delimited), so it never reaches the newline branch.
 *
 * @param output - The output from `git status --porcelain` (`-z` or newline)
 * @returns Array of file status objects
 */
export function parseStatus(output: string): IFileStatus[] {
  return output.includes('\0') ? parseStatusNul(output) : parseStatusNewline(output);
}

/**
 * Parse NUL-delimited `git status --porcelain -z` output. Each ordinary entry
 * is `XY<space>PATH\0`; a rename/copy entry is `XY<space>DEST\0SOURCE\0`, where
 * the SOURCE (renamed-from) path follows the destination as the next NUL token
 * — the reverse of the human-readable `from -> to` order.
 */
function parseStatusNul(output: string): IFileStatus[] {
  const files: IFileStatus[] = [];
  const tokens = output.split('\0');

  let i = 0;
  while (i < tokens.length) {
    const entry = tokens[i];
    // The trailing token after the final NUL (and any stray short token) is not
    // a status record.
    if (entry.length < 3) {
      i += 1;
      continue;
    }

    const indexStatus = entry[0] as StatusCode;
    const workTreeStatus = entry[1] as StatusCode;
    const path = entry.substring(3);

    let renamed: string | undefined;
    if (
      indexStatus === 'R' ||
      indexStatus === 'C' ||
      workTreeStatus === 'R' ||
      workTreeStatus === 'C'
    ) {
      // The renamed-from / copied-from path is the next NUL token.
      renamed = tokens[i + 1];
      i += 2;
    } else {
      i += 1;
    }

    files.push({ path, indexStatus, workTreeStatus, renamed });
  }

  return files;
}

/**
 * Parse legacy newline-delimited `git status --porcelain` output, where a
 * rename/copy entry is `XY old -> new`. Kept for inputs/fixtures that don't use
 * `-z`; unsafe for paths with special characters (see {@link parseStatus}).
 */
function parseStatusNewline(output: string): IFileStatus[] {
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
 * Decide whether a parsed status entry represents a merge conflict.
 *
 * Porcelain v1 marks an unmerged path with `U` in either column, but the
 * both-added (`AA`) and both-deleted (`DD`) states are also unmerged even
 * though neither column is `U`. A `U`-only check silently misses add/add and
 * delete/delete conflicts — a real gap after `git rebase --autostash`, where a
 * stash re-apply that collides on a newly added or deleted path leaves `AA` or
 * `DD` while git still exits 0.
 *
 * @param file - A parsed status entry from {@link parseStatus}
 * @returns True if the entry is an unmerged (conflicted) path
 */
export function isConflictedStatus(file: IFileStatus): boolean {
  return (
    file.indexStatus === 'U' ||
    file.workTreeStatus === 'U' ||
    (file.indexStatus === 'A' && file.workTreeStatus === 'A') ||
    (file.indexStatus === 'D' && file.workTreeStatus === 'D')
  );
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
 * Expects format ({@link getLogFormat}):
 * %H<sep>%h<sep>%an<sep>%ae<sep>%aI<sep>%cn<sep>%ce<sep>%cI<sep>%P<sep>%s<sep>%G?%n%b
 *
 * Separator switched from `|` to `\x1f` (ASCII Unit Separator,
 * RFC 1345). The previous pipe separator collided with author/committer
 * names containing `|` (legitimate in Unicode-name policies, common in
 * imported histories) and silently corrupted every downstream field.
 * `\x1f` is in the C0 control range and never appears in a normalised
 * git ident; a commit SUBJECT is free text and can carry it, which is why
 * the subject is read as the rejoined tail rather than one positional field.
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
    ] = parts;

    // Fields 9..end: `%s` then `%G?` (getLogFormat). The subject is the ONE
    // free-text field on the line and can itself contain the separator, so a
    // positional read truncated it and mis-read a subject fragment as the
    // signature status. The tail between the fixed fields and the last field
    // is the subject — rejoin it. A 10-part line (a caller passing a format
    // without `%G?`) has no status field: the whole tail is the subject.
    const subject =
      parts.length >= 11 ? parts.slice(9, parts.length - 1).join(separator) : parts[9];
    const gpgStatusRaw = parts.length >= 11 ? parts[parts.length - 1] : undefined;

    const body = lines.slice(1).join('\n').trim() || undefined;
    const parents = parentsStr ? parentsStr.split(' ').filter((p) => p.length > 0) : [];
    // %G? emits exactly one ASCII character (G/B/U/X/Y/R/E/N). Trim whitespace
    // defensively; treat empty or missing as undefined rather than a spurious 'N'.
    const gpgStatus = gpgStatusRaw?.trim() || undefined;

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
      gpgStatus,
    });
  }

  return commits;
}

/**
 * Parse a single commit from Git show output.
 *
 * Separator default switched to `\x1f` to match `parseLog`.
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
export function parseBranches(output: string, separator: string = '\x1f'): IBranch[] {
  const branches: IBranch[] = [];
  const lines = output.split('\n').filter((line) => line.trim().length > 0);

  for (const line of lines) {
    // Format: refname<sep>objectname<sep>upstream<sep>HEAD
    const parts = line.split(separator);
    if (parts.length < 4) {
      continue;
    }

    const [refname, commit, upstream, head] = parts;

    // Filter out git's pseudo-refs for detached HEAD / rebase /
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

    // Skip git's HEAD pointers: the bare `HEAD` and the per-remote symref
    // `refs/remotes/<remote>/HEAD` (emitted by `git branch -a` as
    // `origin/HEAD -> origin/main`). Neither is a selectable branch — git4idea
    // strips them too (GitBranchUtil.getBranchNamesAndRemoveHead). Detached
    // HEAD is the parenthesized pseudo-ref filtered above and is surfaced
    // separately as a status label, not as a branch.
    const trimmedRefname = refname.trim();
    if (trimmedRefname === 'HEAD' || /^refs\/remotes\/[^/]+\/HEAD$/.test(trimmedRefname)) {
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
 * Parse `git branch -a --contains <hash> --format=%(refname)` output into the
 * alphabetically-sorted list of branches that contain a commit.
 *
 * Mirrors git4idea `GitBranchUtil.getBranches` (local + remote, sorted): local
 * refs lose the `refs/heads/` prefix, remote refs lose `refs/remotes/` (keeping
 * the `<remote>/<branch>` form used elsewhere in this codebase), the remote
 * `HEAD` symref is dropped (it is an alias, not a branch), and git's
 * parenthesized pseudo-refs (detached/rebase/bisect) are filtered out — the same
 * narrow `^\(.*\)$` guard {@link parseBranches} uses.
 *
 * @param output - stdout of the `git branch … --format=%(refname)` call
 * @returns deduplicated branch names, sorted alphabetically
 */
export function parseContainingBranches(output: string): string[] {
  const names = new Set<string>();

  for (const raw of output.split('\n')) {
    const refname = raw.trim();
    if (refname.length === 0 || /^\(.*\)$/.test(refname)) {
      continue;
    }

    if (refname.startsWith('refs/heads/')) {
      names.add(refname.substring('refs/heads/'.length));
    } else if (refname.startsWith('refs/remotes/')) {
      const remoteName = refname.substring('refs/remotes/'.length);
      // `<remote>/HEAD` is git's per-remote default-branch alias, not a branch.
      if (!remoteName.endsWith('/HEAD')) {
        names.add(remoteName);
      }
    }
  }

  return [...names].sort();
}

/**
 * Parse Git tag output into tag objects.
 *
 * Separator switched from `|` to `\x1f` (ASCII Unit Separator).
 * The previous pipe separator collided with tagger names containing `|`
 * (legitimate in Unicode-name policies, common in imported histories) and
 * silently corrupted every downstream field. `\x1f` is in the C0 control
 * range and never appears in a normalised git ident or tag subject.
 * Mirrors the `parseLog` switch.
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
 * Preferred input is the dated reflog format
 * `git stash list --format=%gd<sep>%ci<sep>%gs` (separator default `\x1f`),
 * which carries the stash's REAL committer date via `%ci` — the bare
 * `git stash list` output has no date, so the previous parser stamped every
 * stash with `new Date()` (the current time), giving misleading timestamps and
 * a wrong date-sort. Lines WITHOUT the separator fall back to the legacy
 * single-line `stash@{N}: WIP on branch: message` parse (date unavailable →
 * current time) so old callers / output still work.
 *
 * @param output - The output from `git stash list` (dated `--format` or legacy)
 * @param separator - The field separator for the dated format (default: `\x1f`)
 * @returns Array of stash objects
 */
export function parseStashList(output: string, separator: string = '\x1f'): IStash[] {
  const stashes: IStash[] = [];
  const lines = output.split('\n').filter((line) => line.trim().length > 0);

  // `%gs` reflog subject: `WIP on branch: message` or `On branch: message`.
  const subjectRe = /^(?:WIP on|On)\s+([^:]+):\s*(.*)$/;

  for (const line of lines) {
    if (line.includes(separator)) {
      // Dated format: `%gd<sep>%ci<sep>%gs[<sep>%H]`. The sha is the optional
      // 4th field (appended for stash re-validation); older 3-field input leaves
      // it undefined.
      const [selector, dateStr, subject = '', hashField] = line.split(separator);
      const indexMatch = selector.match(/stash@\{(\d+)\}/);
      if (!indexMatch) {
        continue;
      }
      const subjectMatch = subject.match(subjectRe);
      const branch = subjectMatch ? subjectMatch[1] : undefined;
      const message = subjectMatch ? subjectMatch[2] : subject;
      const parsedDate = new Date(dateStr);
      const hash = hashField?.trim() ? hashField.trim() : undefined;
      stashes.push({
        index: parseInt(indexMatch[1], 10),
        message: message || (branch ? `WIP on ${branch}` : ''),
        // Fall back to the current time only when %ci is unparseable.
        date: isNaN(parsedDate.getTime()) ? new Date() : parsedDate,
        branch,
        ...(hash ? { hash } : {}),
      });
      continue;
    }

    // Legacy single-line form (no date available).
    const match = line.match(/^stash@\{(\d+)\}:\s*(?:WIP on|On)\s+([^:]+):\s*(.*)$/);
    if (match) {
      const [, indexStr, branch, message] = match;
      stashes.push({
        index: parseInt(indexStr, 10),
        message: message || `WIP on ${branch}`,
        date: new Date(),
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
    // Format: `name\turl (fetch|push)`. The URL can contain spaces (a local
    // path like `/Users/me/My Repos/lib`), so split on the FIRST tab and strip
    // the trailing ` (fetch)`/` (push)` suffix rather than matching `\S+` for
    // the URL (which dropped any space-bearing remote).
    const typeMatch = line.match(/\s+\((fetch|push)\)$/);
    const tab = line.indexOf('\t');
    if (!typeMatch || tab <= 0) {
      continue;
    }
    const type = typeMatch[1];
    const name = line.slice(0, tab);
    const url = line.slice(tab + 1, line.length - typeMatch[0].length).trim();
    if (name.length === 0 || url.length === 0) {
      continue;
    }

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
 * Decode a git C-style-quoted path token back to its real UTF-8 string.
 *
 * The inverse of `StagingOps.escapePatchPath` / git's `quote_c_style`: a token
 * wrapped in double quotes is unescaped byte-wise (`\a \b \t \n \v \f \r \" \\`
 * and octal `\NNN`), then the assembled bytes are decoded as UTF-8 (git escapes
 * every non-ASCII byte as octal, so `é` arrives as `\303\251`). A token without
 * surrounding quotes is returned unchanged.
 */
function unquoteCStylePath(token: string): string {
  if (token.length < 2 || token[0] !== '"' || token[token.length - 1] !== '"') {
    return token;
  }
  const body = token.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    '"': 0x22,
    '\\': 0x5c,
  };

  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      // git escapes every non-ASCII byte, so a literal char here is ASCII.
      bytes.push(body.charCodeAt(i) & 0xff);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      break;
    }
    if (next >= '0' && next <= '7') {
      // Octal byte escape \NNN (1–3 digits).
      let oct = '';
      let k = i + 1;
      while (k < body.length && oct.length < 3 && body[k] >= '0' && body[k] <= '7') {
        oct += body[k];
        k += 1;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      i = k - 1;
      continue;
    }
    bytes.push(next in simple ? simple[next] : next.charCodeAt(0) & 0xff);
    i += 1;
  }

  return Buffer.from(bytes).toString('utf8');
}

/**
 * Read one path token from a `diff --git` header at `start`: a C-quoted
 * `"…"` token (honoring `\"` escapes) which is unquoted, or a bare token. A
 * bare token that is NOT the final token ends at the next ` b/` / ` "b/`
 * boundary (mirroring the legacy greedy match for the all-bare case); the final
 * token runs to the end.
 */
function readDiffPathToken(
  rest: string,
  start: number,
  isFinal: boolean
): { value: string; next: number } | undefined {
  if (rest[start] === '"') {
    let j = start + 1;
    while (j < rest.length && rest[j] !== '"') {
      j += rest[j] === '\\' ? 2 : 1;
    }
    if (j >= rest.length || rest[j] !== '"') {
      return undefined;
    }
    return { value: unquoteCStylePath(rest.slice(start, j + 1)), next: j + 1 };
  }
  if (isFinal) {
    return { value: rest.slice(start), next: rest.length };
  }
  const bareB = rest.indexOf(' b/', start);
  const quotedB = rest.indexOf(' "b/', start);
  let end = -1;
  if (bareB >= 0 && quotedB >= 0) {
    end = Math.min(bareB, quotedB);
  } else {
    end = Math.max(bareB, quotedB);
  }
  if (end < 0) {
    return undefined;
  }
  return { value: rest.slice(start, end), next: end };
}

/**
 * Extract the `oldPath`/`newPath` from a `diff --git <a> <b>` header, handling
 * bare AND C-quoted path tokens (each side independently). Returns the paths
 * with their `a/`|`b/` prefix stripped, or `undefined` when the header doesn't
 * parse.
 */
function parseDiffGitHeaderPaths(header: string): { oldPath: string; newPath: string } | undefined {
  // All-bare fast path — unchanged from the original greedy match, so plain
  // ASCII paths (incl. spaces) keep their exact prior behavior.
  const bare = /^--git a\/(.+)\s+b\/(.+)$/.exec(header);
  if (bare) {
    return { oldPath: bare[1], newPath: bare[2] };
  }

  // At least one side is C-quoted — tokenize the two paths independently.
  const rest = header.slice('--git '.length);
  const first = readDiffPathToken(rest, 0, false);
  if (!first || rest[first.next] !== ' ') {
    return undefined;
  }
  const second = readDiffPathToken(rest, first.next + 1, true);
  if (!second) {
    return undefined;
  }

  const stripPrefix = (token: string, prefix: 'a/' | 'b/'): string | undefined =>
    token.startsWith(prefix) ? token.slice(prefix.length) : undefined;

  const oldPath = stripPrefix(first.value, 'a/');
  const newPath = stripPrefix(second.value, 'b/');
  if (oldPath === undefined || newPath === undefined) {
    return undefined;
  }
  return { oldPath, newPath };
}

/**
 * Parse unified diff output into diff objects.
 *
 * Handles BOTH standard two-parent-free diffs and the combined-diff format
 * git emits for merge commits:
 *
 * - Regular: blocks begin `diff --git a/<old> b/<new>` and carry `@@` hunks.
 * - Combined (`git show <merge>`): blocks begin `diff --cc <path>` (or
 *   `diff --combined <path>`) with no `a/`…`b/` prefixes and `@@@` hunk
 *   headers carrying N+1 prefix columns for an N-parent merge.
 *
 * Before this handled combined diffs, `output.split(/^diff --git /m)` returned
 * the whole combined block as one unsplittable chunk whose first line
 * (`diff --cc <path>`) failed the `a/…b/…` path match — so merge commits
 * surfaced as "No changed files" in the details panel even though they had
 * real content. For combined blocks we extract the path, mark the file
 * `'modified'` (the correct semantic answer for a conflict-resolved file),
 * and skip per-line hunk parsing — the Changed Files list only reads
 * `path` / `status` / `oldPath`. Per-line merge diffs are a follow-up.
 *
 * @param output - The unified diff output
 * @returns Array of diff objects
 */
export function parseDiff(output: string): IDiff[] {
  const diffs: IDiff[] = [];
  // Split on either header form. Each block retains its own leading marker
  // (`--git …` or `--cc …` / `--combined …`) because we strip the literal
  // `diff ` prefix only, letting each block self-identify.
  const diffBlocks = output
    .split(/^diff /m)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  for (const block of diffBlocks) {
    const lines = block.split('\n');
    if (lines.length === 0) {
      continue;
    }

    const header = lines[0];

    // Combined-diff block (merge commit): `--cc <path>` or `--combined <path>`.
    if (header.startsWith('--cc ') || header.startsWith('--combined ')) {
      const combined = parseCombinedDiffHeader(header, lines);
      if (combined) {
        diffs.push(combined);
      }
      continue;
    }

    // Regular block: `--git a/<old> b/<new>`.
    if (!header.startsWith('--git ')) {
      continue;
    }

    // Parse the file paths from the header. git C-quotes (double-quotes +
    // octal byte escapes) a path with non-ASCII / control / quote / backslash
    // bytes, so the bare `a/… b/…` form covers only plain paths; quoted forms
    // must be unquoted, or the file is mis-read or dropped from the diff.
    const headerPaths = parseDiffGitHeaderPaths(header);
    if (!headerPaths) {
      continue;
    }

    const { oldPath, newPath } = headerPaths;
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
 * Extract a diff object from a combined-diff (`diff --cc` / `diff --combined`)
 * block emitted by `git show` on a merge commit.
 *
 * Combined diffs have no `a/`…`b/` path distinction and do not emit
 * `new file mode` / `deleted file mode` / `rename from` lines the way regular
 * diffs do, so the file is always reported as `'modified'` — the correct
 * semantic answer for any file that participated in a merge/conflict
 * resolution, and all the Changed Files panel needs. Per-line hunk parsing is
 * skipped (`hunks: []`) because the `@@@` multi-column format isn't modelled
 * by `parseHunks`; the file-list view never reads it.
 *
 * @param header - The block's first line, with the leading `diff ` stripped
 *   (e.g. `--cc src/foo.ts`).
 * @param lines - All lines of the block (header included).
 * @returns A diff object, or `undefined` when the path can't be extracted.
 */
function parseCombinedDiffHeader(header: string, lines: string[]): IDiff | undefined {
  const path = header.replace(/^--(?:cc|combined)\s+/, '').trim();
  if (path.length === 0) {
    return undefined;
  }

  // Detect a binary combined diff defensively — git can still print the
  // "Binary files … differ" sentinel for binary content in a merge.
  const binary = lines.some((line) => line.includes('Binary files'));

  return {
    path,
    oldPath: undefined,
    status: 'modified',
    hunks: [],
    binary,
  };
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
  // Running per-side line numbers (seeded from the hunk header) and the
  // remaining body budget. Selections key adds by newLineNumber and deletes
  // by oldLineNumber, and the dialog renders a line's checkbox only when its
  // number is defined — so every body line must carry its number(s). The
  // budget bounds consumption to exactly the counted body, so a trailing
  // `split('\n')` artifact (or any junk between hunks) can't be swallowed
  // as a phantom context line.
  let oldLine = 0;
  let newLine = 0;
  let remainingOld = 0;
  let remainingNew = 0;

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
      oldLine = currentHunk.oldStart;
      newLine = currentHunk.newStart;
      remainingOld = currentHunk.oldLines;
      remainingNew = currentHunk.newLines;

      continue;
    }

    // Parse diff lines within a hunk
    if (currentHunk) {
      // `\ No newline at end of file` applies to the line just emitted: its
      // side has no trailing newline. Flag the preceding line so a rebuilt
      // patch re-emits the marker (git apply rejects a patch that drops it).
      // It is not part of the counted body, so it is handled before the
      // budget check.
      if (line.startsWith('\\')) {
        const prev = currentHunk.lines[currentHunk.lines.length - 1];
        if (prev) {
          prev.noNewline = true;
        }
        continue;
      }

      if (remainingOld <= 0 && remainingNew <= 0) {
        // The counted body is complete — whatever follows is not hunk content.
        continue;
      }

      if (line.startsWith('+')) {
        currentHunk.lines.push({ type: 'add', content: line.substring(1), newLineNumber: newLine });
        newLine++;
        remainingNew--;
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({
          type: 'delete',
          content: line.substring(1),
          oldLineNumber: oldLine,
        });
        oldLine++;
        remainingOld--;
      } else if (line.startsWith(' ') || line === '') {
        currentHunk.lines.push({
          type: 'context',
          content: line.substring(1),
          oldLineNumber: oldLine,
          newLineNumber: newLine,
        });
        oldLine++;
        newLine++;
        remainingOld--;
        remainingNew--;
      }
      // Any other non-diff line is skipped.
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

  // Per-commit metadata cache. `git blame --porcelain` emits a commit's
  // author/author-time/summary/previous header block ONLY on that commit's
  // FIRST appearance in the stream; later, non-contiguous occurrences of the
  // same commit carry just the `<sha> <orig> <final>` line + the content line,
  // because git expects the consumer to have cached the metadata by sha.
  // Keying on the sha (rather than tracking flat running variables) is what
  // keeps every repeat line attributed to its OWN commit instead of whichever
  // header block was seen most recently.
  interface ICommitMeta {
    author: string;
    authorEmail: string;
    date?: Date;
    message: string;
    // Emitted by git blame's `previous <sha> <path>` header when -M/-C detect
    // that the line was in a different file at the parent commit.
    previousCommit?: string;
    previousFilename?: string;
  }
  const commitMeta = new Map<string, ICommitMeta>();

  let currentCommit = '';
  let currentLine = 0;

  // The header lines that follow a commit line populate THAT commit's entry.
  const meta = (): ICommitMeta => {
    let m = commitMeta.get(currentCommit);
    if (!m) {
      m = { author: '', authorEmail: '', message: '' };
      commitMeta.set(currentCommit, m);
    }
    return m;
  };

  for (const line of lines) {
    // Commit line: hash origLine finalLine [numLines]
    // 40-hex (SHA-1) or 64-hex (SHA-256) object id.
    const commitMatch = line.match(
      /^([0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?)\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/
    );
    if (commitMatch) {
      const [, hash, , finalLineStr] = commitMatch;
      currentCommit = hash;
      currentLine = parseInt(finalLineStr, 10);
      continue;
    }

    // Author
    if (line.startsWith('author ')) {
      meta().author = line.substring('author '.length);
      continue;
    }

    // Author email
    if (line.startsWith('author-mail ')) {
      meta().authorEmail = line.substring('author-mail '.length).replace(/[<>]/g, '');
      continue;
    }

    // Author time
    if (line.startsWith('author-time ')) {
      const timestamp = parseInt(line.substring('author-time '.length), 10);
      meta().date = new Date(timestamp * 1000);
      continue;
    }

    // Summary (commit message)
    if (line.startsWith('summary ')) {
      meta().message = line.substring('summary '.length);
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
      const m = meta();
      if (spaceIdx >= 0) {
        m.previousCommit = rest.substring(0, spaceIdx);
        m.previousFilename = rest.substring(spaceIdx + 1);
      } else {
        m.previousCommit = rest;
        m.previousFilename = undefined;
      }
      continue;
    }

    // Content line (starts with tab)
    if (line.startsWith('\t')) {
      const m = meta();
      blameLines.push({
        line: currentLine,
        commit: currentCommit,
        author: m.author,
        authorEmail: m.authorEmail,
        date: m.date || new Date(),
        message: m.message,
        previousCommit: m.previousCommit,
        previousFilename: m.previousFilename,
      });
    }
  }

  return blameLines;
}

/**
 * Format a log format string for Git.
 * Returns the format string to use with `git log --format`.
 *
 * Default separator switched to `\x1f` (ASCII Unit Separator)
 * to keep author/committer names with literal `|` round-tripping. Old
 * default of `|` is retained as a legal value for explicit overrides
 * (the parser still accepts it).
 *
 * Field order (0-indexed):
 *   0  %H   full hash
 *   1  %h   short hash
 *   2  %an  author name
 *   3  %ae  author email
 *   4  %aI  author date (ISO-8601)
 *   5  %cn  committer name
 *   6  %ce  committer email
 *   7  %cI  commit date (ISO-8601)
 *   8  %P   parent hashes (space-separated)
 *   9  %s   subject (first commit-message line)
 *   10 %G?  GPG/SSH signature status character (G5)
 * Body lines follow the first \n after field 10 (via `%n%b`).
 *
 * @param separator - The field separator (default: `\x1f`)
 * @returns The format string
 */
export function getLogFormat(separator: string = '\x1f'): string {
  return `%H${separator}%h${separator}%an${separator}%ae${separator}%aI${separator}%cn${separator}%ce${separator}%cI${separator}%P${separator}%s${separator}%G?%n%b`;
}

/**
 * Format a branch format string for Git.
 *
 * Default separator is `\x1f` (ASCII Unit Separator) to match `parseLog` /
 * `parseTags`. The previous `|` collided with branch names containing a literal
 * pipe — `git check-ref-format 'refs/heads/foo|bar'` exits 0, so `foo|bar` is a
 * valid branch — which corrupted `parseBranches`' field split (refname truncated,
 * commit hash shifted). `\x1f` is a C0 control char that never appears in a ref
 * name. Callers needing the legacy `|` can pass it explicitly.
 *
 * @param separator - The field separator (default: `\x1f`)
 * @returns The format string
 */
export function getBranchFormat(separator: string = '\x1f'): string {
  return `%(refname)${separator}%(objectname)${separator}%(upstream:short)${separator}%(HEAD)`;
}

/**
 * Format a tag format string for Git.
 *
 * Default separator switched to `\x1f` (ASCII Unit Separator)
 * to match the `parseTags` default. The previous `|`
 * collided with tagger names containing literal pipes. Callers that need
 * to keep the legacy `|` separator can pass it explicitly.
 *
 * @param separator - The field separator (default: `\x1f`)
 * @returns The format string
 */
export function getTagFormat(separator: string = '\x1f'): string {
  // The commit field must resolve to the COMMIT a tag points at. For an
  // annotated tag git fills BOTH %(objectname) (the tag-object SHA) and
  // %(*objectname) (the dereferenced commit SHA); for a lightweight tag
  // only %(objectname) is set. Writing them adjacently
  // (`%(*objectname)%(objectname)`) concatenated the two SHAs for
  // annotated tags into an 80-char string that never matched any real
  // commit hash, so annotated-tag chips silently vanished from the log.
  // Use git's conditional deref-with-fallback: emit the dereferenced
  // commit SHA when present, else the object SHA — both kinds yield the
  // 40-char commit hash.
  const commitField = '%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)';
  return `%(refname)${separator}${commitField}${separator}%(objecttype)${separator}%(taggername)${separator}%(taggeremail)${separator}%(taggerdate:iso)${separator}%(subject)`;
}

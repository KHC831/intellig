/**
 * English-prose classification of git output — the ONE home for every
 * predicate that matches git's human-facing message text.
 *
 * git localizes these messages, so prose matching is safe ONLY because
 * GitCli pins the message locale on every spawn (`LC_ALL=en_US.UTF-8` +
 * `LANGUAGE=""` in `_spawnOnce`; git4idea parity — GitHandler.java:527 →
 * VcsLocaleHelper.kt createEnvForLocale). Centralising the predicates keeps
 * that locale contract visible in one place: `check:git-prose-matching`
 * fails any `.includes(`/`.test(`/`.match(` against git prose elsewhere
 * (escape hatch: `// git-prose-exempt: <reason>`).
 *
 * Structural signals stay preferred where git offers them — porcelain
 * status codes (gitParser), `.git/` marker files (gitDirMarkers), exit
 * codes. A prose predicate is for classifying ERROR TEXT that has no
 * structural channel.
 */

/**
 * Does this apply-family error text (stash/shelf/merge/checkout) look like
 * a merge conflict? `conflict` already matches `CONFLICT (content)`,
 * `Merge conflict in …`, and `…with conflicts`; `needs merge` is the
 * unmerged-entry phrasing.
 */
export function looksLikeConflictText(text: string): boolean {
  return /conflict|needs merge/i.test(text);
}

/**
 * Patch-application (git apply / am) conflicts: the shared conflict
 * phrases plus apply-specific failure prose. Deliberately narrow beyond
 * that — unmerged files are detected authoritatively from `git status`
 * (`U` codes); this heuristic only gates whether that read happens at all.
 */
export function looksLikePatchConflictText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    looksLikeConflictText(lower) ||
    lower.includes('patch does not apply') ||
    lower.includes('patch failed')
  );
}

/**
 * git refused an operation because TRACKED local changes would be
 * clobbered ("Your local changes to the following files would be
 * overwritten by …" / "Please commit your changes or stash them…") — the
 * trigger for the Stash & Switch / Force / Cancel smart-checkout offer.
 * Note this also matches the UNTRACKED-overwrite refusal; callers that
 * must fatal on that arm run {@link parseUntrackedOverwriteFiles} FIRST.
 */
export function isLocalChangesWouldBeOverwritten(text: string): boolean {
  return text.includes('would be overwritten') || text.includes('Please commit your changes');
}

/**
 * git refused `stash apply/pop --index` because the index state cannot be
 * restored ("conflicts in index. Try without --index."). The reference
 * treats this arm as manual-only — a dedicated error notification, never
 * the merge dialog (GitSimpleEventDetector.Event.INDEX_CONFLICT_ON_UNSTASH
 * = "conflicts in index"; GitStashUtils.unstash). Check BEFORE the generic
 * conflict predicate: the message contains "conflicts" and would otherwise
 * classify as a mergeable conflict.
 */
export function isIndexConflictOnUnstash(text: string): boolean {
  return text.toLowerCase().includes('conflicts in index');
}

/**
 * Detect git's "Your local changes to the following files would be
 * overwritten" refusal and extract the blocked TRACKED files. Returns
 * `null` when the message is not that error — including the untracked
 * form, which {@link parseUntrackedOverwriteFiles} owns (callers run that
 * one first, mirroring the reference's detector order).
 *
 * Mirrors git4idea's GitLocalChangesWouldBeOverwrittenDetector: the modern
 * form is a header line followed by indented file lines up to the
 * "Please commit your changes or stash them" hint; the legacy form names a
 * single file inline.
 */
export function parseLocalChangesOverwriteFiles(message: string): string[] | null {
  const lines = message.split('\n');
  const headerIdx = lines.findIndex((l) =>
    /your local changes to the following files would be overwritten by/i.test(l)
  );
  if (headerIdx >= 0) {
    const files: string[] = [];
    for (const line of lines.slice(headerIdx + 1)) {
      if (/^\s*please commit your changes or stash them/i.test(line)) {
        break;
      }
      const file = line.trim();
      if (file.length > 0 && !/^aborting/i.test(file)) {
        files.push(file);
      }
    }
    return files;
  }
  const legacy = message.match(/your local changes to '(.*)' would be overwritten by/i);
  if (legacy) {
    return [legacy[1]];
  }
  return null;
}

/**
 * git's error when a `reset` (esp. `--keep`/`--merge`) would clobber
 * uncommitted work — the trigger for IntelliJ's Smart Reset proposal
 * (GitResetOperation.proposeSmartReset).
 */
export function isLocalChangesOverwriteError(message: string): boolean {
  return /local changes.*would be overwritten|would be overwritten by (?:checkout|merge|reset)/i.test(
    message
  );
}

/**
 * Detect git's "untracked working tree files would be overwritten" refusal
 * and extract the blocked files. Returns `null` when the message is not that
 * error (including the TRACKED "Your local changes …" form, which keeps the
 * smart-checkout offer).
 *
 * Mirrors git4idea's GitUntrackedFilesOverwrittenByOperationDetector: the
 * modern form is a header line followed by tab-indented file lines up to the
 * "Please move or remove them" hint; the legacy form names a single file
 * inline. The reference treats this arm as FATAL (file list, no smart
 * checkout — GitCheckoutOperation.java:187-190): a stash without
 * `--include-untracked` cannot move untracked files, so a stash-and-retry
 * would fail on exactly the same files.
 */
export function parseUntrackedOverwriteFiles(message: string): string[] | null {
  const lines = message.split('\n');
  const headerIdx = lines.findIndex((l) =>
    /untracked working tree files would be overwritten by/i.test(l)
  );
  if (headerIdx >= 0) {
    const files: string[] = [];
    for (const line of lines.slice(headerIdx + 1)) {
      if (/^\s*please move or remove them/i.test(line)) {
        break;
      }
      const file = line.trim();
      if (file.length > 0) {
        files.push(file);
      }
    }
    return files;
  }
  const legacy = message.match(/untracked working tree file '(.*)' would be overwritten by/i);
  if (legacy) {
    return [legacy[1]];
  }
  return null;
}

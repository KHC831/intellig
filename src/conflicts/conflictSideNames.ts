/**
 * Resolve a human-readable name for each SIDE of a conflict — the "Yours" side
 * (the user's own work) and the "Theirs" side (the incoming change) — so the
 * Resolve Conflicts UI can say "Accept from main" / "Accept from feature"
 * instead of the abstract "Accept Yours" / "Accept Theirs".
 *
 * Names are derived per GIT STAGE (stage 2 = ours, stage 3 = theirs) and then
 * mapped to the user-facing yours/theirs sides through the SINGLE reversal
 * source of truth, {@link isReversedOperation} — the same predicate that decides
 * which stage `acceptCurrent`/`acceptIncoming` check out. Deriving the name and
 * the accept side from one predicate guarantees the button labelled "Accept from
 * X" actually takes X's content (a rebase/stash swaps the stages; a patch does
 * not — getting this wrong silently discards the named side).
 *
 * A side whose ref name cannot be resolved is left `undefined`; the caller then
 * shows the generic "Accept Yours"/"Accept Theirs" for that side rather than an
 * ungrammatical "Accept from your changes".
 *
 * Pure except for the injected git callbacks and the `.git/` marker files it
 * reads (via the shared {@link tryReadGitFile} helpers).
 */

import * as path from 'path';
import { IConflictOpContext } from './interfaces/IConflictResolutionService';
import { isReversedOperation } from './conflictReversal';
import {
  ShortenSha,
  tryReadGitFile,
  stripRefsHeads,
  firstShaToken,
  abbreviateSha,
  readAbbreviatedShaMarker,
  readRebaseMarker,
} from '../git-core/gitDirMarkers';

export type { ShortenSha } from '../git-core/gitDirMarkers';
/** Best-effort symbolic name for a commit (wired to `git name-rev`). Returns undefined on failure. */
export type NameRev = (sha: string) => Promise<string | undefined>;

/**
 * Display names for the two sides of a conflict. A side is `undefined` when no
 * ref name resolves — the caller falls back to the generic "Accept Yours/Theirs".
 */
export interface IConflictSideNames {
  /** The user's own side — "Accept from {yours}". */
  yours?: string;
  /** The incoming side — "Accept from {theirs}". */
  theirs?: string;
}

/** Best-effort names for the raw git stages: stage 2 (ours) and stage 3 (theirs). */
export interface IStageNames {
  ours?: string;
  theirs?: string;
}

/**
 * Map the two git stages onto the user-facing yours/theirs sides. Generic so
 * one reversal decision can carry names AND contents together — a caller that
 * evaluates {@link isReversedOperation} once and routes everything through this
 * cannot label one side while showing the other's data.
 */
export function orderStagesByUserSide<T>(
  reversed: boolean,
  stage2: T,
  stage3: T
): { yours: T; theirs: T } {
  return reversed ? { yours: stage3, theirs: stage2 } : { yours: stage2, theirs: stage3 };
}

/**
 * Disambiguate identical side names — e.g. a `git pull` of a same-named branch
 * ("Merge branch 'main' of … into main") would otherwise show two "Accept
 * from main" buttons with no way to tell local from incoming.
 */
export function disambiguateSideNames(names: IConflictSideNames): IConflictSideNames {
  if (names.yours !== undefined && names.yours === names.theirs) {
    return { yours: `${names.yours} (current)`, theirs: `${names.theirs} (incoming)` };
  }
  return names;
}

/**
 * Button label + confirm-sentence subject for accepting one side. Uses the
 * resolved ref name ("Accept from main" / "the changes from main") when present,
 * else the generic Yours/Theirs wording. One home for the rule the dialog buttons
 * and the palette confirms both render.
 */
export function acceptLabels(
  name: string | undefined,
  side: 'yours' | 'theirs'
): { button: string; subject: string } {
  if (name) {
    return { button: `Accept from ${name}`, subject: `the changes from ${name}` };
  }
  return side === 'yours'
    ? { button: 'Accept Yours', subject: 'your changes' }
    : { button: 'Accept Theirs', subject: 'the incoming changes' };
}

/**
 * Resolve the two side names for an in-progress conflict.
 *
 * @param gitDir - Absolute path to the repo's resolved `.git/` directory.
 * @param operation - The operation that produced the conflict.
 * @param currentBranch - The checked-out branch name (`repo.head?.name`), or
 *   undefined when detached / unknown.
 * @param shortenSha - Abbreviates a SHA; used for the SHA fallback rung.
 * @param nameRev - Best-effort branch/tag name for a SHA (rebase `onto`).
 */
export async function resolveConflictSideNames(
  gitDir: string,
  operation: IConflictOpContext['operation'],
  currentBranch: string | undefined,
  shortenSha: ShortenSha,
  nameRev: NameRev
): Promise<IConflictSideNames> {
  const stageNames = await resolveConflictStageNames(
    gitDir,
    operation,
    currentBranch,
    shortenSha,
    nameRev
  );

  // Map git stages → user sides through the one reversal predicate.
  const reversed = isReversedOperation(operation);
  return disambiguateSideNames(orderStagesByUserSide(reversed, stageNames.ours, stageNames.theirs));
}

/**
 * Names for the raw git stages of an in-progress conflict: stage 2 (ours) and
 * stage 3 (theirs); undefined where no ref resolves. Callers that also load
 * stage CONTENTS pair these per stage and run one reversal mapping over both
 * (see the merge window's assignMergePanes).
 */
export async function resolveConflictStageNames(
  gitDir: string,
  operation: IConflictOpContext['operation'],
  currentBranch: string | undefined,
  shortenSha: ShortenSha,
  nameRev: NameRev
): Promise<IStageNames> {
  const current = currentBranch?.trim() || (await detachedHeadName(gitDir, shortenSha));
  return resolveStageNames(gitDir, operation, current, shortenSha, nameRev);
}

/** Names for stage 2 (ours) and stage 3 (theirs); undefined where no ref resolves. */
async function resolveStageNames(
  gitDir: string,
  operation: IConflictOpContext['operation'],
  current: string | undefined,
  shortenSha: ShortenSha,
  nameRev: NameRev
): Promise<{ ours?: string; theirs?: string }> {
  switch (operation) {
    case 'merge':
      return { ours: current, theirs: await mergeSourceName(gitDir, shortenSha) };
    case 'rebase':
      // stage 2 = the branch being rebased onto; stage 3 = the replayed branch.
      return {
        ours: await rebaseOntoName(gitDir, shortenSha, nameRev),
        theirs: await rebaseHeadName(gitDir),
      };
    case 'cherryPick':
      return {
        ours: current,
        theirs: await readAbbreviatedShaMarker(path.join(gitDir, 'CHERRY_PICK_HEAD'), shortenSha),
      };
    case 'revert':
      return {
        ours: current,
        theirs: await readAbbreviatedShaMarker(path.join(gitDir, 'REVERT_HEAD'), shortenSha),
      };
    case 'unstash':
    case 'unshelve':
      // stage 3 (the stashed/shelved work) has no ref name → undefined ⇒ the
      // caller shows "Accept Yours"; stage 2 is the branch it sat on.
      return { ours: current, theirs: undefined };
    case 'applyPatch':
      // `git apply --3way`: stage 2 = current tree, stage 3 = the patched result.
      return { ours: current, theirs: 'the patch' };
  }
}

/** `.git/HEAD` detached SHA, abbreviated — the name shown when no branch is checked out. */
async function detachedHeadName(
  gitDir: string,
  shortenSha: ShortenSha
): Promise<string | undefined> {
  const raw = await tryReadGitFile(path.join(gitDir, 'HEAD'));
  if (raw === undefined || raw.trim().startsWith('ref:')) {
    // A symbolic ref means we're on a branch; the caller already had its name.
    return undefined;
  }
  const sha = firstShaToken(raw);
  return sha ? abbreviateSha(sha, shortenSha) : undefined;
}

/**
 * Parse `.git/MERGE_MSG` for the merged-in ref. Trust ONLY git's own generated
 * header — `Merge branch 'x'`, `Merge remote-tracking branch 'origin/x'`,
 * `Merge tag 'v1' into main`, `Merge branches 'a' and 'b'` — by requiring the
 * `Merge … <kind> '…'` shape, so a custom `-m` message with stray apostrophes
 * ("Don't merge 'wip'") is not misparsed. Falls back to MERGE_HEAD's short SHA.
 */
async function mergeSourceName(
  gitDir: string,
  shortenSha: ShortenSha
): Promise<string | undefined> {
  const msg = await tryReadGitFile(path.join(gitDir, 'MERGE_MSG'));
  if (msg !== undefined) {
    const firstLine = msg.split(/\r\n|\r|\n/, 1)[0] ?? '';
    const m = firstLine.match(/^Merge\b.*?\b(?:branch|branches|tag|commit) '([^']+)'/);
    if (m?.[1]) {
      return m[1];
    }
  }
  return readAbbreviatedShaMarker(path.join(gitDir, 'MERGE_HEAD'), shortenSha);
}

/** The branch being rebased (`rebase-merge/head-name` or `rebase-apply/head-name`). */
async function rebaseHeadName(gitDir: string): Promise<string | undefined> {
  return stripRefsHeads(await readRebaseMarker(gitDir, 'head-name'));
}

/** The rebase `onto` target: a friendly name (name-rev) if resolvable, else its short SHA. */
async function rebaseOntoName(
  gitDir: string,
  shortenSha: ShortenSha,
  nameRev: NameRev
): Promise<string | undefined> {
  const sha = firstShaToken(await readRebaseMarker(gitDir, 'onto'));
  if (!sha) {
    return undefined;
  }
  return (await nameRev(sha)) ?? abbreviateSha(sha, shortenSha);
}

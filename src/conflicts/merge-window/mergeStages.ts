// Loads the three index-stage contents of a conflicted path for the merge
// window: stage 1 = base, 2 = ours, 3 = theirs. Per IntelliJ's
// GitMergeUtil.loadMergeData: a missing SIDE stage (delete/modify) reads as
// empty content, while a missing BASE (add/add) falls back to the
// conflict-marked working-tree file — in memory, never by writing a synthetic
// stage into the index.

import * as fs from 'fs/promises';
import * as path from 'path';
import { GitCli } from '../../git-core/gitCli';
import { readUnmergedStages, IStageBlob } from '../conflictStageModel';
import { IConflictOpContext } from '../interfaces/IConflictResolutionService';
import { isReversedOperation } from '../conflictReversal';
import { orderStagesByUserSide, disambiguateSideNames, IStageNames } from '../conflictSideNames';

export interface IMergeStageContents {
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
  /**
   * Blob SHA per stage ('' when the stage is absent). Identifies WHICH
   * conflict these contents came from, so a consumer can tell a later,
   * unrelated conflict on the same path apart from this one.
   */
  readonly stageShas: { readonly base: string; readonly ours: string; readonly theirs: string };
}

/**
 * The stage SHAs as one comparable string. Two conflicts on the same path
 * share an identity only when they are the same conflict, so callers that
 * cache or restore per path use this to tell them apart.
 */
export function stageIdentityOf(stageShas: IMergeStageContents['stageShas']): string {
  return `${stageShas.base}:${stageShas.ours}:${stageShas.theirs}`;
}

/**
 * Outcome of reading a path's stage identity. "No longer conflicted" and "the
 * index could not be read" are DIFFERENT facts and callers act on them
 * differently: the first says an open window is stale, the second says nothing
 * at all. Collapsing them to `undefined` made a resolved path look unreadable.
 */
export type StageIdentityRead =
  | { readonly kind: 'identity'; readonly identity: string }
  | { readonly kind: 'notConflicted' }
  | { readonly kind: 'unreadable' };

/**
 * The stage identity of a conflicted path, read from the index alone (no blob
 * contents).
 */
export async function readStageIdentity(
  gitCli: GitCli,
  repoRoot: string,
  relPath: string
): Promise<StageIdentityRead> {
  let entry;
  try {
    entry = (await readUnmergedStages(gitCli, repoRoot, relPath)).get(relPath);
    // eslint-disable-next-line no-restricted-syntax -- an unreadable index is reported as its own outcome; the caller decides, because it cannot be distinguished from "resolved" here.
  } catch {
    return { kind: 'unreadable' };
  }
  return entry
    ? {
        kind: 'identity',
        identity: stageIdentityOf({
          base: entry.stage1?.sha ?? '',
          ours: entry.stage2?.sha ?? '',
          theirs: entry.stage3?.sha ?? '',
        }),
      }
    : { kind: 'notConflicted' };
}

export async function loadMergeStageContents(
  gitCli: GitCli,
  repoRoot: string,
  relPath: string
): Promise<IMergeStageContents | undefined> {
  const stages = await readUnmergedStages(gitCli, repoRoot, relPath);
  const entry = stages.get(relPath);
  if (!entry) {
    return undefined;
  }

  const readBlob = async (blob: IStageBlob | undefined): Promise<string> => {
    if (!blob) {
      return '';
    }
    const result = await gitCli.exec(['cat-file', 'blob', blob.sha], {
      cwd: repoRoot,
      throwOnError: false,
    });
    if (result.exitCode !== 0) {
      throw new Error(`cannot read stage blob ${blob.sha}: ${result.stderr}`);
    }
    return result.stdout;
  };

  const readBase = async (): Promise<string> => {
    if (entry.stage1) {
      return readBlob(entry.stage1);
    }
    try {
      return await fs.readFile(path.join(repoRoot, relPath), 'utf8');
      // eslint-disable-next-line no-restricted-syntax -- best-effort fallback: an unreadable working file (deleted, permissions) degrades to an empty base, like IntelliJ's notNullize.
    } catch {
      return '';
    }
  };

  const [base, ours, theirs] = await Promise.all([
    readBase(),
    readBlob(entry.stage2),
    readBlob(entry.stage3),
  ]);
  return {
    base,
    ours,
    theirs,
    stageShas: {
      base: entry.stage1?.sha ?? '',
      ours: entry.stage2?.sha ?? '',
      theirs: entry.stage3?.sha ?? '',
    },
  };
}

/** One side pane of the merge window: what it shows and what it is titled. */
export interface IMergePane {
  readonly content: string;
  readonly label: string;
}

/** The three merge-window panes with contents and labels already side-mapped. */
export interface IMergePaneAssignment {
  readonly left: IMergePane;
  readonly right: IMergePane;
  readonly base: string;
}

/**
 * Map the loaded git stages onto the merge window's panes: left = Yours,
 * right = Theirs. Content and name travel PAIRED per stage through one
 * {@link orderStagesByUserSide} call over one {@link isReversedOperation}
 * decision, so a reversed operation (rebase/unstash/unshelve — where git
 * swaps ours/theirs, per IntelliJ's GitMergeUtil.loadMergeData isReversed
 * handling) can never label a pane with one stage while showing the other's
 * content.
 */
export function assignMergePanes(
  stages: IMergeStageContents,
  stageNames: IStageNames,
  operation: IConflictOpContext['operation'] | undefined
): IMergePaneAssignment {
  const { yours, theirs } = orderStagesByUserSide(
    isReversedOperation(operation),
    { content: stages.ours, name: stageNames.ours },
    { content: stages.theirs, name: stageNames.theirs }
  );
  const names = disambiguateSideNames({ yours: yours.name, theirs: theirs.name });
  return {
    left: { content: yours.content, label: names.yours ? `Yours (${names.yours})` : 'Yours' },
    right: {
      content: theirs.content,
      label: names.theirs ? `Theirs (${names.theirs})` : 'Theirs',
    },
    base: stages.base,
  };
}

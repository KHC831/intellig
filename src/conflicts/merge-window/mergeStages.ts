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

export interface IMergeStageContents {
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
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
  return { base, ours, theirs };
}

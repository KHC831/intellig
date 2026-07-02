/**
 * `intellig.merge.markResolved` must stage the file the user is ACTUALLY
 * looking at — not whichever conflict file was opened last.
 *
 * MergeView previously kept a single `_lastFile`/`_repository` pair,
 * overwritten by every `show()`. With two merge editors open (dialog →
 * "Merge…" on a.ts, then on b.ts), finishing a.ts and running markResolved
 * staged b.ts instead: the wrong row flipped to resolved and a file still
 * full of conflict markers became stageable/committable. The view now tracks
 * every shown file and resolves the target from the active editor, falling
 * back to the sole outstanding file (the old single-file behavior).
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { okAsync } from 'neverthrow';
import { MergeView } from '../../../src/conflicts/MergeView';
import { GitError } from '../../../src/git-core/errors';
import { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';

const ROOT = '/repo';

function makeRepo(): IRepository {
  return {
    rootUri: vscode.Uri.file(ROOT),
    state: 'idle',
    head: { name: 'main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
  } as unknown as IRepository;
}

interface Harness {
  mergeView: MergeView;
  stagedPaths: string[][];
  resolved: string[];
}

function makeHarness(): Harness {
  const repo = makeRepo();
  const stagedPaths: string[][] = [];
  const gitService: Partial<IGitService> = {
    getRepository: (): Promise<IRepository> => Promise.resolve(repo),
    getRepositories: (): IRepository[] => [repo],
    stage: (_repo: IRepository, paths: string[]) => {
      stagedPaths.push([...paths]);
      return okAsync<void, GitError>(undefined);
    },
  };
  const mergeView = new MergeView(vscode.Uri.file('/mock/extension'), gitService as IGitService);
  const resolved: string[] = [];
  mergeView.onDidResolve((p) => resolved.push(p));
  return { mergeView, stagedPaths, resolved };
}

function setActiveEditorFile(fsPath: string | undefined): void {
  const win = vscode.window as unknown as { activeTextEditor: unknown };
  win.activeTextEditor =
    fsPath === undefined ? undefined : { document: { uri: vscode.Uri.file(fsPath) } };
}

describe('MergeView markResolved targeting', () => {
  afterEach(() => {
    setActiveEditorFile(undefined);
  });

  it('stages the ACTIVE editor file, not the last-shown one', async () => {
    const { mergeView, stagedPaths } = makeHarness();
    await mergeView.show(`${ROOT}/a.ts`);
    await mergeView.show(`${ROOT}/b.ts`);

    setActiveEditorFile(`${ROOT}/a.ts`);
    await mergeView.markResolved();

    assert.deepStrictEqual(
      stagedPaths,
      [['a.ts']],
      'the active editor file (a.ts) must be staged — not the last-shown b.ts'
    );
  });

  it('stages NOTHING when several files are outstanding and none matches the active editor', async () => {
    const { mergeView, stagedPaths } = makeHarness();
    await mergeView.show(`${ROOT}/a.ts`);
    await mergeView.show(`${ROOT}/b.ts`);

    setActiveEditorFile(`${ROOT}/unrelated.ts`);
    await mergeView.markResolved();

    assert.deepStrictEqual(stagedPaths, [], 'ambiguous target must never guess a file to stage');
  });

  it('falls back to the sole outstanding file when the active editor is elsewhere', async () => {
    const { mergeView, stagedPaths } = makeHarness();
    await mergeView.show(`${ROOT}/only.ts`);

    setActiveEditorFile(undefined);
    await mergeView.markResolved();

    assert.deepStrictEqual(stagedPaths, [['only.ts']]);
  });

  it('a staged file leaves the tracking set, so the remaining file becomes the sole fallback', async () => {
    const { mergeView, stagedPaths, resolved } = makeHarness();
    await mergeView.show(`${ROOT}/a.ts`);
    await mergeView.show(`${ROOT}/b.ts`);

    setActiveEditorFile(`${ROOT}/a.ts`);
    await mergeView.markResolved();
    setActiveEditorFile(undefined);
    await mergeView.markResolved();

    assert.deepStrictEqual(stagedPaths, [['a.ts'], ['b.ts']]);
    assert.deepStrictEqual(resolved, ['a.ts', 'b.ts']);
  });

  it('re-running markResolved with nothing outstanding is a no-op', async () => {
    const { mergeView, stagedPaths } = makeHarness();
    await mergeView.show(`${ROOT}/only.ts`);
    await mergeView.markResolved();
    await mergeView.markResolved();

    assert.deepStrictEqual(stagedPaths, [['only.ts']]);
  });
});

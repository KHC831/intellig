/**
 * The Open Merge View conflicted-file picker must offer AA (both-added) and
 * DD (both-deleted) conflicts, not only U-marked ones. A `=== 'U'` filter
 * dead-ended those with "No conflicted files found" even though the merge was
 * unresolved.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerRebaseConflictCommands } from '../../../src/commands/registration/rebaseConflictCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
import { IFileStatus, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

type Handler = (...args: unknown[]) => unknown;

const OPEN_MERGE_VIEW = 'intellig.merge.openMergeView';

function status(
  filePath: string,
  indexStatus: IFileStatus['indexStatus'],
  workTreeStatus: IFileStatus['workTreeStatus']
): IFileStatus {
  return { path: filePath, indexStatus, workTreeStatus };
}

describe('Open Merge View picker — conflict predicate', () => {
  const handlers = new Map<string, Handler>();
  const win = vscode.window as unknown as Record<string, unknown>;
  const originalRegister = vscode.commands.registerCommand;
  const originalInfo = win.showInformationMessage;
  const originalQuickPick = win.showQuickPick;

  let infos: string[];
  let quickPickItems: { label: string }[][];
  let statuses: IFileStatus[];

  beforeEach(() => {
    infos = [];
    quickPickItems = [];
    statuses = [];
    handlers.clear();

    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = (
      id: string,
      cb: Handler
    ): { dispose: () => void } => {
      handlers.set(id, cb);
      return { dispose: () => {} };
    };
    win.showInformationMessage = async (m: string): Promise<undefined> => {
      infos.push(m);
      return undefined;
    };
    win.showQuickPick = async (items: { label: string }[]): Promise<undefined> => {
      quickPickItems.push(items);
      return undefined; // user cancels — the handler stops before opening a view
    };

    const repo: IRepository = {
      rootUri: Uri.file('/repo'),
      state: 'idle',
      remotes: [],
      submodules: [],
    } as unknown as IRepository;

    const gitService = {
      getRepositories: (): readonly IRepository[] => [repo],
      getStatus: async (): Promise<IFileStatus[]> => statuses,
    };

    registerRebaseConflictCommands({
      services: { gitService },
      gitService,
      mergeView: undefined,
      context: { extensionUri: Uri.file('/ext') },
    } as unknown as ICommandContext);
  });

  afterEach(() => {
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = originalRegister;
    win.showInformationMessage = originalInfo;
    win.showQuickPick = originalQuickPick;
  });

  it('offers an AA (both-added) conflict in the picker', async () => {
    statuses = [status('src/aa.ts', 'A', 'A')];
    await Promise.resolve(handlers.get(OPEN_MERGE_VIEW)!());

    assert.ok(
      !infos.some((m) => /no conflicted files/i.test(m)),
      `AA conflict must not dead-end with "No conflicted files"; infos: ${infos.join(' | ')}`
    );
    assert.strictEqual(quickPickItems.length, 1, 'the picker must be shown');
    assert.deepStrictEqual(
      quickPickItems[0].map((i) => i.label),
      ['src/aa.ts'],
      'the AA file must be offered'
    );
  });

  it('offers a DD (both-deleted) conflict in the picker', async () => {
    statuses = [status('src/dd.ts', 'D', 'D')];
    await Promise.resolve(handlers.get(OPEN_MERGE_VIEW)!());

    assert.ok(!infos.some((m) => /no conflicted files/i.test(m)));
    assert.strictEqual(quickPickItems.length, 1);
    assert.deepStrictEqual(
      quickPickItems[0].map((i) => i.label),
      ['src/dd.ts']
    );
  });

  it('still reports "No conflicted files" when nothing is conflicted', async () => {
    statuses = [status('src/clean.ts', 'M', ' ')];
    await Promise.resolve(handlers.get(OPEN_MERGE_VIEW)!());

    assert.ok(infos.some((m) => /no conflicted files/i.test(m)));
    assert.strictEqual(quickPickItems.length, 0, 'no picker for a non-conflicted tree');
  });
});

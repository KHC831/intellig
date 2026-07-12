import '../../setup';
import * as assert from 'assert';
import { presentFileHistory } from '../../../src/commands/registration/commitHelpers';
import { resetMockConfiguration, setMockConfigValue } from '../../mocks/vscode';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';

const repo = { rootUri: { fsPath: '/r' } } as unknown as IRepository;

describe('presentFileHistory — shared file-history entry point', () => {
  beforeEach(() => resetMockConfiguration());

  it('routes to the History tab (loadFileHistory) when the tabbed window is enabled', async () => {
    // The palette and explorer entry points must behave identically: in tabbed
    // mode they load the file into the History tab rather than a QuickPick.
    const loaded: string[] = [];
    const ctx = {
      services: { gitService: {} },
      gitToolWindowProvider: {
        revealLogHost: async (): Promise<void> => {},
        loadFileHistory: async (p: string): Promise<void> => {
          loaded.push(p);
        },
      },
    } as unknown as ICommandContext;

    await presentFileHistory(ctx, repo, 'src/a.ts');
    assert.deepStrictEqual(loaded, ['src/a.ts'], 'should load the file into the History tab');
  });

  it('falls back to a QuickPick (getFileHistory) when the tabbed window is disabled', async () => {
    setMockConfigValue('intellig', 'useTabbedGitToolWindow', false);
    const queried: string[] = [];
    const ctx = {
      services: {
        gitService: {
          getFileHistory: async (_r: IRepository, p: string): Promise<unknown[]> => {
            queried.push(p);
            return [];
          },
        },
      },
      gitToolWindowProvider: undefined,
    } as unknown as ICommandContext;

    await presentFileHistory(ctx, repo, 'src/b.ts');
    assert.deepStrictEqual(queried, ['src/b.ts'], 'should query file history for the QuickPick');
  });
});

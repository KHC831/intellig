/**
 * F slice — HistoryTab line-scoped history wiring.
 *
 * When the tab is asked to load history for a specific line range it must call
 * the line-scoped op (`getLineHistory`) instead of whole-file history, mirroring
 * IntelliJ's "Show History for Selection". When no range is supplied — or the
 * service does not implement `getLineHistory` — it falls back to whole-file
 * history (`getFileHistory`).
 */

import '../../../setup';
import * as assert from 'assert';
import { Uri } from '../../../mocks/vscode';
import type {
  ICommit,
  IFileHistoryOptions,
  IGitService,
  IRepository,
} from '../../../../git-core/interfaces/IGitService';
import { HistoryTab } from '../../../../git-core/gitToolWindow/tabs/HistoryTab';

function mkRepo(): IRepository {
  return {
    rootUri: Uri.file('/repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

function mkCommit(hash: string): ICommit {
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message: 'msg',
    author: { name: 'T', email: 't@e.com' },
    committer: { name: 'T', email: 't@e.com' },
    parents: [],
    authorDate: new Date('2020-01-01'),
    commitDate: new Date('2020-01-01'),
  };
}

interface Calls {
  file: Array<{ path: string }>;
  line: Array<{ path: string; start: number; end: number; options?: IFileHistoryOptions }>;
}

function mkService(opts: { withLineHistory: boolean }): { service: IGitService; calls: Calls } {
  const repo = mkRepo();
  const calls: Calls = { file: [], line: [] };
  const base = {
    getRepositories: () => [repo],
    getBranches: async () => [],
    getFileHistory: async (_r: IRepository, path: string): Promise<ICommit[]> => {
      calls.file.push({ path });
      return [mkCommit('fff')];
    },
  };
  const lineHistory = opts.withLineHistory
    ? {
        getLineHistory: async (
          _r: IRepository,
          path: string,
          start: number,
          end: number,
          options?: IFileHistoryOptions
        ): Promise<ICommit[]> => {
          calls.line.push({ path, start, end, options });
          return [mkCommit('aaa')];
        },
      }
    : {};
  const service = { ...base, ...lineHistory } as unknown as IGitService;
  return { service, calls };
}

describe('HistoryTab — line-scoped history wiring (F)', () => {
  it('calls getLineHistory with the range when a line range is supplied', async () => {
    const { service, calls } = mkService({ withLineHistory: true });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts', undefined, { start: 10, end: 20 });
    assert.strictEqual(calls.line.length, 1, 'getLineHistory should be called once');
    assert.deepStrictEqual(
      { path: calls.line[0].path, start: calls.line[0].start, end: calls.line[0].end },
      { path: 'src/a.ts', start: 10, end: 20 }
    );
    assert.strictEqual(calls.file.length, 0, 'whole-file history must not be called');
    assert.strictEqual(tab.getState().selectedCommit, 'aaa');
  });

  it('records the line range in state for the UI to render', async () => {
    const { service } = mkService({ withLineHistory: true });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts', undefined, { start: 3, end: 7 });
    assert.deepStrictEqual(tab.getState().lineRange, { start: 3, end: 7 });
  });

  it('falls back to whole-file history when no line range is supplied', async () => {
    const { service, calls } = mkService({ withLineHistory: true });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts');
    assert.strictEqual(calls.file.length, 1, 'whole-file history should be called');
    assert.strictEqual(calls.line.length, 0, 'line history must not be called');
    assert.strictEqual(tab.getState().lineRange, undefined);
  });

  it('falls back to whole-file history when the service lacks getLineHistory', async () => {
    const { service, calls } = mkService({ withLineHistory: false });
    const tab = new HistoryTab(service);
    await tab.loadFile('src/a.ts', undefined, { start: 10, end: 20 });
    assert.strictEqual(calls.file.length, 1, 'must degrade to whole-file history');
    assert.strictEqual(tab.getState().selectedCommit, 'fff');
  });

  it('routes a history.loadFile message carrying startLine/endLine to line history', async () => {
    const { service, calls } = mkService({ withLineHistory: true });
    const tab = new HistoryTab(service);
    await tab.handleMessage({
      type: 'history.loadFile',
      path: 'src/a.ts',
      startLine: 5,
      endLine: 9,
    });
    assert.strictEqual(calls.line.length, 1);
    assert.deepStrictEqual(
      { start: calls.line[0].start, end: calls.line[0].end },
      { start: 5, end: 9 }
    );
  });
});

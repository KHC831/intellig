/**
 * The non-critical history reads degrade a non-zero git exit to an
 * empty/zero value (graceful degrade, unlike the list ops that return Err), but
 * they must LOG the swallowed stderr first so a real fault (corrupt repo, a ref
 * that passed the guard but doesn't exist) leaves a diagnostic trail instead of
 * being indistinguishable from "empty history".
 *
 * Covers the four swallow sites in StashTagHistoryOps: getLog, getLogCount,
 * getFileHistory, getLineHistory.
 */

import '../../setup';
import * as assert from 'assert';
import { StashTagHistoryOps } from '../../../src/git-core/ops/StashTagHistoryOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { getOutputChannel, __resetOutputChannelForTest } from '../../../src/utils/outputChannel';

const STDERR = 'fatal: bad revision';

function makeFailingOps(): StashTagHistoryOps {
  const gitCli = {
    exec: async () => ({ exitCode: 128, stdout: '', stderr: STDERR }),
  };
  const ctx = {
    gitCli,
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return new StashTagHistoryOps(ctx);
}

function loggedLines(): string[] {
  return (getOutputChannel() as unknown as { _lines: string[] })._lines;
}

const repo = (root: string): IRepository =>
  ({ rootUri: { fsPath: root } }) as unknown as IRepository;

describe('StashTagHistoryOps — history reads log swallowed non-zero exits', () => {
  beforeEach(() => {
    __resetOutputChannelForTest();
  });

  afterEach(() => {
    __resetOutputChannelForTest();
  });

  it('getLog degrades to [] but logs the swallowed stderr', async () => {
    const ops = makeFailingOps();
    const result = await ops.getLog(repo('/r'));
    assert.deepStrictEqual(result._unsafeUnwrap(), [], 'still degrades to empty history');
    assert.ok(
      loggedLines().some((l) => l.includes('getLog') && l.includes(STDERR)),
      `expected a log line naming getLog + the stderr; got ${JSON.stringify(loggedLines())}`
    );
  });

  it('getLogCount degrades to 0 but logs the swallowed stderr', async () => {
    const ops = makeFailingOps();
    const result = await ops.getLogCount(repo('/r'));
    assert.strictEqual(result._unsafeUnwrap(), 0);
    assert.ok(loggedLines().some((l) => l.includes('getLogCount') && l.includes(STDERR)));
  });

  it('getFileHistory degrades to [] but logs the swallowed stderr', async () => {
    const ops = makeFailingOps();
    const result = await ops.getFileHistory(repo('/r'), 'src/a.ts');
    assert.deepStrictEqual(result._unsafeUnwrap(), []);
    assert.ok(loggedLines().some((l) => l.includes('getFileHistory') && l.includes(STDERR)));
  });

  it('getLineHistory degrades to [] but logs the swallowed stderr', async () => {
    const ops = makeFailingOps();
    const result = await ops.getLineHistory(repo('/r'), 'src/a.ts', 1, 5);
    assert.deepStrictEqual(result._unsafeUnwrap(), []);
    assert.ok(loggedLines().some((l) => l.includes('getLineHistory') && l.includes(STDERR)));
  });
});

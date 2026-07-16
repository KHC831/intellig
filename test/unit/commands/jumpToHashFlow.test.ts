/**
 * Jump-to-Commit command flow — reference parity for the miss path.
 *
 * VcsLogNavigationUtil.tryJumpTo retries as data packs load until the pack is
 * full, so any commit in the repo is eventually found; only then does it warn.
 * The flow here mirrors that: a miss in the loaded window grows the log to
 * full history ONCE and retries; a ref match whose tip commit is outside the
 * loaded window grows before scrolling.
 */

import '../../setup';
import * as assert from 'assert';
import { runJumpToCommitFlow } from '../../../src/commands/registration/commitRepoCoreCommands';
import type { IBranch, ICommit, ITag } from '../../../src/git-core/interfaces/IGitService';

function mkCommit(hash: string): ICommit {
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message: 'subject',
    author: { name: 'T', email: 't@example.com' },
    committer: { name: 'T', email: 't@example.com' },
    parents: [],
    authorDate: new Date('2020-01-01'),
    commitDate: new Date('2020-01-01'),
  };
}

const NEW = mkCommit('1111111111111111111111111111111111111111');
const OLD = mkCommit('2222222222222222222222222222222222222222');

interface HarnessOpts {
  query: string;
  window: ICommit[];
  fullWindow?: ICommit[];
  branches?: IBranch[];
  tags?: ITag[];
  growSucceeds?: boolean;
}

function harness(opts: HarnessOpts): {
  run: () => Promise<void>;
  growCalls: () => number;
  scrolled: () => string[];
  warnings: () => string[];
} {
  let commits = opts.window;
  let grows = 0;
  const scrolled: string[] = [];
  const warnings: string[] = [];
  const run = () =>
    runJumpToCommitFlow({
      promptQuery: async () => opts.query,
      getLoadedCommits: () => commits,
      getRefs: async () => ({ branches: opts.branches ?? [], tags: opts.tags ?? [] }),
      ensureFullLogLoaded: async () => {
        grows += 1;
        if (opts.growSucceeds === false) {
          return false;
        }
        commits = opts.fullWindow ?? commits;
        return true;
      },
      revealLogHost: async () => undefined,
      scrollToCommit: (hash: string) => {
        if (!commits.some((c) => c.hash === hash)) {
          return false;
        }
        scrolled.push(hash);
        return true;
      },
      warn: (m: string) => warnings.push(m),
    });
  return { run, growCalls: () => grows, scrolled: () => scrolled, warnings: () => warnings };
}

describe('runJumpToCommitFlow — grow-and-retry on a miss (F-A6)', () => {
  it('grows the log to full history and finds an off-window hash', async () => {
    const h = harness({
      query: OLD.hash.substring(0, 8),
      window: [NEW],
      fullWindow: [NEW, OLD],
    });
    await h.run();
    assert.strictEqual(h.growCalls(), 1, 'a miss must grow the window once');
    assert.deepStrictEqual(h.scrolled(), [OLD.hash]);
    assert.deepStrictEqual(h.warnings(), []);
  });

  it('warns only after the grown window still has no match', async () => {
    const h = harness({
      query: 'deadbeef',
      window: [NEW],
      fullWindow: [NEW, OLD],
    });
    await h.run();
    assert.strictEqual(h.growCalls(), 1);
    assert.strictEqual(h.warnings().length, 1);
    assert.match(h.warnings()[0], /No commit found/);
  });

  it('grows before scrolling when a ref matches but its tip is outside the window', async () => {
    const h = harness({
      query: 'feature',
      window: [NEW],
      fullWindow: [NEW, OLD],
      branches: [{ name: 'feature', type: 'local', commit: OLD.hash, isHead: false }],
    });
    await h.run();
    assert.deepStrictEqual(h.scrolled(), [OLD.hash], 'the ref tip is loaded then scrolled to');
    assert.deepStrictEqual(h.warnings(), []);
  });

  it('degrades to the not-loaded warning when the grow seam is unavailable', async () => {
    const h = harness({
      query: 'feature',
      window: [NEW],
      branches: [{ name: 'feature', type: 'local', commit: OLD.hash, isHead: false }],
      growSucceeds: false,
    });
    await h.run();
    assert.strictEqual(h.scrolled().length, 0);
    assert.strictEqual(h.warnings().length, 1);
  });

  it('does nothing on a cancelled prompt', async () => {
    const h = harness({ query: '', window: [NEW] });
    await h.run();
    assert.strictEqual(h.growCalls(), 0);
    assert.deepStrictEqual(h.warnings(), []);
  });
});

/**
 * The multi-commit changed-files load is bounded twice: superseded selections
 * stop spawning git, and a live selection never spawns more than a fixed
 * number of git processes at once.
 *
 * Holding shift+down over a long range fires one load per row. Without these
 * bounds every one of them runs its full per-commit `git diff` fan-out and is
 * discarded only at the paint seam, so the cost of a gesture the user has
 * already moved past is paid in full.
 */

import '../../setup';
import * as assert from 'assert';
import type { IRepository } from '../../../src/services';
import type { IChangedFile } from '../../../src/git-core/interfaces/IGitToolWindowProvider';
import {
  createMultiCommitFilesLoader,
  MULTI_DETAILS_LOAD_CONCURRENCY,
} from '../../../src/registration/multiCommitFilesLoad';
import { MULTI_DETAILS_COMMIT_CAP } from '../../../src/git-core/gitToolWindow/provider/detailsPanelModel';

const REPO = { rootUri: { fsPath: '/repo' } } as unknown as IRepository;

function hashes(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`.padEnd(40, '0'));
}

interface Published {
  hashes: readonly string[];
  filesByHash: ReadonlyMap<string, IChangedFile[]>;
  loadedHashes: readonly string[];
}

/** A loader whose per-commit loads block until the test releases them. */
function makeGatedLoader(): {
  handle: (hashes: readonly string[]) => Promise<void>;
  started: string[];
  inFlight: () => number;
  peakInFlight: () => number;
  drain: () => Promise<void>;
  published: Published[];
} {
  const started: string[] = [];
  const published: Published[] = [];
  const gates: Array<() => void> = [];
  let inFlight = 0;
  let peakInFlight = 0;

  const handle = createMultiCommitFilesLoader({
    resolveRepo: async () => REPO,
    loadChangedFiles: async (_repo, hash) => {
      started.push(hash);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => gates.push(resolve));
      inFlight -= 1;
      return [{ path: `${hash}.ts`, status: 'modified' as const }];
    },
    publish: (hashes, filesByHash, loadedHashes) =>
      published.push({ hashes, filesByHash, loadedHashes }),
  });

  return {
    handle,
    started,
    inFlight: () => inFlight,
    peakInFlight: () => peakInFlight,
    // Freeing a slot lets the next queued commit start and register its own
    // gate, so draining is a loop, not one pass.
    drain: async () => {
      for (let round = 0; round < 200 && gates.length > 0; round++) {
        const pending = gates.splice(0, gates.length);
        for (const release of pending) {
          release();
        }
        await settle();
      }
    },
    published,
  };
}

/** Let queued microtasks (and any freshly-started loads) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

describe('multi-commit changed-files load', () => {
  it('stops issuing git for a selection the user has already left', async () => {
    const h = makeGatedLoader();
    const first = hashes('a', 12);
    const second = hashes('b', 2);

    const firstRun = h.handle(first);
    await settle();
    const startedBeforeSupersede = h.started.length;
    assert.strictEqual(
      startedBeforeSupersede,
      MULTI_DETAILS_LOAD_CONCURRENCY,
      'sanity: the first selection fills the concurrency window'
    );

    // A newer selection arrives while the first is still mid-load.
    const secondRun = h.handle(second);
    await h.drain();
    await Promise.all([firstRun, secondRun]);

    const firstStarted = h.started.filter((x) => first.includes(x));
    assert.strictEqual(
      firstStarted.length,
      MULTI_DETAILS_LOAD_CONCURRENCY,
      'the superseded selection must not spawn git for its queued commits'
    );
    assert.deepStrictEqual(
      h.published.map((p) => p.hashes),
      [second],
      'only the latest selection paints'
    );
  });

  it('keeps at most the concurrency bound of git processes in flight', async () => {
    const h = makeGatedLoader();

    const run = h.handle(hashes('a', 12));
    await settle();
    await h.drain();
    await run;

    assert.ok(
      h.peakInFlight() <= MULTI_DETAILS_LOAD_CONCURRENCY,
      `peak in flight ${h.peakInFlight()} exceeds the bound`
    );
    assert.ok(h.peakInFlight() > 1, 'sanity: the loads do overlap');
  });

  it('publishes the commits the cap allowed, not the whole selection', async () => {
    const loadedFor: Published[] = [];
    const handle = createMultiCommitFilesLoader({
      resolveRepo: async () => REPO,
      loadChangedFiles: async (_repo, hash) => [{ path: `${hash}.ts`, status: 'modified' }],
      publish: (hashes, filesByHash, loadedHashes) =>
        loadedFor.push({ hashes, filesByHash, loadedHashes }),
    });
    const selection = hashes('a', MULTI_DETAILS_COMMIT_CAP + 5);

    await handle(selection);

    assert.strictEqual(loadedFor.length, 1);
    assert.strictEqual(loadedFor[0].hashes.length, MULTI_DETAILS_COMMIT_CAP + 5);
    assert.deepStrictEqual(
      [...loadedFor[0].loadedHashes],
      selection.slice(0, MULTI_DETAILS_COMMIT_CAP),
      'the loaded set is the capped prefix in selection order'
    );
  });

  it('lets one unreadable commit contribute no files instead of blanking the tree', async () => {
    const published: Published[] = [];
    const selection = hashes('a', 3);
    const handle = createMultiCommitFilesLoader({
      resolveRepo: async () => REPO,
      loadChangedFiles: async (_repo, hash) => {
        if (hash === selection[1]) {
          throw new Error('bad object');
        }
        return [{ path: `${hash}.ts`, status: 'modified' }];
      },
      publish: (hashes, filesByHash, loadedHashes) =>
        published.push({ hashes, filesByHash, loadedHashes }),
    });

    await handle(selection);

    assert.strictEqual(published.length, 1);
    assert.deepStrictEqual(published[0].filesByHash.get(selection[1]), []);
    assert.strictEqual(published[0].filesByHash.get(selection[0])?.length, 1);
  });
});

/**
 * The single-commit changed-files load reports every way it can fail.
 *
 * The panel only asks for a commit whose payload is missing, so a load that
 * bails without publishing is not merely silent — it paints the commit as
 * "changed nothing" AND leaves the request latch held, so no repaint can
 * recover it until the user selects away and back.
 */

import '../../setup';
import * as assert from 'assert';
import type { IRepository } from '../../../src/services';
import type { IChangedFile } from '../../../src/git-core/interfaces/IGitToolWindowProvider';
import { createSingleCommitFilesLoader } from '../../../src/registration/singleCommitFilesLoad';

const REPO = { rootUri: { fsPath: '/repo' } } as unknown as IRepository;
const HASH = 'a'.repeat(40);

interface Published {
  hash: string;
  files: IChangedFile[];
  error?: unknown;
}

function harness(over: {
  resolveRepo?: (hash: string) => Promise<IRepository | undefined>;
  loadChangedFiles?: (repo: IRepository, hash: string) => Promise<IChangedFile[]>;
}): { load: (hash: string) => Promise<void>; published: Published[] } {
  const published: Published[] = [];
  const load = createSingleCommitFilesLoader({
    resolveRepo: over.resolveRepo ?? (async () => REPO),
    loadChangedFiles:
      over.loadChangedFiles ?? (async () => [{ path: 'src/a.ts', status: 'modified' }]),
    publish: (hash, files, error) => published.push({ hash, files, error }),
  });
  return { load, published };
}

describe('single-commit changed-files load', () => {
  it('publishes the files on the happy path', async () => {
    const h = harness({});

    await h.load(HASH);

    assert.strictEqual(h.published.length, 1);
    assert.strictEqual(h.published[0].files.length, 1);
    assert.strictEqual(h.published[0].error, undefined);
  });

  it('reports a commit no repository contains instead of painting "no changes"', async () => {
    const h = harness({ resolveRepo: async () => undefined });

    await h.load(HASH);

    assert.strictEqual(h.published.length, 1, 'a payload must land, or the panel cannot recover');
    assert.strictEqual(h.published[0].files.length, 0);
    assert.ok(h.published[0].error, 'the reason must reach the panel');
  });

  it('reports a repository lookup that throws', async () => {
    const h = harness({
      resolveRepo: async () => {
        throw new Error('repo lookup exploded');
      },
    });

    await h.load(HASH);

    assert.strictEqual(h.published.length, 1);
    assert.match(String(h.published[0].error), /repo lookup exploded/);
  });

  it('reports an unreadable diff', async () => {
    const h = harness({
      loadChangedFiles: async () => {
        throw new Error('bad object 1234567');
      },
    });

    await h.load(HASH);

    assert.strictEqual(h.published.length, 1);
    assert.match(String(h.published[0].error), /bad object 1234567/);
  });

  it('starts the containing-branches side work only once a repo is known', async () => {
    const resolved: string[] = [];
    const load = createSingleCommitFilesLoader({
      resolveRepo: async () => undefined,
      loadChangedFiles: async () => [],
      publish: () => {},
      onRepoResolved: (_repo, hash) => resolved.push(hash),
    });

    await load(HASH);

    assert.deepStrictEqual(resolved, [], 'no repo means no branch query to run');
  });
});

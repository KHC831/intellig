/**
 * Graph scroll-to-bottom load-more — controller state machine + subscriber
 * wiring.
 *
 * The webview's `loadMoreCommits` → provider `onDidRequestLoadMoreCommits`
 * emitter must have a subscriber; without one the graph is hard-capped at the
 * first page. These specs pin that subscriber:
 *   - the controller grows the limit by one page per load-more, re-runs the
 *     SAME scoped load, and resets on a fresh load;
 *   - it no-ops until a fresh load establishes the active repo/filter;
 *   - `wireGraphLoadMore` actually subscribes to the provider's emitter (guard
 *     against regressing back to a dead emitter).
 */

import '../../setup';
import * as assert from 'assert';
import {
  createGraphLoadMoreController,
  wireGraphLoadMore,
} from '../../../src/registration/graphLoadMore';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import { Uri } from '../../mocks/vscode';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

interface Filter {
  branch?: string;
}

const repoA = { rootUri: { fsPath: '/a' } } as unknown as IRepository;
const repoB = { rootUri: { fsPath: '/b' } } as unknown as IRepository;

interface ReloadCall {
  repo: IRepository;
  filter: Filter | undefined;
  limit: number;
}

function makeController(basePage = 500) {
  const calls: ReloadCall[] = [];
  const controller = createGraphLoadMoreController<Filter>(basePage, (repo, filter, opts) => {
    calls.push({ repo, filter, limit: opts.limit });
  });
  return { controller, calls };
}

describe('Graph load-more controller', () => {
  it('starts at one base page', () => {
    const { controller } = makeController(500);
    assert.strictEqual(controller.currentLimit(), 500);
  });

  it('no-ops when no fresh load has established the active repo', () => {
    const { controller, calls } = makeController(500);
    controller.handleLoadMore();
    assert.strictEqual(calls.length, 0, 'no reload before any repo is active');
  });

  it('grows the limit by one page and re-runs the scoped load', () => {
    const { controller, calls } = makeController(500);
    controller.noteFreshLoad(repoA, { branch: 'feature' });

    controller.handleLoadMore();

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].repo, repoA);
    assert.deepStrictEqual(calls[0].filter, { branch: 'feature' });
    assert.strictEqual(calls[0].limit, 1000, 'limit grows base→2×base');
    assert.strictEqual(controller.currentLimit(), 1000);
  });

  it('keeps growing across successive load-more requests', () => {
    const { controller, calls } = makeController(500);
    controller.noteFreshLoad(repoA, undefined);
    controller.handleLoadMore();
    controller.handleLoadMore();
    controller.handleLoadMore();
    assert.deepStrictEqual(
      calls.map((c) => c.limit),
      [1000, 1500, 2000]
    );
  });

  it('resets the limit to base page on a fresh load (repo switch)', () => {
    const { controller, calls } = makeController(500);
    controller.noteFreshLoad(repoA, undefined);
    controller.handleLoadMore(); // grow to 1000
    assert.strictEqual(controller.currentLimit(), 1000);

    controller.noteFreshLoad(repoB, { branch: 'main' });
    assert.strictEqual(controller.currentLimit(), 500, 'repo switch resets the grown limit');

    controller.handleLoadMore();
    const last = calls[calls.length - 1];
    assert.strictEqual(last.repo, repoB, 'load-more now targets the newly-active repo');
    assert.strictEqual(last.limit, 1000);
  });

  it('uses a small initial page but a larger load-more increment (fast first paint)', () => {
    const calls: ReloadCall[] = [];
    // Production shape: initial 100 (small startup chunk), increment 500.
    const controller = createGraphLoadMoreController<Filter>(
      100,
      (repo, filter, opts) => calls.push({ repo, filter, limit: opts.limit }),
      500
    );
    controller.noteFreshLoad(repoA, undefined);
    assert.strictEqual(
      controller.currentLimit(),
      100,
      'fresh load starts at the small initial page'
    );
    controller.handleLoadMore();
    assert.strictEqual(controller.currentLimit(), 600, 'load-more grows by the larger increment');
    controller.handleLoadMore();
    assert.deepStrictEqual(
      calls.map((c) => c.limit),
      [600, 1100],
      'increments by 500, not by the initial 100'
    );
  });
});

describe('wireGraphLoadMore — subscriber wiring', () => {
  it('subscribes to the provider emitter so a load-more request reaches the handler', () => {
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    let handled = 0;
    const disposable = wireGraphLoadMore(provider, () => {
      handled++;
    });

    // Drive the SAME emitter the webview's loadMoreCommits message fires.
    provider.fireLoadMoreCommits();
    provider.fireLoadMoreCommits();

    assert.strictEqual(handled, 2, 'each load-more request must reach the handler');

    disposable.dispose();
    provider.fireLoadMoreCommits();
    assert.strictEqual(handled, 2, 'no delivery after dispose');

    provider.dispose();
  });
});

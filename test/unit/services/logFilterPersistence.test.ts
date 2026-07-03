/**
 * The Git tool window's log filter survives a window reload: setLogFilter
 * writes through to workspaceState, a fresh provider constructed over the
 * same memento starts with the persisted filter active, and
 * getActiveLogFilter exposes it for the initial/refresh load path (which
 * reapplies it — see loadAllPanelData wiring tests).
 */

import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import type { ILogFilter } from '../../../src/git-core/interfaces/IGitToolWindowProvider';
import { Uri } from '../../mocks/vscode';
import type * as vscode from 'vscode';

function memento(): vscode.Memento {
  const bag: Record<string, unknown> = {};
  return {
    get: <T>(key: string, def?: T): T => (key in bag ? (bag[key] as T) : (def as T)),
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) {
        delete bag[key];
      } else {
        bag[key] = value;
      }
    },
    keys: () => Object.keys(bag),
  } as vscode.Memento;
}

describe('GitToolWindowProvider — log filter persistence', () => {
  it('a filter set in one provider is active in a fresh provider over the same state', () => {
    const state = memento();
    const first = new GitToolWindowProvider(Uri.file('/test/extension'), state);
    const filter: ILogFilter = {
      author: 'Alice',
      searchText: 'fix',
      since: new Date('2026-01-02T00:00:00.000Z'),
    };
    first.setLogFilter(filter);

    const second = new GitToolWindowProvider(Uri.file('/test/extension'), state);
    const restored = second.getActiveLogFilter();
    assert.ok(restored, 'restored filter present');
    assert.strictEqual(restored.author, 'Alice');
    assert.strictEqual(restored.searchText, 'fix');
    assert.ok(restored.since instanceof Date);
    assert.strictEqual(restored.since.toISOString(), '2026-01-02T00:00:00.000Z');
  });

  it('clearing the filter clears the persisted slot too', () => {
    const state = memento();
    const first = new GitToolWindowProvider(Uri.file('/test/extension'), state);
    first.setLogFilter({ author: 'Alice' });
    first.setLogFilter(undefined);

    const second = new GitToolWindowProvider(Uri.file('/test/extension'), state);
    assert.strictEqual(second.getActiveLogFilter(), undefined);
  });

  it('getActiveLogFilter reflects the live filter without persistence wired', () => {
    const provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    provider.setLogFilter({ searchText: 'abc' });
    assert.deepStrictEqual(provider.getActiveLogFilter(), { searchText: 'abc' });
  });
});

/**
 * Log-filter persistence round-trip (ADR-003 storage discipline: validate
 * field-by-field on load, never trust the stored shape). Dates serialize to
 * ISO strings and revive to Date; junk — wrong types, unparseable dates,
 * unknown payloads — loads as "no filter" instead of poisoning the log.
 */

import '../../setup';
import * as assert from 'assert';
import { saveLogFilter, loadLogFilter } from '../../../src/utils/logFilterStorage';
import type { ILogFilter } from '../../../src/git-core/interfaces/IGitToolWindowProvider';
import type * as vscode from 'vscode';

function memento(initial: Record<string, unknown> = {}): vscode.Memento & {
  bag: Record<string, unknown>;
} {
  const bag: Record<string, unknown> = { ...initial };
  return {
    bag,
    get: <T>(key: string, def?: T): T => (key in bag ? (bag[key] as T) : (def as T)),
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) {
        delete bag[key];
      } else {
        bag[key] = value;
      }
    },
    keys: () => Object.keys(bag),
  } as vscode.Memento & { bag: Record<string, unknown> };
}

describe('logFilterStorage — persistence round-trip', () => {
  it('round-trips a full filter, reviving dates', () => {
    const state = memento();
    const filter: ILogFilter = {
      branch: 'main',
      branches: ['main', 'feature/x'],
      branchesNone: false,
      author: 'Alice <a@example.com>',
      since: new Date('2026-01-02T00:00:00.000Z'),
      until: new Date('2026-06-30T00:00:00.000Z'),
      path: 'src/',
      paths: ['src/', 'docs/'],
      searchText: 'fix',
      searchRegex: true,
      searchCaseSensitive: true,
      noMerges: true,
      firstParent: true,
      simplifyMerges: false,
      minParents: 2,
      maxParents: 3,
      logRange: 'main..feature/x',
    };
    saveLogFilter(state, filter);
    const loaded = loadLogFilter(state);
    assert.ok(loaded, 'filter must load back');
    assert.ok(loaded.since instanceof Date && loaded.until instanceof Date, 'dates revive');
    assert.deepStrictEqual(loaded, filter);
  });

  it('saving undefined clears the stored filter', () => {
    const state = memento();
    saveLogFilter(state, { author: 'x' });
    saveLogFilter(state, undefined);
    assert.strictEqual(loadLogFilter(state), undefined);
  });

  it('an empty memento loads as no filter', () => {
    assert.strictEqual(loadLogFilter(memento()), undefined);
  });

  it('junk payloads load as no filter (never throw)', () => {
    for (const junk of [42, 'nope', [], { since: 'not-a-date' }, { branches: [1, 2] }, null]) {
      const state = memento({ 'intellig.logFilter': junk });
      assert.strictEqual(loadLogFilter(state), undefined, `junk ${JSON.stringify(junk)}`);
    }
  });

  it('round-trips a multi-author selection', () => {
    const state = memento();
    saveLogFilter(state, { authors: ['Alice', 'Bob', 'Carol'] });

    assert.deepStrictEqual(loadLogFilter(state), { authors: ['Alice', 'Bob', 'Carol'] });
  });

  it('drops unknown fields instead of resurrecting them', () => {
    const state = memento({
      'intellig.logFilter': { author: 'Alice', futureField: 'x' },
    });
    const loaded = loadLogFilter(state);
    assert.deepStrictEqual(loaded, { author: 'Alice' });
  });
});

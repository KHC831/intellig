/**
 * Group By (tree | flat) for the Details Panel's changed-file list.
 *
 * IntelliJ always offers a GroupBy on the changes list; the chosen mode is a
 * UI preference that outlives a single selection, so it persists per workspace.
 */

import '../../setup';
import * as assert from 'assert';
import {
  DETAILS_GROUP_BY_SLOT,
  loadDetailsGroupBy,
  saveDetailsGroupBy,
} from '../../../src/utils/detailsGroupBy';
import type { MementoLike } from '../../../src/utils/persistedState';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import type { ICommitDetails } from '../../../src/services/interfaces';
import { Uri } from '../../mocks/vscode';
import { renderDetailsPanel } from '../../helpers/detailsPanelDom';

/** In-memory Memento standing in for workspace state. */
function makeState(seed?: Record<string, unknown>): MementoLike {
  const store = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    update: (key: string, value: unknown): Thenable<void> => {
      store.set(key, value);
      return Promise.resolve();
    },
  } as unknown as MementoLike;
}

describe('Details Panel Group By rendering', () => {
  const FILES = [
    { path: 'src/main/java/App.java', status: 'modified' as const },
    { path: 'src/main/java/util/Helper.java', status: 'added' as const },
  ];

  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  const details = (): ICommitDetails =>
    ({
      hash: 'a'.repeat(40),
      message: 'Change files',
      author: { name: 'A', email: 'a@x.com' },
      date: new Date('2024-01-15T10:30:00Z'),
      parents: [],
      branches: [],
      tags: [],
      changedFiles: FILES,
    }) as ICommitDetails;

  /** Rendered leaf labels, in order. */
  const leafLabels = (): string[] =>
    Array.from(
      renderDetailsPanel(provider._getDetailsPanelModel(details())).querySelectorAll(
        '.changed-file-item .file-name'
      )
    ).map((el) => el.textContent ?? '');

  it('groups files under compacted directories in tree mode', () => {
    provider.setDetailsGroupBy('tree');

    // Leaves are labelled by base name; the tree builder emits nested
    // directories before same-level files, so compare as a set.
    assert.deepStrictEqual([...leafLabels()].sort(), ['App.java', 'Helper.java']);
    assert.ok(
      renderDetailsPanel(provider._getDetailsPanelModel(details())).querySelector(
        '.changed-dir-item'
      ),
      'tree mode renders directory rows'
    );
  });

  it('lists full paths with no directory rows in flat mode', () => {
    provider.setDetailsGroupBy('flat');

    assert.deepStrictEqual(leafLabels(), [
      'src/main/java/App.java',
      'src/main/java/util/Helper.java',
    ]);
    assert.strictEqual(
      renderDetailsPanel(provider._getDetailsPanelModel(details())).querySelector(
        '.changed-dir-item'
      ),
      null,
      'flat mode has no directory rows'
    );
  });
});

describe('Details Panel Group By toggle', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  const toggle = (): Element | null =>
    renderDetailsPanel(
      provider._getDetailsPanelModel({
        hash: 'a'.repeat(40),
        message: 'Change',
        author: { name: 'A', email: 'a@x.com' },
        date: new Date('2024-01-15T10:30:00Z'),
        parents: [],
        branches: [],
        tags: [],
        changedFiles: [{ path: 'a/b.txt', status: 'modified' }],
      } as ICommitDetails)
    ).querySelector('.details-groupby-toggle');

  it('offers the flat mode while grouping as a tree', () => {
    provider.setDetailsGroupBy('tree');

    assert.strictEqual(
      toggle()?.getAttribute('data-groupby'),
      'flat',
      'the button offers the other mode'
    );
  });

  it('offers the tree mode while listing flat paths', () => {
    provider.setDetailsGroupBy('flat');

    assert.strictEqual(toggle()?.getAttribute('data-groupby'), 'tree');
  });

  it('applies a group-by message from the webview', () => {
    (provider as unknown as { _handleWebviewMessage(m: unknown): void })._handleWebviewMessage({
      type: 'setDetailsGroupBy',
      groupBy: 'flat',
    });

    assert.strictEqual(provider.getDetailsGroupBy(), 'flat');
  });

  it('ignores an unknown mode from the webview', () => {
    (provider as unknown as { _handleWebviewMessage(m: unknown): void })._handleWebviewMessage({
      type: 'setDetailsGroupBy',
      groupBy: 'sideways',
    });

    assert.strictEqual(provider.getDetailsGroupBy(), 'tree', 'a bad mode must not be applied');
  });
});

describe('Details Panel Group By persistence', () => {
  it('defaults to the compacted tree when nothing is stored', () => {
    assert.strictEqual(loadDetailsGroupBy(makeState()), 'tree');
  });

  it('round-trips a saved flat preference', () => {
    const state = makeState();

    saveDetailsGroupBy(state, 'flat');

    assert.strictEqual(loadDetailsGroupBy(state), 'flat');
  });

  it('falls back to the tree when the stored value is not a known mode', () => {
    const state = makeState({
      [DETAILS_GROUP_BY_SLOT.key]: { v: DETAILS_GROUP_BY_SLOT.version, data: 'sideways' },
    });

    assert.strictEqual(loadDetailsGroupBy(state), 'tree', 'an unknown mode must not be trusted');
  });
});

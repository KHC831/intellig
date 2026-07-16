/**
 * Unit tests for `BlameOptionsSource`.
 *
 * Covers:
 * - config-backed flag snapshot + `asBlameOptions()` projection.
 * - toggle commands' IntelliJ semantics (ignore-whitespace flip; the
 *   within/across movement toggles' XOR enum transitions).
 * - Hidden-revision add / remove / clear round-trips through workspaceState.
 * - `onDidChange` fires for every state mutation that the providers consume.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { BlameOptionsSource } from '../../../src/blame/BlameOptionsSource';
import { resetMockConfiguration, setMockConfigValue } from '../../mocks/vscode';

/**
 * Minimal in-memory `vscode.Memento` substitute so workspaceState round-trips
 * work in unit tests without the extension host.
 */
function makeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return (store.get(key) as T) ?? defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
    },
    keys(): readonly string[] {
      return Array.from(store.keys());
    },
  };
}

describe('BlameOptionsSource', () => {
  let source: BlameOptionsSource | undefined;
  let memento: vscode.Memento;

  beforeEach(() => {
    resetMockConfiguration();
    memento = makeMemento();
    source = new BlameOptionsSource(memento);
  });

  afterEach(() => {
    source?.dispose();
    source = undefined;
  });

  describe('snapshot', () => {
    it('defaults ignoreWhitespace to true (IntelliJ default), movements off, hiddenRevisions empty', () => {
      const snap = source!.snapshot();
      assert.strictEqual(snap.ignoreWhitespace, true);
      assert.strictEqual(snap.detectMovements, 'none');
      assert.strictEqual(snap.hiddenRevisions.size, 0);
    });

    it('reflects config overrides for each flag', () => {
      setMockConfigValue('intellig', 'blame.ignoreWhitespace', false);
      setMockConfigValue('intellig', 'blame.detectMovements', 'across');
      const snap = source!.snapshot();
      assert.strictEqual(snap.ignoreWhitespace, false);
      assert.strictEqual(snap.detectMovements, 'across');
    });

    it('coerces an invalid detectMovements value to none', () => {
      setMockConfigValue('intellig', 'blame.detectMovements', 'bogus');
      assert.strictEqual(source!.snapshot().detectMovements, 'none');
    });

    it('asBlameOptions() projects the blame flags only', () => {
      setMockConfigValue('intellig', 'blame.detectMovements', 'within');
      const opts = source!.asBlameOptions();
      assert.strictEqual(opts.ignoreWhitespace, true);
      assert.strictEqual(opts.detectMovements, 'within');
      assert.ok(!('hiddenRevisions' in opts));
    });
  });

  describe('toggleIgnoreWhitespace', () => {
    it('flips the flag and returns the new value', async () => {
      assert.strictEqual(source!.snapshot().ignoreWhitespace, true);
      const next = await source!.toggleIgnoreWhitespace();
      assert.strictEqual(next, false);
      assert.strictEqual(source!.snapshot().ignoreWhitespace, false);
    });
  });

  // Mirrors GitToggleAnnotationOptionsActionProvider: the within toggle reads
  // as checked for INNER or OUTER and writes INNER/NONE; the across toggle
  // reads as checked for OUTER only and disabling falls back to INNER.
  describe('movement-detection toggles (IntelliJ XOR enum semantics)', () => {
    it('within toggle: none -> within', async () => {
      const next = await source!.toggleDetectMovementsWithinFile();
      assert.strictEqual(next, 'within');
      assert.strictEqual(source!.snapshot().detectMovements, 'within');
    });

    it('within toggle: within -> none', async () => {
      setMockConfigValue('intellig', 'blame.detectMovements', 'within');
      const next = await source!.toggleDetectMovementsWithinFile();
      assert.strictEqual(next, 'none');
    });

    it('within toggle: across -> none (was checked, unchecking clears detection)', async () => {
      setMockConfigValue('intellig', 'blame.detectMovements', 'across');
      const next = await source!.toggleDetectMovementsWithinFile();
      assert.strictEqual(next, 'none');
    });

    it('across toggle: none -> across', async () => {
      const next = await source!.toggleDetectMovementsAcrossFiles();
      assert.strictEqual(next, 'across');
    });

    it('across toggle: within -> across', async () => {
      setMockConfigValue('intellig', 'blame.detectMovements', 'within');
      const next = await source!.toggleDetectMovementsAcrossFiles();
      assert.strictEqual(next, 'across');
    });

    it('across toggle: across -> within (falls back to INNER, not NONE)', async () => {
      setMockConfigValue('intellig', 'blame.detectMovements', 'across');
      const next = await source!.toggleDetectMovementsAcrossFiles();
      assert.strictEqual(next, 'within');
    });
  });

  describe('hideRevision / showRevision / clearHiddenRevisions', () => {
    it('hideRevision records the SHA and persists to workspaceState', async () => {
      const sha = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
      await source!.hideRevision(sha);
      assert.strictEqual(source!.isHidden(sha), true);
      assert.deepStrictEqual(memento.get('intellig.blame.hiddenRevisions'), { v: 1, data: [sha] });
    });

    it('ignores the all-zero sentinel SHA and empty strings', async () => {
      await source!.hideRevision('0000000000000000000000000000000000000000');
      await source!.hideRevision('');
      assert.strictEqual(source!.snapshot().hiddenRevisions.size, 0);
    });

    it('is a no-op when the SHA is already hidden', async () => {
      const sha = '1'.repeat(40);
      const fired: number[] = [];
      source!.onDidChange(() => fired.push(1));
      await source!.hideRevision(sha);
      await source!.hideRevision(sha);
      assert.strictEqual(fired.length, 1, 'second hide should not fire onDidChange');
    });

    it('showRevision removes the SHA and persists', async () => {
      const sha = '2'.repeat(40);
      await source!.hideRevision(sha);
      await source!.showRevision(sha);
      assert.strictEqual(source!.isHidden(sha), false);
      assert.deepStrictEqual(memento.get('intellig.blame.hiddenRevisions'), { v: 1, data: [] });
    });

    it('clearHiddenRevisions wipes the set and persists', async () => {
      await source!.hideRevision('3'.repeat(40));
      await source!.hideRevision('4'.repeat(40));
      await source!.clearHiddenRevisions();
      assert.strictEqual(source!.snapshot().hiddenRevisions.size, 0);
    });
  });

  describe('aspect columns', () => {
    it('defaults every aspect column to visible', () => {
      const snap = source!.snapshot();
      assert.strictEqual(snap.aspects.author, true);
      assert.strictEqual(snap.aspects.date, true);
      assert.strictEqual(snap.aspects.revision, true);
    });

    it('reflects a hidden aspect from config', () => {
      setMockConfigValue('intellig', 'blame.showDate', false);
      assert.strictEqual(source!.snapshot().aspects.date, false);
    });

    it('toggleAspect flips the column and returns the new value', async () => {
      assert.strictEqual(source!.snapshot().aspects.author, true);
      const next = await source!.toggleAspect('author');
      assert.strictEqual(next, false);
      assert.strictEqual(source!.snapshot().aspects.author, false);
    });

    it('fires onDidChange when an aspect is toggled', async () => {
      let fired = 0;
      source!.onDidChange(() => fired++);
      await source!.toggleAspect('revision');
      assert.strictEqual(fired, 1);
    });
  });

  describe('author name format', () => {
    it('defaults to full', () => {
      assert.strictEqual(source!.snapshot().authorNameFormat, 'full');
    });

    it('reflects a valid format from config', () => {
      setMockConfigValue('intellig', 'blame.authorNameFormat', 'initials');
      assert.strictEqual(source!.snapshot().authorNameFormat, 'initials');
    });

    it('falls back to full for an unrecognized format', () => {
      setMockConfigValue('intellig', 'blame.authorNameFormat', 'bogus');
      assert.strictEqual(source!.snapshot().authorNameFormat, 'full');
    });

    it('fires onDidChange when the format setting changes', async () => {
      let fired = 0;
      source!.onDidChange(() => fired++);
      await vscode.workspace
        .getConfiguration('intellig.blame')
        .update('authorNameFormat', 'lastname', vscode.ConfigurationTarget.Workspace);
      assert.strictEqual(fired, 1);
    });
  });

  describe('persistence across instances', () => {
    it('re-hydrates hidden revisions from workspaceState on construction', async () => {
      const sha = '5'.repeat(40);
      await source!.hideRevision(sha);
      source!.dispose();

      // Construct a new source over the same memento. Should reload the set.
      const fresh = new BlameOptionsSource(memento);
      try {
        assert.strictEqual(fresh.isHidden(sha), true);
      } finally {
        fresh.dispose();
      }
    });
  });
});

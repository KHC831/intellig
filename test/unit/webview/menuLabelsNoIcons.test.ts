/**
 * Menu labels are words, not pictures.
 *
 * IntelliJ's context menus carry icons in a gutter column, never inside the
 * label text, and an emoji smuggled into a label is what a port reaches for
 * when it wants that column back. This walks every menu definition in both
 * windows, so a new row is covered the day it is written rather than the day
 * someone remembers to add an assertion.
 */

import '../../setup';
import * as assert from 'assert';
import {
  COMMIT_MENU_ITEMS,
  FILE_MENU_ITEMS,
  HISTORY_MENU_ITEMS,
} from '../../../src/git-core/gitToolWindow/webview/menuDefinitions';
import {
  changelistContextMenuLabels,
  fileContextMenuLabels,
} from '../../../src/commits/changelistTab';
import {
  shelfRowContextMenuLabels,
  stashRowContextMenuLabels,
} from '../../../src/commits/shelfTab';
import type { IFileChange } from '../../../src/changelists/interfaces/IChangelistService';

const EMOJI =
  /[\u{1F300}-\u{1F9FF}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{1FA00}-\u{1FAFF}]|[\u{FE00}-\u{FE0F}]|\u{200D}|\u{20E3}/u;

function file(status: IFileChange['status']): IFileChange {
  return { path: 'a.ts', status, staged: false };
}

/** Every menu either window can put on screen, by the name it is known by. */
function allMenus(): Array<{ name: string; labels: string[] }> {
  const labelsOf = (items: ReadonlyArray<{ label?: string }>): string[] =>
    items.map((i) => i.label ?? '').filter((l) => l.length > 0);
  return [
    { name: 'commit', labels: labelsOf(COMMIT_MENU_ITEMS) },
    { name: 'changed file', labels: labelsOf(FILE_MENU_ITEMS) },
    { name: 'revision', labels: labelsOf(HISTORY_MENU_ITEMS) },
    ...(['modified', 'untracked', 'conflicted'] as const).map((status) => ({
      name: `local ${status} file`,
      labels: labelsOf(fileContextMenuLabels(file(status))),
    })),
    ...[
      { isActive: true, isDefault: true },
      { isActive: false, isDefault: false },
    ].map((flags) => ({
      name: `changelist ${JSON.stringify(flags)}`,
      labels: labelsOf(changelistContextMenuLabels(flags)),
    })),
    ...[true, false].map((isAlreadyUnshelved) => ({
      name: `shelf row (unshelved: ${String(isAlreadyUnshelved)})`,
      labels: labelsOf(shelfRowContextMenuLabels({ isAlreadyUnshelved })),
    })),
    { name: 'stash row', labels: labelsOf(stashRowContextMenuLabels()) },
  ];
}

describe('menu labels carry no icons', () => {
  it('covers every menu in both windows', () => {
    // The floor: this is what makes the assertion below evidence rather than a
    // walk over an empty list.
    const menus = allMenus();
    assert.ok(menus.length >= 11, `expected every menu, walked ${menus.length}`);
    for (const menu of menus) {
      assert.ok(menu.labels.length > 0, `${menu.name} contributed no labels`);
    }
    assert.ok(
      menus.reduce((n, m) => n + m.labels.length, 0) >= 60,
      'the commit menu alone is over twenty rows'
    );
  });

  it('has no emoji in any label', () => {
    for (const menu of allMenus()) {
      for (const label of menu.labels) {
        assert.ok(!EMOJI.test(label), `${menu.name}: ${JSON.stringify(label)} carries an icon`);
      }
    }
  });

  describe('character class coverage', () => {
    // A port reaching for an icon is at least as likely to reach for an
    // arrow or a geometric shape, so those ranges are covered too.
    it('catches arrows, geometric shapes, and misc symbols/arrows', () => {
      const iconCandidates = ['→ Run', '▶ Run', '● Run', '■ Run', '⬅ Run'];
      for (const label of iconCandidates) {
        assert.ok(
          EMOJI.test(label),
          `${JSON.stringify(label)} must be flagged as carrying an icon`
        );
      }
    });

    it('does not flag ordinary punctuation these menus actually use (real negative control)', () => {
      // Ellipsis, parens and hyphen are real, current label punctuation in
      // this codebase ('Create Patch…', 'Apply (Unshelve)', 'Cherry-Pick'),
      // so a widening that flags one of these ALSO reds the "has no emoji"
      // walk above — this half of the control is not independent of it.
      for (const char of ['…', '(', ')', '-']) {
        assert.ok(!EMOJI.test(char), `${JSON.stringify(char)} must not be flagged`);
      }
    });

    it('does not flag ordinary punctuation NOT used by any current label (independent control)', () => {
      // None of these appears in any of the 86 real labels across both
      // windows — a widening that flags one of these fails HERE and nowhere
      // else, which is what makes this half of the control independent of
      // the "has no emoji" walk above.
      for (const char of ['—', '>', '/', '&']) {
        assert.ok(!EMOJI.test(char), `${JSON.stringify(char)} must not be flagged`);
      }
    });
  });
});

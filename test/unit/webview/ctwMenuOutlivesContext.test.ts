/**
 * The Commit window's menu is appended to <body>, so nothing removes it when
 * the rows underneath it are replaced. Two ways it can outlive the gesture it
 * belongs to:
 *
 *  - the webview loses the window. VS Code delivers no click to a webview
 *    document when focus leaves the iframe, only `blur`, so the click-away
 *    listener never fires and the menu stays painted over the view;
 *  - a same-repo `updateModel` rebuilds the tree. The retarget guard only
 *    watches the repo root, so a watcher tick, a landed commit or an external
 *    git leaves the menu up, still holding a row that is gone or has changed
 *    kind. Picking then acts on a path the model no longer describes.
 */

import '../../setup';
import * as assert from 'assert';
import {
  buildCommitToolWindowBodyParts,
  buildCommitToolWindowInitModel,
} from '../../../src/commits/CommitToolWindow';
import type { IRenderInput } from '../../../src/commits/ctwInitModel';
import type {
  IChangelist,
  IFileChange,
} from '../../../src/changelists/interfaces/IChangelistService';
import type { IStash } from '../../../src/git-core/interfaces/IGitService';
import type { IShelfItem } from '../../../src/shelf/interfaces/IShelfService';
import { buildShelfTabEntries } from '../../../src/commits/shelfTab';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';

const REPO = '/repos/alpha';
const ITEMS = [{ label: 'Rollback', action: 'rollback' }];

function file(path: string, conflicted = false): IFileChange {
  return { path, status: conflicted ? 'conflicted' : 'modified', staged: false };
}

function stash(index: number, message: string, hash: string): IStash {
  return { index, message, date: new Date(2026, 0, 10 - index), hash };
}

function shelfItem(id: string, name: string): IShelfItem {
  return { id, name, timestamp: new Date(2026, 0, 1), files: [] };
}

/** The Shelf tab. Filtered to whichever source the caller populated. */
function shelfInput(stashes: readonly IStash[], shelves: readonly IShelfItem[] = []): IRenderInput {
  const filter = shelves.length > 0 ? 'shelves' : 'stashes';
  return {
    activeTab: 'shelf',
    changelists: [],
    shelfItems: shelves,
    shelfTabEntries: buildShelfTabEntries(shelves, stashes, filter),
    shelfTabFilter: filter,
    composer: { message: '', amend: false, signOff: false },
    grouping: 'flat',
    repoRoot: REPO,
  };
}

function renderInput(files: readonly IFileChange[], isActive = true): IRenderInput {
  const cl: IChangelist = {
    id: 'default',
    name: 'Changes',
    isDefault: true,
    isActive,
    files: files.slice(),
  };
  return {
    activeTab: 'localChanges',
    changelists: [cl],
    shelfItems: [],
    composer: { message: '', amend: false, signOff: false },
    activeChangelistId: isActive ? 'default' : 'other',
    grouping: 'flat',
    repoRoot: REPO,
  };
}

/** Two changelists, with `files` sitting in whichever `holder` names. */
function twoListInput(files: readonly IFileChange[], holder: string): IRenderInput {
  const list = (id: string, name: string): IChangelist => ({
    id,
    name,
    isDefault: id === 'default',
    isActive: id === 'default',
    files: id === holder ? files.slice() : [],
  });
  return {
    activeTab: 'localChanges',
    changelists: [list('default', 'Changes'), list('other', 'Other')],
    shelfItems: [],
    composer: { message: '', amend: false, signOff: false },
    activeChangelistId: 'default',
    grouping: 'flat',
    repoRoot: REPO,
  };
}

function boot(files: readonly IFileChange[], isActive = true): IWebviewEntryHarness {
  const { body } = buildCommitToolWindowBodyParts(renderInput(files, isActive));
  return bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });
}

/** Push a same-repo refresh: the rows are rebuilt, the repo stamp is unchanged. */
function refresh(h: IWebviewEntryHarness, files: readonly IFileChange[], isActive = true): void {
  h.post({
    type: 'updateModel',
    model: buildCommitToolWindowInitModel(renderInput(files, isActive)),
  });
}

function rightClick(h: IWebviewEntryHarness, path: string): void {
  const row = h.document.querySelector<HTMLElement>(`.ctw-file-row[data-path="${path}"]`);
  assert.ok(row, `row for ${path} must exist`);
  row.dispatchEvent(
    new h.window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
    })
  );
}

function rightClickRow(h: IWebviewEntryHarness, selector: string): void {
  const row = h.document.querySelector<HTMLElement>(selector);
  assert.ok(row, `row ${selector} must exist`);
  row.dispatchEvent(
    new h.window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
    })
  );
}

function answerLastAsk(h: IWebviewEntryHarness, items = ITEMS): void {
  const asks = h.posted.filter(
    (m) => (m as { action?: string }).action === 'contextOpen'
  ) as Array<{ path?: string; changelistId?: string }>;
  const ask = asks[asks.length - 1];
  assert.ok(ask, 'the webview must have asked the host for the menu');
  h.post({
    type: 'showRowContextMenu',
    path: ask.path,
    changelistId: ask.changelistId,
    items,
  });
}

function menuEl(h: IWebviewEntryHarness): HTMLElement | null {
  return h.document.querySelector<HTMLElement>('.context-menu');
}

function picks(h: IWebviewEntryHarness): Array<{ action?: string; path?: string }> {
  return h.posted.filter(
    (m) =>
      (m as { type?: string }).type === 'changelistContextAction' &&
      (m as { action?: string }).action !== 'contextOpen'
  ) as Array<{
    action?: string;
    path?: string;
  }>;
}

/** Right-click the stash row in `index`'s slot and let the host answer. */
function openStashMenu(h: IWebviewEntryHarness, index: number): void {
  const row = h.document.querySelector<HTMLElement>(`.ctw-shelf-row[data-stash-index="${index}"]`);
  assert.ok(row, `stash row ${index} exists`);
  row.dispatchEvent(
    new h.window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
    })
  );
  const asks = h.posted.filter(
    (m) => (m as { action?: string }).action === 'contextOpen'
  ) as Array<{ rowKind?: string; stashIndex?: number }>;
  const ask = asks[asks.length - 1];
  assert.ok(ask, 'the webview asked the host for the menu');
  h.post({
    type: 'showRowContextMenu',
    rowKind: ask.rowKind,
    stashIndex: ask.stashIndex,
    items: [{ label: 'Drop', action: 'stashDrop', danger: true }],
  });
}

describe('webview: the Commit window menu does not outlive its context (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('closes when the webview loses the window', () => {
    h = boot([file('src/index.ts')]);
    rightClick(h, 'src/index.ts');
    answerLastAsk(h);
    assert.strictEqual(menuEl(h)?.hidden, false, 'the menu is open');

    h.window.dispatchEvent(new h.window.Event('blur'));

    assert.ok(menuEl(h)?.hidden, 'clicking into the editor leaves no menu painted over the view');
  });

  it('does not act on a row a same-repo refresh removed', () => {
    h = boot([file('a.ts'), file('b.ts')]);
    rightClick(h, 'a.ts');
    answerLastAsk(h);

    refresh(h, [file('b.ts')]);
    assert.ok(
      !h.document.querySelector('.ctw-file-row[data-path="a.ts"]'),
      'the row the menu was opened on is gone'
    );
    h.posted.length = 0;

    assert.ok(menuEl(h)?.hidden, 'the menu box goes with the row, not just the action');
    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();

    assert.deepStrictEqual(picks(h), [], 'a pick on a vanished row posts nothing');
  });

  it('survives a refresh that redraws the same row', () => {
    // The positive control for the two tests above: a watcher tick, a landed
    // commit and an external git all arrive as an ordinary updateModel. If the
    // staleness rule keyed on the ELEMENT rather than the row's identity, the
    // menu would close under the user on every one of them — the reason the
    // repo-retarget guard was written narrow in the first place.
    h = boot([file('a.ts'), file('b.ts')]);
    rightClick(h, 'a.ts');
    answerLastAsk(h);

    refresh(h, [file('a.ts'), file('b.ts')]);

    assert.strictEqual(menuEl(h)?.hidden, false, 'the menu stays open');
    h.posted.length = 0;
    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();
    assert.deepStrictEqual(
      picks(h).map((p) => [p.action, p.path]),
      [['rollback', 'a.ts']],
      'and still acts on its own row'
    );
  });

  it('does not act on a stash the stack renumbered under it', () => {
    // A stash is addressed by POSITION, and positions shift: popping one
    // elsewhere renumbers the whole stack down. A menu opened on stash@{2}
    // that survives the renumbering drops whatever now sits at index 2 — a
    // stash the user never right-clicked. The repo already knows this shape:
    // preservedChanges pins by sha because stash@{0} is not stable.
    const before = [
      stash(0, 'WIP: alpha', 'aaa1111'),
      stash(1, 'WIP: beta', 'bbb2222'),
      stash(2, 'WIP: gamma', 'ccc3333'),
      stash(3, 'WIP: delta', 'ddd4444'),
    ];
    const { body } = buildCommitToolWindowBodyParts(shelfInput(before));
    h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });

    const row = h.document.querySelector<HTMLElement>('.ctw-shelf-row[data-stash-index="2"]');
    assert.ok(row, 'the stash row exists');
    assert.match(row.textContent ?? '', /gamma/, 'and it is the one the user aimed at');
    row.dispatchEvent(
      new h.window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100,
      })
    );
    const asks = h.posted.filter(
      (m) => (m as { action?: string }).action === 'contextOpen'
    ) as Array<{ rowKind?: string; stashIndex?: number }>;
    const ask = asks[asks.length - 1];
    assert.ok(ask, 'the webview asked the host for the menu');
    h.post({
      type: 'showRowContextMenu',
      rowKind: ask.rowKind,
      stashIndex: ask.stashIndex,
      items: [{ label: 'Drop', action: 'stashDrop', danger: true }],
    });
    assert.strictEqual(menuEl(h)?.hidden, false, 'the menu is open on WIP: gamma');

    // stash@{0} is popped elsewhere; everything renumbers down by one.
    const after = [
      stash(0, 'WIP: beta', 'bbb2222'),
      stash(1, 'WIP: gamma', 'ccc3333'),
      stash(2, 'WIP: delta', 'ddd4444'),
    ];
    h.post({ type: 'updateModel', model: buildCommitToolWindowInitModel(shelfInput(after)) });
    assert.match(
      h.document.querySelector('.ctw-shelf-row[data-stash-index="2"]')?.textContent ?? '',
      /delta/,
      'index 2 now names a different stash'
    );
    h.posted.length = 0;

    assert.ok(menuEl(h)?.hidden, 'the menu closes when its stash moves slot');
    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();

    assert.deepStrictEqual(
      h.posted.filter((m) => (m as { type?: string }).type === 'shelfTabContextAction'),
      [],
      'the drop does not fire on the stash that moved into the slot'
    );
  });

  it('tells two identically-named stashes apart by sha', () => {
    // `git stash push -m wip` twice gives two rows with the same message, so
    // the rendered name cannot discriminate them. Only the sha can, which is
    // why it is on the row at all.
    const before = [
      stash(0, 'wip', 'aaa1111'),
      stash(1, 'wip', 'bbb2222'),
      stash(2, 'WIP: other', 'ccc3333'),
    ];
    const { body } = buildCommitToolWindowBodyParts(shelfInput(before));
    h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });

    openStashMenu(h, 0);
    assert.strictEqual(menuEl(h)?.hidden, false, 'the menu is open on the first "wip"');

    // The first is popped elsewhere; the OTHER "wip" slides into slot 0.
    h.post({
      type: 'updateModel',
      model: buildCommitToolWindowInitModel(
        shelfInput([stash(0, 'wip', 'bbb2222'), stash(1, 'WIP: other', 'ccc3333')])
      ),
    });
    assert.strictEqual(
      h.document
        .querySelector('.ctw-shelf-row[data-stash-index="0"]')
        ?.getAttribute('data-stash-sha'),
      'bbb2222',
      'slot 0 now holds the other stash'
    );
    h.posted.length = 0;

    assert.ok(menuEl(h)?.hidden, 'the menu closes even though the name is unchanged');
    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();
    assert.deepStrictEqual(
      h.posted.filter((m) => (m as { type?: string }).type === 'shelfTabContextAction'),
      [],
      'and the drop does not land on the survivor'
    );
  });

  it('leaves a stash menu open when the list is redrawn unchanged', () => {
    // The positive control for the two stash tests: the Shelf tab refreshes
    // like everything else, and a menu that closed on every tick would be its
    // own bug.
    const stashes = [stash(0, 'WIP: alpha', 'aaa1111'), stash(1, 'WIP: beta', 'bbb2222')];
    const { body } = buildCommitToolWindowBodyParts(shelfInput(stashes));
    h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });

    openStashMenu(h, 1);
    h.post({ type: 'updateModel', model: buildCommitToolWindowInitModel(shelfInput(stashes)) });

    assert.strictEqual(menuEl(h)?.hidden, false, 'the menu survives an ordinary refresh');
    h.posted.length = 0;
    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();
    assert.deepStrictEqual(
      h.posted
        .filter((m) => (m as { type?: string }).type === 'shelfTabContextAction')
        .map((m) => (m as { stashIndex?: number }).stashIndex),
      [1],
      'and still acts on its own stash'
    );
  });

  it('closes when the host switches the view to the other tab', () => {
    // The row survives a tab switch — it is still in the document, inside a
    // panel that is now display:none. A menu anchored to it is left floating
    // over the tab the user is now looking at, and still acting. A tab the
    // USER clicks is a click, so click-away already covers that; this is the
    // host switching tabs under them (Shelve from the palette, say).
    h = boot([file('a.ts')]);
    rightClick(h, 'a.ts');
    answerLastAsk(h);
    assert.strictEqual(menuEl(h)?.hidden, false, 'the menu is open');

    h.post({
      type: 'updateModel',
      model: buildCommitToolWindowInitModel({ ...renderInput([file('a.ts')]), activeTab: 'shelf' }),
    });

    assert.strictEqual(
      h.document.querySelector<HTMLElement>('[data-panel="localChanges"]')?.style.display,
      'none',
      'the panel holding the row is hidden'
    );
    assert.ok(menuEl(h)?.hidden, 'so its menu goes with it');
    h.posted.length = 0;
    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();
    assert.deepStrictEqual(picks(h), [], 'and nothing fires from the other tab');
  });

  it('draws nothing when the row goes while the host is still answering', () => {
    // The reply is async. If the row it describes is gone by the time it
    // lands, there is nothing to anchor a menu to, and drawing one would put
    // a dead target under the pointer.
    h = boot([file('a.ts'), file('b.ts')]);
    rightClick(h, 'a.ts');
    refresh(h, [file('b.ts')]);

    answerLastAsk(h);

    const menu = menuEl(h);
    assert.ok(!menu || menu.hidden, 'no menu opens for a row that has left');
  });

  it('closes a shelf menu when the entry becomes already-unshelved', () => {
    // The shelf menu grows a Restore row once an entry has been unshelved, so
    // a menu built before that happened is missing an action the row now
    // offers. The entry keeps its id, which is why the flag has to be part of
    // what identifies the row.
    const fresh: IShelfItem[] = [shelfItem('s1', 'Feature work')];
    const { body } = buildCommitToolWindowBodyParts(shelfInput([], fresh));
    h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });

    const row = h.document.querySelector<HTMLElement>('.ctw-shelf-row[data-shelf-id="s1"]');
    assert.ok(row, 'the shelf row exists');
    row.dispatchEvent(
      new h.window.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100,
      })
    );
    const asks = h.posted.filter(
      (m) => (m as { action?: string }).action === 'contextOpen'
    ) as Array<{ rowKind?: string; shelfId?: string }>;
    const ask = asks[asks.length - 1];
    assert.ok(ask, 'the webview asked the host for the menu');
    h.post({
      type: 'showRowContextMenu',
      rowKind: ask.rowKind,
      shelfId: ask.shelfId,
      items: [{ label: 'Unshelve', action: 'shelfUnshelve' }],
    });
    assert.strictEqual(menuEl(h)?.hidden, false, 'the menu is open');

    const unshelved: IShelfItem[] = [
      { ...shelfItem('s1', 'Feature work'), unshelvedAt: new Date(2026, 0, 2) },
    ];
    h.post({
      type: 'updateModel',
      model: buildCommitToolWindowInitModel(shelfInput([], unshelved)),
    });

    assert.ok(
      h.document.querySelector('.ctw-shelf-alreadyUnshelved'),
      'the row now says already unshelved'
    );
    assert.ok(menuEl(h)?.hidden, 'and the menu built before that closes');
  });

  it('closes a file menu when the file moves to another changelist', () => {
    // Move to Another Changelist… is on this very menu, and on the Git tool
    // window's. The row keeps its path and moves to a different block, so the
    // menu built for it in the old list would otherwise stay up over a row
    // that now belongs somewhere else.
    const files = [file('a.ts')];
    const { body } = buildCommitToolWindowBodyParts(twoListInput(files, 'default'));
    h = bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });

    rightClick(h, 'a.ts');
    answerLastAsk(h);
    assert.strictEqual(menuEl(h)?.hidden, false, 'the menu is open');

    h.post({
      type: 'updateModel',
      model: buildCommitToolWindowInitModel(twoListInput(files, 'other')),
    });

    assert.strictEqual(
      h.document.querySelector('.ctw-file-row[data-path="a.ts"]')?.getAttribute('data-changelist'),
      'other',
      'the file now sits in the other list'
    );
    assert.ok(menuEl(h)?.hidden, 'and its menu goes with it');
    h.posted.length = 0;
    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();
    assert.deepStrictEqual(picks(h), [], 'nothing fires for the old list');
  });

  it('closes a changelist menu when that list becomes the active one', () => {
    // Set Active is disabled once the list is already active, so a menu built
    // before that happened offers an action the row no longer takes.
    h = boot([file('a.ts')], false);
    rightClickRow(h, '.ctw-changelist-row[data-changelist="default"]');
    answerLastAsk(h, [{ label: 'Set Active Changelist', action: 'setActive' }]);
    assert.strictEqual(menuEl(h)?.hidden, false, 'the menu is open');

    refresh(h, [file('a.ts')], true);

    assert.ok(
      h.document.querySelector('.ctw-changelist-row .ctw-changelist-active'),
      'the list is now active'
    );
    assert.ok(menuEl(h)?.hidden, 'and the menu built before that closes');
  });

  it('leaves a changelist menu open when the list is redrawn unchanged', () => {
    // The positive control for the arm above.
    h = boot([file('a.ts')], false);
    rightClickRow(h, '.ctw-changelist-row[data-changelist="default"]');
    answerLastAsk(h, [{ label: 'Set Active Changelist', action: 'setActive' }]);

    refresh(h, [file('a.ts')], false);

    assert.strictEqual(menuEl(h)?.hidden, false, 'an ordinary refresh leaves it alone');
  });

  for (const menu of [
    { name: 'gear menu', trigger: '.ctw-gear', panel: '.ctw-gear-menu' },
    { name: 'commit dropdown', trigger: '.ctw-btn-commit-dropdown', panel: '.ctw-primary-menu' },
  ]) {
    it(`closes the ${menu.name} when the click lands elsewhere`, () => {
      // Every menu in this window closes on an outside click; these two are
      // menus too, even though they hang off a button rather than a row.
      h = boot([file('a.ts')]);
      const trigger = h.document.querySelector<HTMLElement>(menu.trigger);
      const panel = h.document.querySelector<HTMLElement>(menu.panel);
      assert.ok(trigger && panel, `${menu.name} must be rendered`);

      trigger.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      assert.strictEqual(panel.hidden, false, 'the trigger opens it');

      h.document.body.dispatchEvent(
        new h.window.MouseEvent('click', { bubbles: true, cancelable: true })
      );

      assert.ok(panel.hidden, 'a click elsewhere closes it');
    });

    it(`closes the ${menu.name} when the webview loses the window`, () => {
      h = boot([file('a.ts')]);
      const trigger = h.document.querySelector<HTMLElement>(menu.trigger);
      const panel = h.document.querySelector<HTMLElement>(menu.panel);
      assert.ok(trigger && panel);
      trigger.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      assert.strictEqual(panel.hidden, false, 'the trigger opens it');

      h.window.dispatchEvent(new h.window.Event('blur'));

      assert.ok(panel.hidden, 'it does not stay painted over the view');
    });

    it(`closes the ${menu.name} on Escape`, () => {
      // Escape is a global dismiss key; it must answer every menu this
      // window has, not just the row context menu.
      h = boot([file('a.ts')]);
      const trigger = h.document.querySelector<HTMLElement>(menu.trigger);
      const panel = h.document.querySelector<HTMLElement>(menu.panel);
      assert.ok(trigger && panel, `${menu.name} must be rendered`);
      trigger.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      assert.strictEqual(panel.hidden, false, 'the trigger opens it');

      h.document.dispatchEvent(
        new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );

      assert.ok(panel.hidden, 'Escape must close it too');
    });
  }

  it('closes an open gear menu when a right-click opens the row context menu', () => {
    // The gear/commit-dropdown panels are plain divs owned by
    // ctwButtonMenus.ts, outside the ContextMenu widget registry, so
    // rememberClick's own hide() cannot see them. Without its own
    // closeButtonMenus() call, a right-click left the gear menu painted
    // beside the new row context menu.
    h = boot([file('a.ts')]);
    const gear = h.document.querySelector<HTMLElement>('.ctw-gear');
    const gearPanel = h.document.querySelector<HTMLElement>('.ctw-gear-menu');
    assert.ok(gear && gearPanel, 'gear menu must be rendered');
    gear.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.strictEqual(gearPanel.hidden, false, 'the gear menu is open');

    rightClick(h, 'a.ts');

    assert.ok(gearPanel.hidden, 'the right-click must close the gear menu too');
  });

  it('opening one button menu closes the other', () => {
    // Only one menu is ever up. The trigger's own click is spared so it can
    // toggle its panel, and sparing it must not spare every OTHER panel too.
    h = boot([file('a.ts')]);
    const gear = h.document.querySelector<HTMLElement>('.ctw-gear');
    const gearPanel = h.document.querySelector<HTMLElement>('.ctw-gear-menu');
    const dropdown = h.document.querySelector<HTMLElement>('.ctw-btn-commit-dropdown');
    const pushPanel = h.document.querySelector<HTMLElement>('.ctw-primary-menu');
    assert.ok(gear && gearPanel && dropdown && pushPanel);

    gear.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.strictEqual(gearPanel.hidden, false, 'the gear menu is open');

    dropdown.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    assert.strictEqual(pushPanel.hidden, false, 'the dropdown opens');
    assert.ok(gearPanel.hidden, 'and the gear menu does not stay up beside it');
  });

  it('a second click on the trigger closes its own menu', () => {
    // The dismissal runs in capture phase, BEFORE the trigger's own toggle.
    // If it closed the panel whose trigger was clicked, the toggle would flip
    // it straight back open and the button could never close its own menu.
    h = boot([file('a.ts')]);
    const gear = h.document.querySelector<HTMLElement>('.ctw-gear');
    const panel = h.document.querySelector<HTMLElement>('.ctw-gear-menu');
    assert.ok(gear && panel);

    gear.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.strictEqual(panel.hidden, false, 'first click opens');

    gear.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    assert.strictEqual(panel.hidden, true, 'second click closes');
  });

  it('a click inside a button menu leaves it open', () => {
    // The positive control: the dismissal must not close a panel the user is
    // reaching into, or its own items become unclickable.
    h = boot([file('a.ts')]);
    const gear = h.document.querySelector<HTMLElement>('.ctw-gear');
    const gearPanel = h.document.querySelector<HTMLElement>('.ctw-gear-menu');
    assert.ok(gear && gearPanel);
    gear.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    gearPanel.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    assert.strictEqual(gearPanel.hidden, false, 'clicking into the panel keeps it open');
  });

  it('does not accept a conflict side for a file that is no longer conflicted', () => {
    // The sharpest case: the menu on a conflicted row carries Accept Theirs,
    // an external `git checkout --theirs` on a path git no longer reports
    // unmerged. Resolving in another terminal arrives as an ordinary refresh.
    h = boot([file('a.ts', true)]);
    rightClick(h, 'a.ts');
    answerLastAsk(h, [{ label: 'Accept Theirs', action: 'acceptTheirs' }]);

    refresh(h, [file('a.ts')]);
    assert.ok(
      !h.document.querySelector('.ctw-file-row[data-path="a.ts"].ctw-file-conflicted'),
      'the row is no longer conflicted'
    );
    h.posted.length = 0;

    assert.ok(menuEl(h)?.hidden, 'the menu closes rather than lingering over a resolved row');
    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();

    assert.deepStrictEqual(picks(h), [], 'the conflict action does not fire');
  });
});

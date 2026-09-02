/**
 * A context-menu pick acts on the row and the repository the menu was opened
 * on — not on whatever the view happens to be showing when the pick lands.
 *
 * The menu is a two-message conversation: the right-click asks the host what
 * the menu contains, and the pick is a second, later message. Everything the
 * pick needs to identify its target therefore has to be captured at the
 * gesture, because the view can retarget underneath an open menu.
 */

import '../../setup';
import * as assert from 'assert';
import { buildCommitToolWindowBodyParts } from '../../../src/commits/CommitToolWindow';
import type {
  IChangelist,
  IFileChange,
} from '../../../src/changelists/interfaces/IChangelistService';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';

const REPO_A = '/repos/alpha';
const REPO_B = '/repos/beta';

function file(path: string): IFileChange {
  return { path, status: 'modified', staged: false };
}

function boot(paths: string[]): IWebviewEntryHarness {
  const changelist: IChangelist = {
    id: 'default',
    name: 'Changes',
    isDefault: true,
    isActive: true,
    files: paths.map(file),
  };
  const { body } = buildCommitToolWindowBodyParts({
    activeTab: 'localChanges',
    changelists: [changelist],
    shelfItems: [],
    composer: { message: '', amend: false, signOff: false },
    activeChangelistId: 'default',
    repoRoot: REPO_A,
  });
  return bootWebviewEntry('commits/webview/commitToolWindow', { bodyHtml: body });
}

const ITEMS = [{ label: 'Rollback', action: 'rollback' }];

function rightClick(h: IWebviewEntryHarness, path: string, x = 100, y = 100): void {
  const row = h.document.querySelector<HTMLElement>(`.ctw-file-row[data-path="${path}"]`);
  assert.ok(row, `row for ${path} must exist`);
  row.dispatchEvent(
    new h.window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    })
  );
}

/**
 * Answer the last right-click the way the host does: echoing back the identity
 * fields it was asked about, so the reply is matched to its own request.
 */
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

/** Answer a right-click that is no longer the pending one. */
function answerAskFor(h: IWebviewEntryHarness, path: string): void {
  const ask = (
    h.posted.filter((m) => (m as { action?: string }).action === 'contextOpen') as Array<{
      path?: string;
      changelistId?: string;
    }>
  ).find((a) => a.path === path);
  assert.ok(ask, `the webview must have asked about ${path}`);
  h.post({
    type: 'showRowContextMenu',
    path: ask.path,
    changelistId: ask.changelistId,
    items: ITEMS,
  });
}

function picks(h: IWebviewEntryHarness): Array<{ path?: string; repoRoot?: string }> {
  return h.posted.filter(
    (m) => (m as { type?: string }).type === 'changelistContextAction'
  ) as Array<{ path?: string; repoRoot?: string }>;
}

describe('webview: Commit window menu targeting (jsdom)', () => {
  let h: IWebviewEntryHarness;

  afterEach(() => {
    if (h) {
      h.dispose();
    }
  });

  it('stamps the pick with the repo the row was rendered from', () => {
    // The stamp is taken at the gesture and the host drops an action whose
    // stamp does not match what the view shows. It is the SECOND line of
    // defence: a retarget already hides the menu, so no pick survives one to
    // compare the two readings. This pins the stamp is present and right; the
    // hide that makes it unreachable is pinned below.
    h = boot(['src/index.ts']);
    rightClick(h, 'src/index.ts');
    answerLastAsk(h);
    h.posted.length = 0;

    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();

    const sent = picks(h);
    assert.strictEqual(sent.length, 1, 'the pick is posted');
    assert.strictEqual(
      sent[0].repoRoot,
      REPO_A,
      'the pick belongs to the repo whose row was clicked'
    );
  });

  it('posts nothing at all once the view has retargeted', () => {
    // Retargeting closes the menu, so this is not a stamp question any more:
    // there is no gesture left to complete. Pinned as a pick because the menu
    // element survives being hidden, and a stray click on it must not reach
    // the host.
    h = boot(['src/index.ts']);
    rightClick(h, 'src/index.ts');
    answerLastAsk(h);

    h.post({ type: 'updateModel', model: { changelists: [], shelfItems: [], repoRoot: REPO_B } });
    h.posted.length = 0;

    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();

    assert.deepStrictEqual(picks(h), [], 'a rollback cannot land in a repo the user left');
  });

  it('closes the menu when the view retargets to another repo', () => {
    h = boot(['src/index.ts']);
    rightClick(h, 'src/index.ts');
    answerLastAsk(h);
    assert.strictEqual(
      h.document.querySelector<HTMLElement>('.context-menu')?.hidden,
      false,
      'the menu is open'
    );

    h.post({ type: 'updateModel', model: { changelists: [], shelfItems: [], repoRoot: REPO_B } });

    assert.ok(
      h.document.querySelector<HTMLElement>('.context-menu')?.hidden,
      'a menu anchored to the previous repo must not stay up'
    );
  });

  it('cancels a right-click with Escape while the host is still answering', () => {
    // The host's reply is async. A user who right-clicks, changes their mind
    // and presses Escape must not have the menu appear afterwards at the
    // pointer position of a gesture they abandoned. Nothing is drawn yet, so
    // the shared key router has no open menu to answer — this is the Commit
    // window's own pending state.
    h = boot(['src/index.ts']);
    rightClick(h, 'src/index.ts');

    h.document.dispatchEvent(
      new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    answerLastAsk(h);

    const menu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(!menu || menu.hidden, 'an abandoned right-click must not open a menu');
  });

  it('hands focus back to the row when the menu is dismissed', () => {
    h = boot(['src/index.ts']);
    const row = h.document.querySelector<HTMLElement>('.ctw-file-row[data-path="src/index.ts"]');
    assert.ok(row);
    rightClick(h, 'src/index.ts');
    answerLastAsk(h);

    (h.document.activeElement ?? h.document).dispatchEvent(
      new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );

    assert.strictEqual(
      h.document.activeElement,
      row,
      'focus goes back to the row, not to <body> in the middle of a commit message'
    );
  });

  it('drops a menu reply that does not match the right-click still pending', () => {
    // Both replies are in flight: the host awaits the active changelist, so a
    // second right-click can overtake the first. The rows look identical, so a
    // menu drawn for a.txt under the pointer at b.txt is invisible to the user
    // and rolls back the wrong file.
    h = boot(['a.txt', 'b.txt']);
    rightClick(h, 'a.txt', 50, 50);
    rightClick(h, 'b.txt', 200, 300);

    // a.txt's reply lands first, for a right-click that is no longer pending.
    answerAskFor(h, 'a.txt');
    const menu = h.document.querySelector<HTMLElement>('.context-menu');
    assert.ok(!menu || menu.hidden, 'the stale reply must not open a menu');

    // b.txt's reply still opens its own menu.
    answerAskFor(h, 'b.txt');
    assert.strictEqual(
      h.document.querySelector<HTMLElement>('.context-menu')?.hidden,
      false,
      'the pending right-click is still answered'
    );
    h.posted.length = 0;

    h.document.querySelector<HTMLElement>('.context-menu-item')?.click();
    assert.strictEqual(picks(h)[0]?.path, 'b.txt', 'and it acts on the row it was opened on');
  });
});

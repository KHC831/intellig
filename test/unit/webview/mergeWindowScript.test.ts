/**
 * Webview client-script tests for the merge window
 * (src/conflicts/merge-window/webview/main.ts, shipped as media/mergeWindow.js).
 *
 * Runs the real module under jsdom with a stubbed `monaco` global: boots it,
 * delivers the init message, and drives the toolbar/gutter buttons — so the
 * "button does nothing" class of bug (invisible to every other lane) is
 * assertable in CI. jsdom does not lay out or paint, so connector geometry
 * and pixel positions stay on the F5 lane.
 */

import '../../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { createMonacoStub, StubEditor } from '../../helpers/monacoStub';

type ActionKind = 'apply' | 'ignore' | 'revert';

interface IMergeWindowFixture {
  document: Document;
  posted: unknown[];
  /** [left, result, right] */
  editors: StubEditor[];
  flush(): Promise<void>;
  click(id: string): Promise<void>;
  /** Clicks the nth action icon of that kind in a side pane's action strip. */
  clickAction(pane: 'left' | 'right', kind: ActionKind, nth?: number): Promise<void>;
  /** The action icons of that kind in a side pane's divider-hugging strip. */
  actionButtons(pane: 'left' | 'right', kind: ActionKind): HTMLElement[];
  resultText(): string;
  counterText(): string;
  /** Keyboard undo/redo (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z) via the result editor. */
  undo(): Promise<void>;
  redo(): Promise<void>;
  dispose(): void;
}

const MAIN_MODULE = '../../../src/conflicts/merge-window/webview/main';

function bootMergeWindow(left: string, base: string, right: string): IMergeWindowFixture {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const posted: unknown[] = [];
  const { stub, editors } = createMonacoStub();

  const g = global as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.monaco = stub;
  g.acquireVsCodeApi = (): { postMessage(m: unknown): void } => ({
    postMessage: (m: unknown): void => {
      posted.push(m);
    },
  });

  delete require.cache[require.resolve(MAIN_MODULE)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(MAIN_MODULE) as { boot(): void };
  mod.boot();

  // jsdom has no canvas backend; the script skips connectors when the canvas
  // is absent, so drop the DOM-built canvases rather than spam
  // "Not implemented" to the console.
  for (const canvas of Array.from(dom.window.document.querySelectorAll('canvas'))) {
    canvas.remove();
  }

  dom.window.dispatchEvent(
    new dom.window.MessageEvent('message', {
      data: {
        type: 'init',
        left,
        base,
        right,
        leftLabel: 'Yours (main)',
        rightLabel: 'Theirs (feature)',
        fileName: 'a.txt',
      },
    })
  );

  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
  };

  const doc = dom.window.document;

  const actionButtons = (pane: 'left' | 'right', kind: ActionKind): HTMLElement[] => {
    const strip = doc.getElementById(pane === 'left' ? 'action-left' : 'action-right');
    assert.ok(strip, `missing the ${pane} action strip`);
    return Array.from(strip.querySelectorAll(`.action-btn.${kind}`));
  };

  return {
    document: doc,
    posted,
    editors,
    flush,
    click: async (id: string): Promise<void> => {
      const el = doc.getElementById(id);
      assert.ok(el, `missing #${id}`);
      el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await flush();
    },
    actionButtons,
    clickAction: async (
      pane: 'left' | 'right',
      kind: ActionKind,
      nth: number = 0
    ): Promise<void> => {
      const buttons = actionButtons(pane, kind);
      assert.ok(buttons.length > nth, `expected a ${kind} icon #${nth} in the ${pane} strip`);
      buttons[nth].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await flush();
    },
    undo: async (): Promise<void> => {
      editors[1].runCommand(2048 | 56); // CtrlCmd+KeyZ
      await flush();
    },
    redo: async (): Promise<void> => {
      editors[1].runCommand(2048 | 1024 | 56); // CtrlCmd+Shift+KeyZ
      await flush();
    },
    resultText: (): string => editors[1].getModel().getValue(),
    counterText: (): string => doc.getElementById('counter')?.textContent ?? '',
    dispose: (): void => {
      delete g.window;
      delete g.document;
      delete g.monaco;
      delete g.acquireVsCodeApi;
      dom.window.close();
    },
  };
}

const LEFT = 'L1 changed\nmid\nconf left\nmid2\nend';
const BASE = 'L1\nmid\nconf base\nmid2\nend';
const RIGHT = 'L1\nmid\nconf right\nmid2\nend';
/** BASE after the one-sided L1 change is applied from the left gutter. */
const AFTER_NC_APPLY = 'L1 changed\nmid\nconf base\nmid2\nend';

describe('webview: merge window script (jsdom + monaco stub)', () => {
  let f: IMergeWindowFixture;

  afterEach(() => {
    f.dispose();
  });

  it('boots with the untouched base; nothing is applied on open', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    assert.ok(f.posted.some((m) => (m as { type?: string }).type === 'ready'));
    assert.strictEqual(f.editors.length, 3);
    assert.strictEqual(f.resultText(), BASE);
    assert.strictEqual(f.counterText(), '2 of 2 changes remaining');
    assert.strictEqual(f.document.getElementById('left-title')?.textContent, 'Yours (main)');
    // Nothing happened yet → Reset greyed out; no undo/redo or bulk-apply
    // buttons exist (undo stays on the keyboard).
    assert.strictEqual(
      (f.document.getElementById('btn-reset') as HTMLButtonElement).disabled,
      true
    );
    assert.strictEqual(f.document.getElementById('btn-undo'), null);
    assert.strictEqual(f.document.getElementById('btn-redo'), null);
    assert.strictEqual(f.document.getElementById('btn-nc-all'), null);
    // Apply stays greyed out until every change is resolved.
    assert.strictEqual(
      (f.document.getElementById('btn-apply') as HTMLButtonElement).disabled,
      true
    );
    // Left strip: the left-side change + the conflict; right strip: conflict
    // only. The connector dividers themselves carry no buttons.
    assert.strictEqual(f.actionButtons('left', 'apply').length, 2);
    assert.strictEqual(f.actionButtons('left', 'ignore').length, 2);
    assert.strictEqual(f.actionButtons('right', 'apply').length, 1);
    assert.strictEqual(
      f.document.querySelectorAll('#gutter-left button, #gutter-right button').length,
      0
    );
  });

  it('a gutter symbol applies a one-sided change as one keyboard-undo step', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    await f.clickAction('left', 'apply', 0);
    assert.strictEqual(f.resultText(), AFTER_NC_APPLY);
    assert.strictEqual(f.counterText(), '1 of 2 changes remaining');

    await f.undo();
    assert.strictEqual(f.resultText(), BASE);
    assert.strictEqual(f.counterText(), '2 of 2 changes remaining');

    await f.redo();
    assert.strictEqual(f.resultText(), AFTER_NC_APPLY);
    assert.strictEqual(f.counterText(), '1 of 2 changes remaining');
  });

  it('gutter apply takes a conflict side; the opposite side then appends', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();
    await f.clickAction('left', 'apply', 0);

    await f.clickAction('right', 'apply');
    assert.strictEqual(f.resultText(), 'L1 changed\nmid\nconf right\nmid2\nend');
    assert.strictEqual(f.counterText(), '1 of 2 changes remaining');

    await f.clickAction('left', 'apply');
    assert.strictEqual(f.resultText(), 'L1 changed\nmid\nconf right\nconf left\nmid2\nend');
    assert.strictEqual(f.counterText(), 'All changes processed');
    assert.ok(f.document.getElementById('banner')?.classList.contains('visible'));
    assert.strictEqual(
      (f.document.getElementById('btn-apply') as HTMLButtonElement).disabled,
      false
    );
  });

  it('gutter ignore resolves a conflict side without touching the result', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();
    await f.clickAction('left', 'apply', 0);

    await f.clickAction('left', 'ignore');
    assert.strictEqual(f.resultText(), AFTER_NC_APPLY);
    assert.strictEqual(f.counterText(), '1 of 2 changes remaining');

    await f.clickAction('right', 'ignore');
    assert.strictEqual(f.resultText(), AFTER_NC_APPLY);
    assert.strictEqual(f.counterText(), 'All changes processed');
  });

  it('conflicts are NOT auto-resolved on open, even simple ones', async () => {
    f = bootMergeWindow('version: 2.0.0', 'version: 1.0.0', 'version: 1.0.4');
    await f.flush();

    assert.strictEqual(f.resultText(), 'version: 1.0.0');
    assert.strictEqual(f.counterText(), '1 of 1 changes remaining');
    // Nothing auto-applied → nothing to reset.
    assert.strictEqual(
      (f.document.getElementById('btn-reset') as HTMLButtonElement).disabled,
      true
    );
  });

  it('user edits in the result editor reach the merge document', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    // Simulate typing: an edit applied to the Monaco model (not via the doc).
    f.editors[1].getModel().applyRawEdits([{ offset: 0, end: 2, text: 'XX' }]);
    await f.flush();

    // Apply is locked while anything is unresolved — even via a
    // programmatic click on the disabled button.
    await f.click('btn-apply');
    assert.ok(!f.posted.some((m) => (m as { type?: string }).type === 'apply'));

    // Resolve everything by ignoring (does not touch the edited text).
    await f.clickAction('left', 'ignore', 0); // the edited one-sided change
    await f.clickAction('left', 'ignore', 0); // conflict, left side
    await f.clickAction('right', 'ignore', 0); // conflict, right side
    assert.strictEqual(f.counterText(), 'All changes processed');

    await f.click('btn-apply');
    const apply = f.posted.find((m) => (m as { type?: string }).type === 'apply') as
      | { resultText?: string }
      | undefined;
    assert.ok(apply);
    assert.strictEqual(apply.resultText, 'XX\nmid\nconf base\nmid2\nend');
  });

  it('Accept Theirs takes the whole right version', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    await f.click('btn-accept-right');
    assert.strictEqual(f.resultText(), RIGHT);
    assert.strictEqual(f.counterText(), 'All changes processed');
  });

  it('a resolved change shows a revert icon that restores the base', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();
    await f.clickAction('left', 'apply', 0);

    // The applied non-conflict is resolved → its action pair becomes a
    // revert icon in the side strip.
    assert.strictEqual(f.actionButtons('left', 'revert').length, 1);

    await f.clickAction('left', 'revert');
    assert.strictEqual(f.resultText(), BASE);
    assert.strictEqual(f.counterText(), '2 of 2 changes remaining');
    assert.strictEqual(f.actionButtons('left', 'revert').length, 0);
  });

  it('resolved changes render as boundary lines, not fills', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();
    await f.clickAction('left', 'apply', 0);

    // The applied change is resolved → dotted boundary classes; the
    // conflict is unresolved → filled highlight.
    const resultDecos = f.editors[1].collections[0].decorations as Array<{
      options: { className?: string };
    }>;
    const classes = resultDecos.map((d) => d.options.className ?? '');
    assert.ok(classes.some((c) => c.includes('merge-resolved-top')));
    assert.ok(classes.some((c) => c.includes('merge-conflict')));
    assert.ok(!classes.some((c) => c.includes('merge-resolved ') || c === 'merge-resolved'));
  });

  it('the result gutter wand magic-resolves a conflict on demand', async () => {
    f = bootMergeWindow('version: 2.0.0', 'version: 1.0.0', 'version: 1.0.4');
    await f.flush();

    const resultDecos = f.editors[1].collections[0].decorations as Array<{
      options: { glyphMarginClassName?: string };
    }>;
    assert.ok(resultDecos.some((d) => d.options.glyphMarginClassName === 'merge-glyph-magic'));

    f.editors[1].clickGlyphMargin(1);
    await f.flush();
    assert.strictEqual(f.resultText(), 'version: 2.0.4');
    assert.strictEqual(f.counterText(), 'All changes processed');

    await f.undo();
    assert.strictEqual(f.resultText(), 'version: 1.0.0');
  });

  it('Reset returns every resolved change to unresolved in one undoable step', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    // Fully resolve both changes: the one-sided apply, then the conflict as
    // "take theirs" (right applied, left ignored).
    await f.clickAction('left', 'apply', 0);
    await f.clickAction('right', 'apply');
    await f.clickAction('left', 'ignore');
    assert.strictEqual(f.counterText(), 'All changes processed');
    assert.strictEqual(
      (f.document.getElementById('btn-reset') as HTMLButtonElement).disabled,
      false
    );

    await f.click('btn-reset');
    assert.strictEqual(f.resultText(), BASE);
    assert.strictEqual(f.counterText(), '2 of 2 changes remaining');
    assert.strictEqual(
      (f.document.getElementById('btn-reset') as HTMLButtonElement).disabled,
      true
    );

    // The reset itself is one undo step: Cmd/Ctrl+Z brings everything back.
    await f.undo();
    assert.strictEqual(f.counterText(), 'All changes processed');
    assert.strictEqual(f.resultText(), 'L1 changed\nmid\nconf right\nmid2\nend');
  });

  it('next/prev navigate relative to the caret, not a stale cursor', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    // Changes sit at result lines 1 (one-sided) and 3 (conflict). The caret
    // starts on line 1, so Next moves past it to the conflict, then wraps.
    await f.click('btn-next');
    assert.strictEqual(f.editors[1].revealedLine, 3);
    await f.click('btn-next');
    assert.strictEqual(f.editors[1].revealedLine, 1);

    // Resolving a change must not desync navigation: from line 1 the only
    // unresolved change left is the conflict on line 3.
    await f.clickAction('left', 'apply', 0);
    await f.click('btn-next');
    assert.strictEqual(f.editors[1].revealedLine, 3);
    await f.click('btn-prev');
    assert.strictEqual(f.editors[1].revealedLine, 3);
  });

  it('scrolling one pane drives BOTH other panes', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    f.editors[0].setScrollTop(90);
    assert.strictEqual(f.editors[1].getScrollTop(), 90);
    assert.strictEqual(f.editors[2].getScrollTop(), 90);

    f.editors[1].setScrollTop(36);
    assert.strictEqual(f.editors[0].getScrollTop(), 36);
    assert.strictEqual(f.editors[2].getScrollTop(), 36);
  });
});

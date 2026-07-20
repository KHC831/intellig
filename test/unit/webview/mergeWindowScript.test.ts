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
  /** Make the NEXT post to the host throw, as a failing postMessage would. */
  failNextPost(): void;
  window: JSDOM['window'];
  document: Document;
  posted: unknown[];
  /** [left, result, right] */
  editors: StubEditor[];
  flush(): Promise<void>;
  click(id: string): Promise<void>;
  /** Delivers a host → webview message. */
  deliver(data: unknown): void;
  /** Clicks the nth action icon of that kind in a side pane's action strip. */
  clickAction(pane: 'left' | 'right', kind: ActionKind, nth?: number): Promise<void>;
  /** The action icons of that kind in a side pane's divider-hugging strip. */
  actionButtons(pane: 'left' | 'right', kind: ActionKind): HTMLElement[];
  resultText(): string;
  counterText(): string;
  /** Keyboard undo/redo (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z) via the result editor. */
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** Themes passed to `monaco.editor.setTheme`, in call order. */
  themeCalls: string[];
  /** The live MergeWindow instance, for the theme-sync internals. */
  mergeWindow(): unknown;
  dispose(): void;
}

/**
 * The MergeWindow internals the theme-sync test drives: connector colors are
 * cached at layout and cleared on any theme change, but connectors never paint
 * under jsdom, so the suite seeds and reads the cache directly to assert the
 * invalidation contract the DOM can't express.
 */
interface MergeWindowThemeInternals {
  connectorColor(kind: string): string;
  connectorColorCache: Map<string, string>;
}

const MAIN_MODULE = '../../../src/conflicts/merge-window/webview/main';

function bootMergeWindow(
  left: string,
  base: string,
  right: string,
  initExtra: Record<string, unknown> = {}
): IMergeWindowFixture {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const posted: unknown[] = [];
  const { stub, editors, themeCalls } = createMonacoStub();

  const g = global as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.MutationObserver = dom.window.MutationObserver;
  g.monaco = stub;
  let failNextPost = false;
  g.acquireVsCodeApi = (): { postMessage(m: unknown): void } => ({
    postMessage: (m: unknown): void => {
      if (failNextPost) {
        failNextPost = false;
        throw new Error('postMessage failed');
      }
      posted.push(m);
    },
  });

  delete require.cache[require.resolve(MAIN_MODULE)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(MAIN_MODULE) as { boot(): void; __getMergeWindowForTest(): unknown };
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
        ...initExtra,
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
    failNextPost: (): void => {
      failNextPost = true;
    },
    window: dom.window,
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
    deliver: (data: unknown): void => {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
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
    themeCalls,
    mergeWindow: (): unknown => mod.__getMergeWindowForTest(),
    dispose: (): void => {
      delete g.window;
      delete g.document;
      delete g.MutationObserver;
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
    assert.strictEqual(f.counterText(), 'Conflict 1 / 1');
    assert.strictEqual(f.document.getElementById('left-title')?.textContent, 'Yours (main)');
    // Nothing happened yet → Reset greyed out; no undo/redo buttons exist
    // (undo stays on the keyboard). Apply Non-Conflicting is offered because
    // a non-conflicting change is pending.
    assert.strictEqual(
      (f.document.getElementById('btn-reset') as HTMLButtonElement).disabled,
      true
    );
    assert.strictEqual(f.document.getElementById('btn-undo'), null);
    assert.strictEqual(f.document.getElementById('btn-redo'), null);
    assert.strictEqual(
      (f.document.getElementById('btn-nc-all') as HTMLButtonElement).disabled,
      false
    );
    assert.strictEqual(f.document.getElementById('btn-prev')?.textContent, 'Prev');
    assert.strictEqual(f.document.getElementById('btn-next')?.textContent, 'Next');
    // Apply is always offered (IntelliJ parity); with changes unresolved it
    // confirms with counts instead of greying out.
    assert.strictEqual(
      (f.document.getElementById('btn-apply') as HTMLButtonElement).disabled,
      false
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

    // Apply Non-Conflicting tracks whether the one-sided change is applied, so
    // its disabled state discriminates every step of the apply/undo/redo cycle.
    const ncDisabled = (): boolean =>
      (f.document.getElementById('btn-nc-all') as HTMLButtonElement).disabled;
    assert.strictEqual(ncDisabled(), false, 'a non-conflicting change is pending');

    await f.clickAction('left', 'apply', 0);
    assert.strictEqual(f.resultText(), AFTER_NC_APPLY);
    assert.strictEqual(ncDisabled(), true, 'the only non-conflicting change is now applied');

    await f.undo();
    assert.strictEqual(f.resultText(), BASE);
    assert.strictEqual(ncDisabled(), false, 'undo restores the pending change');

    await f.redo();
    assert.strictEqual(f.resultText(), AFTER_NC_APPLY);
    assert.strictEqual(ncDisabled(), true, 'redo re-applies it');
  });

  it('a resolved one-sided change reverts only on the side that owns it', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    await f.clickAction('left', 'apply', 0); // resolve the one-sided LEFT change

    // The revert button lives only on the owning (left) strip. The right side
    // never changed here — no pane block, band, or connector — so its strip
    // stays bare rather than carrying an orphaned revert.
    assert.strictEqual(f.actionButtons('left', 'revert').length, 1);
    assert.strictEqual(f.actionButtons('right', 'revert').length, 0);
  });

  it('gutter apply takes a conflict side; the opposite side then appends', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();
    await f.clickAction('left', 'apply', 0);

    await f.clickAction('right', 'apply');
    assert.strictEqual(f.resultText(), 'L1 changed\nmid\nconf right\nmid2\nend');
    assert.strictEqual(f.counterText(), 'Conflict 1 / 1');

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
    assert.strictEqual(f.counterText(), 'Conflict 1 / 1');

    await f.clickAction('right', 'ignore');
    assert.strictEqual(f.resultText(), AFTER_NC_APPLY);
    assert.strictEqual(f.counterText(), 'All changes processed');
  });

  it('conflicts are NOT auto-resolved on open, even simple ones', async () => {
    f = bootMergeWindow('version: 2.0.0', 'version: 1.0.0', 'version: 1.0.4');
    await f.flush();

    assert.strictEqual(f.resultText(), 'version: 1.0.0');
    assert.strictEqual(f.counterText(), 'Conflict 1 / 1');
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

  it('Accept on a pristine result needs no discard confirmation', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    await f.click('btn-accept-left');
    assert.strictEqual(f.resultText(), LEFT);
    assert.ok(
      !f.posted.some((m) => (m as { type?: string }).type === 'confirm'),
      'no confirm round trip for an untouched result'
    );
  });

  it('Accept over a modified result waits for the host confirm; declining keeps the result', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();
    await f.clickAction('left', 'apply', 0); // modifies the result

    await f.click('btn-accept-left');
    assert.strictEqual(f.resultText(), AFTER_NC_APPLY, 'nothing is discarded before the answer');
    const confirm = f.posted.find((m) => (m as { type?: string }).type === 'confirm') as
      | { requestId: number; action: string }
      | undefined;
    assert.ok(confirm, 'a modified result must trigger a confirm request');
    assert.strictEqual(confirm.action, 'acceptLeft');

    f.deliver({ type: 'confirmResult', requestId: confirm.requestId, confirmed: false });
    await f.flush();
    assert.strictEqual(f.resultText(), AFTER_NC_APPLY, 'declining keeps the merge result');
  });

  it('Apply stays enabled with unresolved changes and asks with counts first', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    const applyBtn = f.document.getElementById('btn-apply') as HTMLButtonElement;
    assert.strictEqual(applyBtn.disabled, false, 'Apply is never hard-disabled');

    await f.click('btn-apply');
    assert.ok(
      !f.posted.some((m) => (m as { type?: string }).type === 'apply'),
      'nothing applies before the user answers'
    );
    const confirm = f.posted.find(
      (m) => (m as { type?: string; action?: string }).action === 'applyUnresolved'
    ) as { requestId: number; changes: number; conflicts: number } | undefined;
    assert.ok(confirm, 'unresolved changes must trigger a counted confirm');
    assert.strictEqual(confirm.changes, 1, 'one plain change left');
    assert.strictEqual(confirm.conflicts, 1, 'one conflict left');

    f.deliver({ type: 'confirmResult', requestId: confirm.requestId, confirmed: false });
    await f.flush();
    assert.ok(
      !f.posted.some((m) => (m as { type?: string }).type === 'apply'),
      'declining continues the merge'
    );
  });

  it('confirming a partially-resolved Apply marks all resolved and applies as shown', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    await f.click('btn-apply');
    const confirm = f.posted.find(
      (m) => (m as { type?: string; action?: string }).action === 'applyUnresolved'
    ) as { requestId: number };
    f.deliver({ type: 'confirmResult', requestId: confirm.requestId, confirmed: true });
    await f.flush();

    const apply = f.posted.find((m) => (m as { type?: string }).type === 'apply') as
      | { resultText: string }
      | undefined;
    assert.ok(apply, 'confirming applies the result');
    assert.strictEqual(apply.resultText, BASE, 'the file saves exactly as shown in Result');
  });

  it('Apply with everything resolved needs no confirmation', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();
    await f.clickAction('left', 'apply', 0); // the plain change
    await f.clickAction('left', 'apply', 0); // the conflict, left side
    await f.clickAction('right', 'ignore', 0); // the conflict, right side

    await f.click('btn-apply');
    const apply = f.posted.find((m) => (m as { type?: string }).type === 'apply');
    assert.ok(apply, 'a fully resolved merge applies straight away');
    assert.ok(
      !f.posted.some((m) => (m as { action?: string }).action === 'applyUnresolved'),
      'no confirm when nothing is unresolved'
    );
  });

  it('confirming the discard accepts the whole side', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();
    await f.clickAction('right', 'apply', 0);

    await f.click('btn-accept-left');
    const confirm = f.posted.find((m) => (m as { type?: string }).type === 'confirm') as {
      requestId: number;
      action: string;
    };
    f.deliver({ type: 'confirmResult', requestId: confirm.requestId, confirmed: true });
    await f.flush();
    assert.strictEqual(f.resultText(), LEFT, 'confirming discards the result and takes Yours');
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
    assert.strictEqual(f.counterText(), 'Conflict 1 / 1');
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

  it('plain typing in the result marks the content modified (Abort must confirm)', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    f.editors[1].getModel().applyRawEdits([{ offset: 0, end: 2, text: 'XX' }]);
    await f.flush();

    await f.click('btn-abort');
    const abort = f.posted.find((m) => (m as { type?: string }).type === 'abort') as {
      modified: boolean;
    };
    assert.strictEqual(abort.modified, true, 'hand-typed edits are discardable work');
  });

  it('state posts carry the result text once the result is modified', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    await f.clickAction('left', 'apply', 0);
    const states = f.posted.filter((m) => (m as { type?: string }).type === 'state') as Array<{
      modified: boolean;
      resultText?: string;
    }>;
    const last = states[states.length - 1];
    assert.strictEqual(last.modified, true);
    assert.strictEqual(
      last.resultText,
      AFTER_NC_APPLY,
      'the host needs the text to persist for restore'
    );
  });

  it('an init with a restored result seeds the result editor as a modified state', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT, { restoredResult: 'restored text\n' });
    await f.flush();

    assert.strictEqual(f.resultText(), 'restored text\n');
    const states = f.posted.filter((m) => (m as { type?: string }).type === 'state') as Array<{
      modified: boolean;
    }>;
    assert.strictEqual(
      states[states.length - 1]?.modified,
      true,
      'a restored result counts as modified (Abort must confirm)'
    );
  });

  it('does not escalate a benign ResizeObserver warning to fatal', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    // automaticLayout puts a ResizeObserver on all three editors, and Chromium
    // dispatches this loop warning as a window ErrorEvent. Treating it as
    // fatal destroys a live merge over a benign browser message.
    f.window.dispatchEvent(
      new f.window.ErrorEvent('error', {
        message: 'ResizeObserver loop completed with undelivered notifications.',
      })
    );
    await f.flush();

    const logs = f.posted.filter((m) => (m as { type?: string }).type === 'log');
    assert.deepStrictEqual(logs, [], 'a ResizeObserver loop warning is not reportable at all');
  });

  it('reports an uncaught error at a non-disposing level while the panel still works', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    f.window.dispatchEvent(new f.window.ErrorEvent('error', { message: 'something threw' }));
    await f.flush();

    const logs = f.posted.filter((m) => (m as { type?: string }).type === 'log') as Array<{
      level: string;
    }>;
    assert.strictEqual(logs.length, 1, 'it is still reported');
    assert.strictEqual(
      logs[0].level,
      'error',
      '"something threw" is not "the panel cannot continue" — Apply still works'
    );
  });

  it('escalates to fatal when the panel is provably unusable', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    // No Apply button means the user cannot act on the merge at all.
    f.document.getElementById('btn-apply')?.remove();
    f.window.dispatchEvent(new f.window.ErrorEvent('error', { message: 'skeleton gone' }));
    await f.flush();

    const fatal = f.posted.filter(
      (m) => (m as { type?: string }).type === 'log' && (m as { level?: string }).level === 'fatal'
    );
    assert.strictEqual(fatal.length, 1, 'an unusable panel must still be closed');
  });

  it('reports a constructor failure as fatal — the panel never built', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();
    const before = f.posted.length;

    // Rebuild with the result pane gone: mustGet throws inside the
    // constructor, so no MergeWindow exists and the tab is dead. This is the
    // ORIGINAL fatal producer, distinct from the global net's escalation.
    f.document.getElementById('result-editor')?.remove();
    f.deliver({
      type: 'init',
      left: LEFT,
      base: BASE,
      right: RIGHT,
      leftLabel: 'Yours (main)',
      rightLabel: 'Theirs (feature)',
      fileName: 'a.txt',
    });
    await f.flush();

    const logs = f.posted
      .slice(before)
      .filter((m) => (m as { type?: string }).type === 'log') as Array<{
      level: string;
      text: string;
    }>;
    assert.strictEqual(logs.length, 1, 'a failed boot must be reported');
    assert.strictEqual(
      logs[0].level,
      'fatal',
      'the host must toast and close a panel that never built'
    );
    assert.match(logs[0].text, /failed to initialize/);
  });

  it('a failed post does not wedge the reporter shut', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    // The re-entrancy flag must not survive a throwing post: `reportedLevels`
    // already bounds the recursion, so leaving it latched only costs the
    // escalation that follows.
    f.failNextPost();
    f.window.dispatchEvent(new f.window.ErrorEvent('error', { message: 'post dies' }));
    await f.flush();

    f.document.getElementById('btn-apply')?.remove();
    f.window.dispatchEvent(new f.window.ErrorEvent('error', { message: 'now unusable' }));
    await f.flush();

    const fatal = f.posted.filter(
      (m) => (m as { type?: string }).type === 'log' && (m as { level?: string }).level === 'fatal'
    );
    assert.strictEqual(fatal.length, 1, 'a transient post failure must not silence a later fatal');
  });

  it('coalesces repeated errors per severity but still escalates later', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    const levels = (): string[] =>
      f.posted
        .filter((m) => (m as { type?: string }).type === 'log')
        .map((m) => (m as { level: string }).level);

    for (let i = 0; i < 3; i++) {
      f.window.dispatchEvent(new f.window.ErrorEvent('error', { message: `boom ${i}` }));
    }
    await f.flush();
    assert.deepStrictEqual(levels(), ['error'], 'repeats at one severity are noise');

    // The panel later becomes genuinely unusable. A blanket once-latch would
    // swallow this, leaving the tab dead with nothing reported — exactly the
    // symptom the fatal level exists to prevent.
    f.document.getElementById('btn-apply')?.remove();
    f.window.dispatchEvent(new f.window.ErrorEvent('error', { message: 'now unusable' }));
    await f.flush();
    assert.deepStrictEqual(
      levels(),
      ['error', 'fatal'],
      'escalation must survive an earlier error'
    );
  });

  it('reports a throw from an event listener, not just a scheduled callback', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    // The resize listener re-lays the gutters; per-call-site guards never
    // covered the event-handler family, so this died with nothing posted.
    f.document.getElementById('gutter-left')?.remove();
    f.window.dispatchEvent(new f.window.Event('resize'));
    await f.flush();

    // Reported, but NOT fatal: the merge is still applyable, so this must not
    // close the window.
    const logs = f.posted.filter((m) => (m as { type?: string }).type === 'log') as Array<{
      level: string;
    }>;
    assert.strictEqual(logs.length, 1, 'a throw in an event listener must reach the host');
    assert.strictEqual(logs[0].level, 'error');
  });

  it('reports a throw inside the queued render instead of dying silently', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    // The queued render runs in a microtask: a throw there escapes the boot
    // try/catch entirely, so the window would go inert mid-session with the
    // host none the wiser.
    f.document.getElementById('banner')?.remove();
    await f.clickAction('left', 'apply', 0);

    const logs = f.posted.filter((m) => (m as { type?: string }).type === 'log') as Array<{
      level: string;
      text: string;
    }>;
    assert.strictEqual(logs.length, 1, 'the host must hear about a dead render');
    assert.strictEqual(logs[0].level, 'error', 'a stale view is not an unusable panel');
    assert.match(logs[0].text, /render/, 'the label names the failing operation');
  });

  describe('restored result: text-only session', () => {
    // Seeding the restored text through Monaco replays as ONE whole-document
    // replace, which collapses every model change range to zero length at EOF.
    // Per-change and bulk actions would then target meaningless ranges, so the
    // restored session offers only free-text editing plus Apply/Abort.
    const RESTORED = 'a\nL\nc\nR\n';

    it('offers no per-change or bulk actions', async () => {
      f = bootMergeWindow(LEFT, BASE, RIGHT, { restoredResult: RESTORED });
      await f.flush();

      assert.strictEqual(f.resultText(), RESTORED);
      assert.strictEqual(f.actionButtons('left', 'apply').length, 0);
      assert.strictEqual(f.actionButtons('left', 'ignore').length, 0);
      assert.strictEqual(f.actionButtons('right', 'apply').length, 0);
      assert.strictEqual(f.actionButtons('right', 'ignore').length, 0);

      const disabled = (id: string): boolean =>
        (f.document.getElementById(id) as HTMLButtonElement).disabled;
      for (const id of [
        'btn-accept-left',
        'btn-accept-right',
        'btn-reset',
        'btn-prev',
        'btn-next',
        'btn-nc-left',
        'btn-nc-all',
        'btn-nc-right',
        'btn-magic-all',
      ]) {
        assert.strictEqual(disabled(id), true, `${id} must be disabled in a restored session`);
      }
      // Apply and Abort are the whole point of reopening the window.
      assert.strictEqual(disabled('btn-apply'), false);
      const banner = f.document.getElementById('banner');
      assert.match(
        banner?.textContent ?? '',
        /restored/i,
        'the banner must say the session is text-only'
      );
      assert.strictEqual(banner?.classList.contains('visible'), true);
    });

    // The `.disabled` assertions above prove the controls are unREACHABLE; this
    // proves their handlers are also INERT if one were ever reached. Neither
    // alone is the proof, so both are kept.
    it('no toolbar action can mutate the restored text', async () => {
      f = bootMergeWindow(LEFT, BASE, RIGHT, { restoredResult: RESTORED });
      await f.flush();

      for (const id of [
        // Accept Yours/Theirs replace the whole result — the most destructive
        // pair on the toolbar, so they are exercised too.
        'btn-accept-left',
        'btn-accept-right',
        'btn-nc-left',
        'btn-nc-all',
        'btn-nc-right',
        'btn-magic-all',
        'btn-reset',
      ]) {
        await f.click(id);
      }
      assert.strictEqual(f.resultText(), RESTORED, 'the restored text must survive every action');
    });

    it('Apply sends the restored text with no unresolved-count confirm', async () => {
      f = bootMergeWindow(LEFT, BASE, RIGHT, { restoredResult: RESTORED });
      await f.flush();

      await f.click('btn-apply');

      // The change ranges collapsed on restore, so any count derived from them
      // describes nothing; asking the user to confirm it would be a lie, and a
      // cautious user cancelling could not apply their own text at all.
      assert.deepStrictEqual(
        f.posted.filter((m) => (m as { type?: string }).type === 'confirm'),
        [],
        'a restored session must not raise the unresolved-count modal'
      );
      const applies = f.posted.filter((m) => (m as { type?: string }).type === 'apply');
      assert.strictEqual(applies.length, 1);
      assert.strictEqual(
        (applies[0] as { resultText: string }).resultText,
        RESTORED,
        'Apply must carry the restored text verbatim'
      );
    });

    it('no non-button mutation path can reach the merge model', async () => {
      f = bootMergeWindow(LEFT, BASE, RIGHT, { restoredResult: RESTORED });
      await f.flush();

      // The result gutter wand is a mousedown handler, not a button, so a
      // disabled toolbar says nothing about it.
      f.editors[1].clickGlyphMargin(2);
      await f.flush();
      assert.strictEqual(f.resultText(), RESTORED, 'the magic wand must be inert');

      // Keyboard undo/redo route to the model's undo manager, bypassing every
      // button. They may edit TEXT (that is the user's own undo) but must not
      // resurrect change-driven actions.
      await f.undo();
      await f.redo();
      assert.strictEqual(f.actionButtons('left', 'apply').length, 0);
      assert.strictEqual(f.actionButtons('right', 'apply').length, 0);
      assert.strictEqual(
        (f.document.getElementById('btn-nc-all') as HTMLButtonElement).disabled,
        true,
        'a restored session stays text-only across undo/redo'
      );

      // A stray host confirmResult must not complete an accept nobody started.
      f.deliver({ type: 'confirmResult', requestId: 1, confirmed: true });
      await f.flush();
      assert.strictEqual(f.resultText(), RESTORED);
    });

    it('the counter reports no navigable changes', async () => {
      f = bootMergeWindow(LEFT, BASE, RIGHT, { restoredResult: RESTORED });
      await f.flush();
      assert.strictEqual(f.counterText(), '');
    });
  });

  it('Resolve Simple Conflicts magic-resolves every auto-resolvable conflict', async () => {
    f = bootMergeWindow('version: 2.0.0', 'version: 1.0.0', 'version: 1.0.4');
    await f.flush();

    const btn = f.document.getElementById('btn-magic-all') as HTMLButtonElement;
    assert.ok(btn, 'the toolbar carries a Resolve Simple Conflicts action');
    assert.strictEqual(btn.disabled, false, 'enabled while an auto-resolvable conflict exists');

    await f.click('btn-magic-all');
    assert.strictEqual(f.resultText(), 'version: 2.0.4');
    assert.strictEqual(f.counterText(), 'All changes processed');
    assert.strictEqual(btn.disabled, true, 'greys out once nothing is auto-resolvable');

    await f.undo();
    assert.strictEqual(f.resultText(), 'version: 1.0.0', 'the bulk resolve is one undo step');
  });

  it('Resolve Simple Conflicts greys out when the only conflict truly collides', async () => {
    f = bootMergeWindow('conf left', 'conf base', 'conf right');
    await f.flush();

    const btn = f.document.getElementById('btn-magic-all') as HTMLButtonElement;
    assert.strictEqual(btn.disabled, true, 'a same-word conflict cannot be magic-resolved');
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
    assert.strictEqual(f.counterText(), 'Conflict 1 / 1');
    assert.strictEqual(
      (f.document.getElementById('btn-reset') as HTMLButtonElement).disabled,
      true
    );

    // The reset itself is one undo step: Cmd/Ctrl+Z brings everything back.
    await f.undo();
    assert.strictEqual(f.counterText(), 'All changes processed');
    assert.strictEqual(f.resultText(), 'L1 changed\nmid\nconf right\nmid2\nend');
  });

  it('next/prev walk conflicts, then fall back to other unresolved changes', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    // Changes sit at result lines 1 (one-sided) and 3 (conflict). While a
    // conflict is unresolved Prev/Next walk CONFLICTS: the one-sided change on
    // line 1 is never a stop, so from the caret on line 1 both directions land
    // (and stay) on the conflict.
    await f.click('btn-next');
    assert.strictEqual(f.editors[1].revealedLine, 3);
    await f.click('btn-next');
    assert.strictEqual(f.editors[1].revealedLine, 3);
    await f.click('btn-prev');
    assert.strictEqual(f.editors[1].revealedLine, 3);

    // Resolving the conflict leaves the one-sided change still unresolved:
    // navigation falls back to it so there is always a path to an unresolved
    // change. Prev/Next stay enabled and now reach line 1.
    await f.clickAction('left', 'ignore', 1);
    await f.clickAction('right', 'ignore');
    assert.strictEqual(f.counterText(), 'All conflicts resolved · 1 non-conflicting left');
    assert.strictEqual(
      (f.document.getElementById('btn-next') as HTMLButtonElement).disabled,
      false
    );
    assert.strictEqual(
      (f.document.getElementById('btn-prev') as HTMLButtonElement).disabled,
      false
    );
    await f.click('btn-next');
    assert.strictEqual(f.editors[1].revealedLine, 1);

    // Resolving that last change leaves nothing to navigate: both buttons grey.
    await f.clickAction('left', 'ignore', 0);
    assert.strictEqual(f.counterText(), 'All changes processed');
    assert.strictEqual((f.document.getElementById('btn-next') as HTMLButtonElement).disabled, true);
    assert.strictEqual((f.document.getElementById('btn-prev') as HTMLButtonElement).disabled, true);
  });

  it('Apply Non-Conflicting resolves every non-conflict in one undo step', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    await f.click('btn-nc-all');
    assert.strictEqual(f.resultText(), AFTER_NC_APPLY);
    assert.strictEqual(f.counterText(), 'Conflict 1 / 1', 'the conflict stays unresolved');
    assert.strictEqual(
      (f.document.getElementById('btn-nc-all') as HTMLButtonElement).disabled,
      true,
      'nothing non-conflicting left to apply'
    );

    await f.undo();
    assert.strictEqual(f.resultText(), BASE);
    assert.strictEqual(
      (f.document.getElementById('btn-nc-all') as HTMLButtonElement).disabled,
      false
    );
  });

  it('Apply Non-Conflicting ships left and right side variants like IntelliJ', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    const leftBtn = f.document.getElementById('btn-nc-left') as HTMLButtonElement;
    const rightBtn = f.document.getElementById('btn-nc-right') as HTMLButtonElement;
    assert.ok(leftBtn, 'left-side variant exists');
    assert.ok(rightBtn, 'right-side variant exists');
    assert.strictEqual(leftBtn.disabled, false, 'a left-side change is pending');
    assert.strictEqual(rightBtn.disabled, true, 'no right-side-only change exists');

    await f.click('btn-nc-left');
    assert.strictEqual(f.resultText(), AFTER_NC_APPLY, 'only left-side changes land');
    assert.strictEqual(leftBtn.disabled, true, 'greys out once applied');
    assert.strictEqual(f.counterText(), 'Conflict 1 / 1', 'the conflict stays untouched');
  });

  it('auto-applies non-conflicting changes on open when the host asks', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT, { autoApplyNonConflicting: true });
    await f.flush();

    assert.strictEqual(f.resultText(), AFTER_NC_APPLY);
    assert.strictEqual(f.counterText(), 'Conflict 1 / 1', 'conflicts stay untouched');
    // The auto-applied change is resolved → Reset has something to revert.
    assert.strictEqual(
      (f.document.getElementById('btn-reset') as HTMLButtonElement).disabled,
      false
    );
  });

  it('auto-apply never touches conflicts, even simple ones', async () => {
    f = bootMergeWindow('version: 2.0.0', 'version: 1.0.0', 'version: 1.0.4', {
      autoApplyNonConflicting: true,
    });
    await f.flush();

    assert.strictEqual(f.resultText(), 'version: 1.0.0');
    assert.strictEqual(f.counterText(), 'Conflict 1 / 1');
  });

  it('auto-apply that applies nothing leaves the content unmodified', async () => {
    // Conflict-only merge: auto-apply has no candidate, so the result still
    // equals the base and there is no work to restore on the next open.
    f = bootMergeWindow('version: 2.0.0', 'version: 1.0.0', 'version: 1.0.4', {
      autoApplyNonConflicting: true,
    });
    await f.flush();

    const states = f.posted.filter((m) => (m as { type?: string }).type === 'state') as Array<{
      modified: boolean;
    }>;
    assert.ok(
      states.every((s) => s.modified === false),
      'an untouched merge must never report modified (it would prompt "Restore it?" on reopen)'
    );
  });

  it('auto-apply that applies nothing posts no result text over a dismissed restore', async () => {
    // The host offered a saved result and the user declined it, so init
    // carries no restoredResult. A modified state post here would write the
    // untouched base back over the saved result the user chose to keep.
    f = bootMergeWindow('version: 2.0.0', 'version: 1.0.0', 'version: 1.0.4', {
      autoApplyNonConflicting: true,
    });
    await f.flush();

    const states = f.posted.filter((m) => (m as { type?: string }).type === 'state') as Array<{
      resultText?: string;
    }>;
    assert.ok(
      states.every((s) => s.resultText === undefined),
      'no result text may be persisted when nothing was applied'
    );
  });

  it('auto-apply that does change content still marks it modified', async () => {
    // The normal auto-apply flow: real work landed, so it is restorable and
    // MAY overwrite a saved result the user declined — that is intended.
    f = bootMergeWindow(LEFT, BASE, RIGHT, { autoApplyNonConflicting: true });
    await f.flush();

    const states = f.posted.filter((m) => (m as { type?: string }).type === 'state') as Array<{
      modified: boolean;
      resultText?: string;
    }>;
    const last = states[states.length - 1];
    assert.strictEqual(last.modified, true);
    assert.strictEqual(last.resultText, AFTER_NC_APPLY);
  });

  it('a one-sided change paints only on its own side and the result', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    const classesOf = (idx: number): string[] =>
      (f.editors[idx].collections[0].decorations as Array<{ options: { className?: string } }>).map(
        (d) => d.options.className ?? ''
      );

    // The one-sided LEFT modification (line 1) is painted on the left pane and
    // the result, but NOT on the right pane, which did not change — matching
    // IntelliJ, where a side editor decorates only the changes it owns while
    // the result always shows every block. The conflict (line 3) is painted on
    // every pane.
    const left = classesOf(0);
    const result = classesOf(1);
    const right = classesOf(2);

    assert.ok(left.some((c) => c.includes('merge-modified')));
    assert.ok(result.some((c) => c.includes('merge-modified')));
    assert.ok(
      !right.some((c) => c.includes('modified')),
      `the unchanged right pane must not decorate the one-sided change, got ${JSON.stringify(right)}`
    );
    assert.ok(right.some((c) => c.includes('merge-conflict')));
  });

  it('unresolved changes paint a colored band through the action strips', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    const bands = (pane: 'left' | 'right'): string[] =>
      Array.from(
        f.document
          .getElementById(pane === 'left' ? 'action-left' : 'action-right')!
          .querySelectorAll('.action-band')
      ).map((b) => b.className);

    // A strip bands only the unresolved changes its own side owns: the left
    // modification bands the left strip, the conflict bands both. The right
    // strip carries no band for the one-sided change, since the right pane
    // paints nothing there.
    assert.deepStrictEqual(bands('left'), ['action-band k-modified', 'action-band k-conflict']);
    assert.deepStrictEqual(bands('right'), ['action-band k-conflict']);

    // Resolving the modification drops its band from the left strip; the
    // conflict band stays on both (resolved rows render as boundary lines).
    await f.clickAction('left', 'apply', 0);
    assert.deepStrictEqual(bands('left'), ['action-band k-conflict']);
    assert.deepStrictEqual(bands('right'), ['action-band k-conflict']);
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

  it('scrolling one pane horizontally drives BOTH other panes', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    f.editors[0].setScrollLeft(42);
    assert.strictEqual(f.editors[1].getScrollLeft(), 42);
    assert.strictEqual(f.editors[2].getScrollLeft(), 42);

    f.editors[1].setScrollLeft(17);
    assert.strictEqual(f.editors[0].getScrollLeft(), 17);
    assert.strictEqual(f.editors[2].getScrollLeft(), 17);
  });

  it('row highlights and resolved boundaries carry into the line-number margin', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();
    await f.clickAction('left', 'apply', 0); // the one-sided change → resolved boundary

    const decos = f.editors[1].collections[0].decorations as Array<{
      options: { className?: string; marginClassName?: string };
    }>;

    // The still-unresolved conflict fills the row: the fill must reach the
    // line-number margin too (same class).
    const filled = decos.find((d) => d.options.className === 'merge-conflict');
    assert.ok(filled, 'the unresolved conflict still fills the result row');
    assert.strictEqual(filled.options.marginClassName, 'merge-conflict');

    // The applied change renders as a resolved boundary: its dotted border
    // must continue across the margin.
    const resolved = decos.find((d) => (d.options.className ?? '').includes('merge-resolved-top'));
    assert.ok(resolved, 'the applied change renders as a resolved boundary');
    assert.strictEqual(resolved.options.marginClassName, resolved.options.className);

    // Word-level inline highlights are not whole-line, so they stay off the margin.
    const word = decos.find((d) => (d.options.className ?? '').includes('merge-word'));
    if (word) {
      assert.strictEqual(word.options.marginClassName, undefined);
    }
  });

  it('an empty result block marks in the change color, not always grey', async () => {
    // Add/add conflict: base has nothing between a and b, each side inserts a
    // different line → the conflict occupies zero result lines (empty block).
    f = bootMergeWindow('a\nLEFT\nb', 'a\nb', 'a\nRIGHT\nb');
    await f.flush();

    const decos = f.editors[1].collections[0].decorations as Array<{
      options: { className?: string; marginClassName?: string };
    }>;
    const empty = decos.find((d) => (d.options.className ?? '').includes('merge-empty'));
    assert.ok(empty, 'the conflict has an empty result block');
    assert.ok(
      empty.options.className!.includes('k-conflict'),
      `empty marker should carry the conflict kind, got "${empty.options.className}"`
    );
    assert.strictEqual(empty.options.marginClassName, empty.options.className);
  });

  it('follows a VS Code theme switch while open', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();
    assert.deepStrictEqual(f.themeCalls, [], 'no theme change yet');

    f.document.body.classList.add('vscode-light');
    await f.flush();
    assert.deepStrictEqual(f.themeCalls, ['vs'], 'light theme must reach Monaco');

    f.document.body.classList.remove('vscode-light');
    f.document.body.classList.add('vscode-dark');
    await f.flush();
    assert.deepStrictEqual(f.themeCalls, ['vs', 'vs-dark'], 'dark theme must reach Monaco');
  });

  it('re-derives connector colors on a same-polarity theme switch', async () => {
    f = bootMergeWindow(LEFT, BASE, RIGHT);
    await f.flush();

    const theme = f.mergeWindow() as MergeWindowThemeInternals;
    // Connectors never paint under jsdom, so seed the cache directly to observe
    // its invalidation.
    theme.connectorColor('conflict');
    assert.ok(theme.connectorColorCache.size > 0, 'cache seeded');

    // VS Code swaps data-vscode-theme-name (class unchanged) between two dark
    // themes: the cached connector colors are stale and must drop, but Monaco's
    // base theme must NOT be re-set — the light/dark polarity did not flip.
    f.document.body.setAttribute('data-vscode-theme-name', 'Solarized Dark');
    await f.flush();
    assert.strictEqual(theme.connectorColorCache.size, 0, 'connector cache invalidated');
    assert.deepStrictEqual(f.themeCalls, [], 'same polarity → no Monaco theme reset');

    // A polarity flip both invalidates the cache and re-sets Monaco's theme.
    theme.connectorColor('conflict');
    f.document.body.classList.add('vscode-light');
    await f.flush();
    assert.strictEqual(theme.connectorColorCache.size, 0);
    assert.deepStrictEqual(f.themeCalls, ['vs']);
  });
});

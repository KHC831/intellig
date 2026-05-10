/**
 * Unit tests for the T1-05 tab router.
 *
 * These tests exercise dispatch, per-tab handler registration, active-tab
 * state, the `tabChange` meta-message, and context-key publication. They do
 * NOT touch the webview / HTML — those surfaces are covered separately by
 * the existing GitToolWindowProvider tests.
 */

import '../../../../test/setup';
import * as assert from 'assert';
import {
  ACTIVE_TAB_CONTEXT_KEY,
  DEFAULT_TAB,
  TAB_IDS,
  TabRouter,
  inferTabForMessage,
  isTabId,
  type IWebviewTabMessage,
  type TabId,
} from '../../../../services/gitToolWindow/tabRouter';

// ─── inferTabForMessage ───────────────────────────────────────────────────────

describe('gitToolWindow/tabRouter — inferTabForMessage', () => {
  it('honors an explicit `tab` field when valid', () => {
    const result = inferTabForMessage({ type: 'custom.thing', tab: 'incoming' }, 'log');
    assert.strictEqual(result, 'incoming');
  });

  it('treats legacy log-tab messages (selectCommit, panelResize, etc.) as `log`', () => {
    for (const type of [
      'selectCommit',
      'toggleCommitSelection',
      'loadMoreCommits',
      'panelResize',
      'applyLogFilter',
      'branchClick',
      'refresh',
    ]) {
      const result = inferTabForMessage({ type }, 'log');
      assert.strictEqual(result, 'log', `${type} should be routed to log`);
    }
  });

  it('routes console.* / incoming.* / updateInfo.* / history.* by prefix', () => {
    assert.strictEqual(inferTabForMessage({ type: 'console.clear' }, 'log'), 'console');
    assert.strictEqual(inferTabForMessage({ type: 'incoming.refresh' }, 'log'), 'incoming');
    assert.strictEqual(inferTabForMessage({ type: 'updateInfo.refresh' }, 'log'), 'updateInfo');
    assert.strictEqual(inferTabForMessage({ type: 'history.loadFile' }, 'log'), 'history');
  });

  it('routes log.* by prefix explicitly', () => {
    assert.strictEqual(inferTabForMessage({ type: 'log.foo' }, 'history'), 'log');
  });

  it('falls back to the active tab for unknown messages', () => {
    assert.strictEqual(inferTabForMessage({ type: 'unknown.thing' }, 'history'), 'history');
  });
});

// ─── isTabId ──────────────────────────────────────────────────────────────────

describe('gitToolWindow/tabRouter — isTabId', () => {
  it('accepts every canonical tab id', () => {
    for (const id of TAB_IDS) {
      assert.strictEqual(isTabId(id), true, `${id} should be a valid tab id`);
    }
  });

  it('rejects non-strings and unknown strings', () => {
    assert.strictEqual(isTabId(undefined), false);
    assert.strictEqual(isTabId(null), false);
    assert.strictEqual(isTabId(''), false);
    assert.strictEqual(isTabId('bogus'), false);
    assert.strictEqual(isTabId(42), false);
  });
});

// ─── TabRouter.dispatch ───────────────────────────────────────────────────────

describe('gitToolWindow/tabRouter — TabRouter.dispatch', () => {
  it('initializes with the default tab (`log`)', () => {
    const router = new TabRouter();
    assert.strictEqual(router.getActiveTab(), DEFAULT_TAB);
    assert.strictEqual(router.getActiveTab(), 'log');
  });

  it('dispatches log-tab messages to the Log handler and returns `false`', async () => {
    const received: IWebviewTabMessage[] = [];
    const router = new TabRouter();
    router.register('log', (m) => {
      received.push(m);
    });

    const consumed = await router.dispatch({ type: 'selectCommit', commitHash: 'abc' });

    assert.strictEqual(consumed, false, 'Log-tab dispatch must NOT mark the message as consumed');
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].type, 'selectCommit');
  });

  it('routes `console.*` to the Console handler and returns `true`', async () => {
    const received: IWebviewTabMessage[] = [];
    const router = new TabRouter();
    router.register('console', (m) => {
      received.push(m);
    });

    const consumed = await router.dispatch({ type: 'console.clear' });
    assert.strictEqual(consumed, true, 'console.* must be marked consumed');
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].type, 'console.clear');
  });

  it('routes `incoming.*`, `updateInfo.*`, and `history.*` to their respective handlers', async () => {
    const calls: Array<{ tab: TabId; type: string }> = [];
    const router = new TabRouter();
    router.register('incoming', (m) => {
      calls.push({ tab: 'incoming', type: m.type });
    });
    router.register('updateInfo', (m) => {
      calls.push({ tab: 'updateInfo', type: m.type });
    });
    router.register('history', (m) => {
      calls.push({ tab: 'history', type: m.type });
    });

    await router.dispatch({ type: 'incoming.refresh' });
    await router.dispatch({ type: 'updateInfo.refresh' });
    await router.dispatch({ type: 'history.loadFile', path: 'src/foo.ts' });

    assert.deepStrictEqual(calls, [
      { tab: 'incoming', type: 'incoming.refresh' },
      { tab: 'updateInfo', type: 'updateInfo.refresh' },
      { tab: 'history', type: 'history.loadFile' },
    ]);
  });

  it('drops malformed messages (non-object, missing type) without throwing', async () => {
    const received: IWebviewTabMessage[] = [];
    const router = new TabRouter();
    for (const tab of TAB_IDS) {
      router.register(tab, (m) => {
        received.push(m);
      });
    }

    await router.dispatch(null as unknown as IWebviewTabMessage);
    await router.dispatch(undefined as unknown as IWebviewTabMessage);
    await router.dispatch({} as IWebviewTabMessage);
    await router.dispatch({ type: '' } as IWebviewTabMessage);

    assert.strictEqual(received.length, 0, 'no handler should have been called');
  });
});

// ─── TabRouter — tabChange + context key ──────────────────────────────────────

describe('gitToolWindow/tabRouter — tabChange meta-message', () => {
  it('updates the active tab, publishes the context key, and fires the hook', async () => {
    const setContextCalls: Array<{ key: string; value: unknown }> = [];
    const hookCalls: TabId[] = [];
    const router = new TabRouter({
      onActiveTabChanged: (tab) => {
        hookCalls.push(tab);
      },
      setContext: (key, value) => {
        setContextCalls.push({ key, value });
      },
    });

    const consumed = await router.dispatch({ type: 'tabChange', tab: 'console' });

    assert.strictEqual(consumed, true, 'tabChange is always consumed by the router');
    assert.strictEqual(router.getActiveTab(), 'console');
    assert.deepStrictEqual(hookCalls, ['console']);
    assert.strictEqual(setContextCalls.length, 1);
    assert.strictEqual(setContextCalls[0].key, ACTIVE_TAB_CONTEXT_KEY);
    assert.strictEqual(setContextCalls[0].value, 'console');
  });

  it('is a no-op when the target tab equals the current one', async () => {
    const hookCalls: TabId[] = [];
    const router = new TabRouter({
      onActiveTabChanged: (tab) => {
        hookCalls.push(tab);
      },
    });
    // already on `log` by default
    await router.dispatch({ type: 'tabChange', tab: 'log' });
    assert.strictEqual(router.getActiveTab(), 'log');
    assert.strictEqual(hookCalls.length, 0);
  });

  it('ignores `tabChange` with an invalid tab id', async () => {
    const router = new TabRouter();
    await router.dispatch({ type: 'tabChange', tab: 'bogus' as unknown as TabId });
    assert.strictEqual(router.getActiveTab(), DEFAULT_TAB);
  });

  it('setActiveTab works programmatically and updates the context key', async () => {
    const setContextCalls: Array<{ key: string; value: unknown }> = [];
    const router = new TabRouter({
      setContext: (key, value) => {
        setContextCalls.push({ key, value });
      },
    });
    await router.setActiveTab('history');
    assert.strictEqual(router.getActiveTab(), 'history');
    assert.deepStrictEqual(setContextCalls, [{ key: ACTIVE_TAB_CONTEXT_KEY, value: 'history' }]);
  });

  it('dispatches a message that explicitly carries `tab: log` back to the Log handler', async () => {
    const received: IWebviewTabMessage[] = [];
    const router = new TabRouter();
    router.register('log', (m) => {
      received.push(m);
    });

    const consumed = await router.dispatch({ type: 'custom.thing', tab: 'log' });
    assert.strictEqual(consumed, false);
    assert.strictEqual(received.length, 1);
  });

  it('does NOT call the Log handler when a message explicitly carries a non-log tab', async () => {
    const logCalls: IWebviewTabMessage[] = [];
    const historyCalls: IWebviewTabMessage[] = [];
    const router = new TabRouter();
    router.register('log', (m) => {
      logCalls.push(m);
    });
    router.register('history', (m) => {
      historyCalls.push(m);
    });

    const consumed = await router.dispatch({ type: 'generic', tab: 'history' });
    assert.strictEqual(consumed, true);
    assert.strictEqual(logCalls.length, 0);
    assert.strictEqual(historyCalls.length, 1);
  });
});

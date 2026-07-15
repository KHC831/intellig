/**
 * Spec for src/utils/webviewStateSlot.ts — the webview-side versioned
 * validate-on-load seam.
 *
 * Pins: envelope round-trip, version-mismatch drop, junk → undefined,
 * other-slot preservation, and legacy bare-value back-compat (the pre-envelope
 * inline scripts wrote raw values like `graphScrollTop`/`openFilterPopup`
 * directly onto the state object — those must still load after upgrade, mirroring
 * the host `persistedState` seam).
 */
import * as assert from 'assert';
import {
  loadWebviewState,
  saveWebviewState,
  type IWebviewStateApi,
  type IWebviewStateSlot,
} from '../../../src/utils/webviewStateSlot';

class FakeStateApi implements IWebviewStateApi {
  private state: unknown;
  constructor(initial?: unknown) {
    this.state = initial;
  }
  getState(): unknown {
    return this.state;
  }
  setState(value: unknown): void {
    this.state = value;
  }
}

const SCROLL_SLOT: IWebviewStateSlot<number> = {
  key: 'graphScrollTop',
  version: 1,
  validate: (raw) => (typeof raw === 'number' && isFinite(raw) ? raw : undefined),
};

describe('webviewStateSlot', () => {
  it('round-trips a value through the versioned envelope', () => {
    const api = new FakeStateApi();
    saveWebviewState(api, SCROLL_SLOT, 420);
    assert.strictEqual(loadWebviewState(api, SCROLL_SLOT), 420);
  });

  it('drops a value stored under a different version', () => {
    const api = new FakeStateApi({ graphScrollTop: { v: 2, data: 420 } });
    assert.strictEqual(loadWebviewState(api, SCROLL_SLOT), undefined);
  });

  it('returns undefined for a payload that fails validate', () => {
    const api = new FakeStateApi({ graphScrollTop: { v: 1, data: 'nope' } });
    assert.strictEqual(loadWebviewState(api, SCROLL_SLOT), undefined);
  });

  it('preserves sibling slots on write', () => {
    const api = new FakeStateApi({ openFilterPopup: { v: 1, data: 'branch' } });
    saveWebviewState(api, SCROLL_SLOT, 10);
    const all = api.getState() as Record<string, unknown>;
    assert.deepStrictEqual(all.openFilterPopup, { v: 1, data: 'branch' });
    assert.strictEqual(loadWebviewState(api, SCROLL_SLOT), 10);
  });

  it('loads a legacy bare value written before the envelope existed', () => {
    // The pre-envelope inline scripts persisted the raw value directly:
    //   prev.graphScrollTop = scrollTop; vscode.setState(prev);
    // That bare value must still load after upgrade, not reset to default.
    const api = new FakeStateApi({ graphScrollTop: 555 });
    assert.strictEqual(loadWebviewState(api, SCROLL_SLOT), 555);
  });
});

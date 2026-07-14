/**
 * Unit tests: the working-tree STATUS lane scheduler.
 *
 * Port of the VS Code git extension's response policy for working-tree file
 * events (extensions/git/src/repository.ts — onFileChange →
 * @debounce(1000) eventuallyUpdateWhenIdleAndWait → @throttle
 * whenIdleAndFocused → status → timeout(5000)):
 *
 *   - a burst of events coalesces through a trailing-edge debounce;
 *   - runs are spaced by a hard floor, so a sustained build storm costs at
 *     most one refresh per floor window;
 *   - nothing runs while the window is unfocused — the pending run waits for
 *     focus to return;
 *   - events landing during a run/floor coalesce into ONE trailing run;
 *   - dispose cancels everything pending.
 *
 * Timings are injected so the tests run in milliseconds.
 */

import '../../setup';
import * as assert from 'assert';
import { createStatusLane, IStatusLane } from '../../../src/git-core/statusLane';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface IFocusHarness {
  focused: boolean;
  listeners: Array<() => void>;
  isFocused(): boolean;
  onDidFocus(cb: () => void): { dispose(): void };
  focus(): void;
}

function makeFocus(initial = true): IFocusHarness {
  const harness: IFocusHarness = {
    focused: initial,
    listeners: [],
    isFocused: () => harness.focused,
    onDidFocus: (cb: () => void) => {
      harness.listeners.push(cb);
      return {
        dispose: (): void => {
          harness.listeners = harness.listeners.filter((l) => l !== cb);
        },
      };
    },
    focus: (): void => {
      harness.focused = true;
      for (const l of [...harness.listeners]) {
        l();
      }
    },
  };
  return harness;
}

function makeLane(overrides?: {
  debounceMs?: number;
  floorMs?: number;
  focus?: IFocusHarness;
  run?: () => Promise<void>;
}): { lane: IStatusLane; runs: number[]; focus: IFocusHarness } {
  const runs: number[] = [];
  const focus = overrides?.focus ?? makeFocus(true);
  const lane = createStatusLane({
    debounceMs: overrides?.debounceMs ?? 10,
    floorMs: overrides?.floorMs ?? 40,
    isFocused: focus.isFocused,
    onDidFocus: focus.onDidFocus,
    run:
      overrides?.run ??
      (async (): Promise<void> => {
        runs.push(Date.now());
      }),
  });
  return { lane, runs, focus };
}

describe('statusLane — working-tree refresh scheduler', () => {
  it('a burst of pokes inside the debounce window coalesces into one run', async () => {
    const { lane, runs } = makeLane();
    lane.poke();
    lane.poke();
    lane.poke();
    await sleep(25);
    assert.strictEqual(runs.length, 1, 'one debounced run for the whole burst');
    lane.dispose();
  });

  it('each poke re-arms the trailing edge (no run until the stream pauses)', async () => {
    const { lane, runs } = makeLane({ debounceMs: 15 });
    lane.poke();
    await sleep(8);
    lane.poke();
    await sleep(8);
    lane.poke();
    assert.strictEqual(runs.length, 0, 'stream still active — nothing ran');
    await sleep(25);
    assert.strictEqual(runs.length, 1, 'runs once the stream pauses');
    lane.dispose();
  });

  it('sustained pokes are spaced by the floor: at most one run per floor window', async () => {
    const { lane, runs } = makeLane({ debounceMs: 5, floorMs: 50 });
    const interval = setInterval(() => lane.poke(), 8);
    await sleep(160);
    clearInterval(interval);
    await sleep(80);
    lane.dispose();
    assert.ok(
      runs.length >= 2 && runs.length <= 4,
      `sustained events must be floored (~3 runs in 240ms with a 50ms floor), got ${runs.length}`
    );
    for (let i = 1; i < runs.length; i++) {
      assert.ok(
        runs[i] - runs[i - 1] >= 45,
        `run spacing ${runs[i] - runs[i - 1]}ms must respect the floor`
      );
    }
  });

  it('events during a run + floor coalesce into exactly one trailing run', async () => {
    const { lane, runs } = makeLane({ debounceMs: 5, floorMs: 40 });
    lane.poke();
    await sleep(12); // first run happened, floor in progress
    lane.poke();
    lane.poke();
    lane.poke();
    await sleep(100);
    assert.strictEqual(runs.length, 2, 'burst during the floor coalesces to one trailing run');
    lane.dispose();
  });

  it('nothing runs while unfocused; the pending run fires when focus returns', async () => {
    const focus = makeFocus(false);
    const { lane, runs } = makeLane({ focus });
    lane.poke();
    await sleep(30);
    assert.strictEqual(runs.length, 0, 'unfocused window defers the refresh');
    focus.focus();
    await sleep(15);
    assert.strictEqual(runs.length, 1, 'refresh lands once focus returns');
    lane.dispose();
  });

  it('pokes while unfocused coalesce into one run on focus', async () => {
    const focus = makeFocus(false);
    const { lane, runs } = makeLane({ focus });
    lane.poke();
    await sleep(15);
    lane.poke();
    lane.poke();
    await sleep(15);
    focus.focus();
    await sleep(15);
    assert.strictEqual(runs.length, 1, 'the whole unfocused backlog is one refresh');
    lane.dispose();
  });

  it('dispose cancels a pending debounce and a focus wait', async () => {
    const focus = makeFocus(false);
    const { lane, runs } = makeLane({ focus });
    lane.poke();
    lane.dispose();
    focus.focus();
    await sleep(30);
    assert.strictEqual(runs.length, 0, 'nothing runs after dispose');
    assert.strictEqual(focus.listeners.length, 0, 'focus subscription released');
  });

  it('a rejecting run does not wedge the lane', async () => {
    let calls = 0;
    const { lane } = makeLane({
      debounceMs: 5,
      floorMs: 10,
      run: async (): Promise<void> => {
        calls += 1;
        throw new Error('status failed');
      },
    });
    lane.poke();
    await sleep(20);
    lane.poke();
    await sleep(25);
    assert.strictEqual(calls, 2, 'the lane keeps scheduling after a failed run');
    lane.dispose();
  });
});

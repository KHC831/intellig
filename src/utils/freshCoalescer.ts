/**
 * Coalesce concurrent runs of a task, per key, without ever answering a caller
 * with a run that started before it asked.
 *
 * Sharing the in-flight run with every caller (the obvious coalescing) is
 * wrong for a read whose caller acts on the answer: a caller that asks right
 * after a change gets a result read before it. Here a caller arriving while a
 * run is in flight gets the ONE follow-up run that starts once that run
 * settles, shared with every other caller arriving meanwhile. At most one run
 * is in flight per key, plus at most one queued.
 */

interface ISlot<T> {
  running: Promise<T>;
  queued?: Promise<T>;
}

const ignore = (): void => {};

export class FreshCoalescer<T> {
  private readonly _slots = new Map<string, ISlot<T>>();

  run(key: string, task: () => Promise<T>): Promise<T> {
    const slot = this._slots.get(key);
    if (slot?.queued) {
      return slot.queued;
    }
    const run = slot ? slot.running.then(ignore, ignore).then(task) : task();
    if (slot) {
      slot.queued = run;
    } else {
      this._slots.set(key, { running: run });
    }
    const settle = (): void => this._settle(key, run);
    run.then(settle, settle);
    return run;
  }

  /** `run` settled: its queued follow-up (already started) becomes the running one. */
  private _settle(key: string, run: Promise<T>): void {
    const slot = this._slots.get(key);
    if (!slot || slot.running !== run) {
      return;
    }
    if (slot.queued) {
      slot.running = slot.queued;
      slot.queued = undefined;
    } else {
      this._slots.delete(key);
    }
  }
}

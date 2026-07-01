/**
 * Unit tests for the pure Layer-0 conflict stage model (parsing + side status).
 * No git invoked — `parseUnmergedStages` / `sideStatus` are pure over the
 * `git ls-files -u -z` record shape.
 */

import * as assert from 'assert';
import {
  parseUnmergedStages,
  sideStatus,
  IUnmergedEntry,
} from '../../../src/conflicts/conflictStageModel';

/** Build a `git ls-files -u -z` record: `<mode> <sha> <stage>\t<path>\0`. */
function rec(stage: 1 | 2 | 3, path: string): string {
  return `100644 ${String(stage).repeat(40)} ${stage}\t${path}\0`;
}

describe('conflictStageModel — parseUnmergedStages', () => {
  it('groups multiple stages of one path into a single entry (both-modified UU)', () => {
    const map = parseUnmergedStages(rec(1, 'f.txt') + rec(2, 'f.txt') + rec(3, 'f.txt'));
    const e = map.get('f.txt')!;
    assert.ok(e.stage1 && e.stage2 && e.stage3, 'all three stages present');
    assert.strictEqual(e.stage2.mode, '100644');
  });

  it('records only the stages present (add-by-us AU → stage 2 only)', () => {
    const e = parseUnmergedStages(rec(2, 'f.txt')).get('f.txt')!;
    assert.ok(e.stage2 && !e.stage3 && !e.stage1);
  });

  it('records both-deleted DD as stage 1 only', () => {
    const e = parseUnmergedStages(rec(1, 'f.txt')).get('f.txt')!;
    assert.ok(e.stage1 && !e.stage2 && !e.stage3);
  });

  it('keeps multiple paths distinct', () => {
    const map = parseUnmergedStages(rec(2, 'a.txt') + rec(3, 'b.txt'));
    assert.strictEqual(map.size, 2);
    assert.ok(map.get('a.txt')!.stage2 && !map.get('a.txt')!.stage3);
    assert.ok(map.get('b.txt')!.stage3 && !map.get('b.txt')!.stage2);
  });

  it('skips empty and malformed records', () => {
    const map = parseUnmergedStages('' + rec(2, 'ok.txt') + 'no-tab-here\0' + '\0');
    assert.strictEqual(map.size, 1);
    assert.ok(map.get('ok.txt'));
  });

  it('preserves paths with spaces (NUL-delimited, no C-quoting)', () => {
    const e = parseUnmergedStages(rec(2, 'dir/a b.txt'));
    assert.ok(e.get('dir/a b.txt'));
  });
});

describe('conflictStageModel — sideStatus', () => {
  const uu: IUnmergedEntry = { stage2: { mode: 'm', sha: 's' }, stage3: { mode: 'm', sha: 's' } };
  const oursOnly: IUnmergedEntry = { stage2: { mode: 'm', sha: 's' } };
  const theirsOnly: IUnmergedEntry = { stage3: { mode: 'm', sha: 's' } };
  const baseOnly: IUnmergedEntry = { stage1: { mode: 'm', sha: 's' } };

  it('present when the wanted stage exists', () => {
    assert.strictEqual(sideStatus(uu, 'ours'), 'present');
    assert.strictEqual(sideStatus(uu, 'theirs'), 'present');
  });

  it('deleted when ours (stage 2) is absent — UA / DU / DD', () => {
    assert.strictEqual(sideStatus(theirsOnly, 'ours'), 'deleted');
    assert.strictEqual(sideStatus(baseOnly, 'ours'), 'deleted');
  });

  it('deleted when theirs (stage 3) is absent — AU / UD / DD', () => {
    assert.strictEqual(sideStatus(oursOnly, 'theirs'), 'deleted');
    assert.strictEqual(sideStatus(baseOnly, 'theirs'), 'deleted');
  });
});

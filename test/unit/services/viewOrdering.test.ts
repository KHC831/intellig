/**
 * Startup view ordering in the IntelliG container (user-ruled: Branches,
 * Git, Commit).
 *
 * Two pins, both needed: the DECLARATION order (VS Code lays out a fresh
 * workspace from array order) and explicit `order` fields (the commit tool
 * window's `when` makes it materialize late, and an unordered late view
 * shuffles relative to the restored layout — order fields keep the slot
 * stable). A new view added without an order field fails here.
 *
 * Caveat (documented, not asserted): VS Code preserves a user-dragged layout
 * per workspace. This guarantees fresh-workspace/default ordering and stops
 * the late-appearance shuffle; it does not override an existing user
 * arrangement.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface IViewEntry {
  id: string;
  name?: string;
  order?: number;
  when?: string;
}

function intelligViews(): IViewEntry[] {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf-8')
  ) as { contributes: { views: Record<string, IViewEntry[]> } };
  return pkg.contributes.views.intellig;
}

describe('IntelliG container view ordering (Branches, Git, Commit)', () => {
  it('declares the views in the ruled order', () => {
    assert.deepStrictEqual(
      intelligViews().map((v) => v.id),
      ['intellig.branchTree', 'intellig.toolWindow', 'intellig.commitToolWindow'],
      'declaration order drives the fresh-workspace layout'
    );
  });

  it('every view carries an explicit order field matching its slot', () => {
    const orders = new Map(intelligViews().map((v) => [v.id, v.order]));
    assert.strictEqual(orders.get('intellig.branchTree'), 1);
    assert.strictEqual(orders.get('intellig.toolWindow'), 2);
    assert.strictEqual(orders.get('intellig.commitToolWindow'), 3);
  });

  it('no view ships unordered (late-materializing views shuffle without one)', () => {
    for (const v of intelligViews()) {
      assert.strictEqual(typeof v.order, 'number', `${v.id} must declare an explicit order field`);
    }
  });
});

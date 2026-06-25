/**
 * Unit tests for the per-branch graph coloring core (branchColors.ts):
 * the fixed palette, positional color rotation (adjacent branches differ), and
 * the "most-specific branch owns the commit" ownership rule (the two locked
 * scenarios).
 */

import '../../setup';
import * as assert from 'assert';
import {
  GRAPH_BRANCH_COLORS,
  computeBranchColors,
  type IColorNode,
} from '../../../src/git-core/graph/branchColors';

function node(
  hash: string,
  parents: string[],
  refs: { name: string; type: 'local' | 'remote' }[] = []
): IColorNode {
  return { hash, parents, refs };
}

const P = GRAPH_BRANCH_COLORS;

describe('branchColors — palette', () => {
  it('is a fixed set of distinct hex colors (usable in SVG attributes)', () => {
    assert.ok(P.length >= 6, 'at least 6 hues');
    for (const c of P) {
      assert.ok(/^#[0-9a-f]{6}$/.test(c), `plain hex: ${c}`);
    }
    assert.strictEqual(new Set(P).size, P.length, 'distinct');
  });
});

describe('branchColors — rotation (adjacent branches differ)', () => {
  it('assigns consecutive palette colors down the view — never color1→color2→color1', () => {
    // Three branch tips stacked in display order, then a shared base.
    const nodes = [
      node('b0', ['b1'], [{ name: 'br0', type: 'local' }]),
      node('b1', ['b2'], [{ name: 'br1', type: 'local' }]),
      node('b2', ['base'], [{ name: 'br2', type: 'local' }]),
      node('base', []),
    ];
    const colors = computeBranchColors(nodes);
    assert.strictEqual(colors.get('b0'), P[0]);
    assert.strictEqual(colors.get('b1'), P[1]);
    assert.strictEqual(colors.get('b2'), P[2]);
    // The three adjacent branch colors are all distinct.
    assert.strictEqual(new Set([colors.get('b0'), colors.get('b1'), colors.get('b2')]).size, 3);
  });

  it('is deterministic for the same input', () => {
    const mk = () => [node('a', ['b'], [{ name: 'main', type: 'local' }]), node('b', [])];
    assert.deepStrictEqual([...computeBranchColors(mk())], [...computeBranchColors(mk())]);
  });
});

describe('branchColors — ownership', () => {
  it('colors a linear branch by its tip, down the first-parent chain', () => {
    const nodes = [
      node('a', ['b'], [{ name: 'main', type: 'local' }]),
      node('b', ['c']),
      node('c', []),
    ];
    const colors = computeBranchColors(nodes);
    assert.strictEqual(colors.get('a'), P[0]);
    assert.strictEqual(colors.get('b'), P[0]);
    assert.strictEqual(colors.get('c'), P[0]);
  });

  it('leaves commits no branch reaches uncolored (caller falls back to lane)', () => {
    const colors = computeBranchColors([node('a', ['b']), node('b', [])]);
    assert.strictEqual(colors.get('a'), undefined);
    assert.strictEqual(colors.get('b'), undefined);
  });

  it('trunk (main) owns its whole spine across merges — shared mainline stays ONE color', () => {
    // Two feature branches merged INTO main. main's tip is the NEWEST commit
    // (recent merge), so the old "oldest-tip-first" rule let the merged
    // features (older tips) claim segments of the trunk below their forks,
    // painting the mainline multiple colors. Trunk-priority fixes it: main
    // owns every first-parent commit; feature colors begin only at the forks.
    const nodes = [
      // row 0: merge of feature-2 into main (first parent m1, second f2)
      node('m0', ['m1', 'f2tip'], [{ name: 'main', type: 'local' }]),
      node('f2tip', ['m2'], [{ name: 'feature-2', type: 'local' }]), // row 1
      node('m1', ['m2'], []), // row 2 — trunk
      node('m2', ['m3', 'f1tip']), // row 3 — merge of feature-1 (first parent m3)
      node('f1tip', ['m3'], [{ name: 'feature-1', type: 'local' }]), // row 4
      node('m3', []), // row 5 — trunk base
    ];
    const colors = computeBranchColors(nodes);
    const mainColor = colors.get('m0');
    // The ENTIRE first-parent spine of main is one color.
    assert.strictEqual(colors.get('m0'), mainColor);
    assert.strictEqual(colors.get('m1'), mainColor, 'trunk segment below feature-2 fork');
    assert.strictEqual(colors.get('m2'), mainColor, 'trunk merge commit');
    assert.strictEqual(colors.get('m3'), mainColor, 'trunk base stays main color');
    // Each merged feature keeps its own distinct color at its divergence.
    assert.notStrictEqual(colors.get('f1tip'), mainColor, 'feature-1 has its own color');
    assert.notStrictEqual(colors.get('f2tip'), mainColor, 'feature-2 has its own color');
  });

  it('scenario 1 (Y fork): each arm its own color; trunk (main) owns the shared trunk', () => {
    const nodes = [
      node('newTip', ['nMid'], [{ name: 'feature', type: 'local' }]), // row 0 → P[0]
      node('trunkTip', ['Pp'], [{ name: 'main', type: 'local' }]), // row 1 → P[1]
      node('nMid', ['Pp']),
      node('Pp', ['base']), // common parent
      node('base', []),
    ];
    const colors = computeBranchColors(nodes);
    assert.strictEqual(colors.get('newTip'), P[0], 'newer arm = first palette color');
    assert.strictEqual(colors.get('nMid'), P[0]);
    assert.strictEqual(colors.get('trunkTip'), P[1]);
    assert.strictEqual(colors.get('Pp'), P[1], 'common parent owned by the trunk (main)');
    assert.strictEqual(colors.get('base'), P[1], 'shared base owned by the trunk (main)');
    assert.notStrictEqual(colors.get('newTip'), colors.get('trunkTip'));
  });

  it('scenario 2 (full overlap): line splits at the shorter branch tip', () => {
    const nodes = [
      node('bTip', ['m1'], [{ name: 'feature-b', type: 'local' }]), // row 0 → P[0]
      node('m1', ['aTip']),
      node('aTip', ['s1'], [{ name: 'feature-a', type: 'local' }]), // row 2 → P[1]
      node('s1', ['Pp']),
      node('Pp', []),
    ];
    const colors = computeBranchColors(nodes);
    // feature-b's unique commits keep its color
    assert.strictEqual(colors.get('bTip'), P[0]);
    assert.strictEqual(colors.get('m1'), P[0]);
    // feature-a's tip + shared base take its color (the split)
    assert.strictEqual(colors.get('aTip'), P[1], 'shorter-branch tip owns from here down');
    assert.strictEqual(colors.get('s1'), P[1]);
    assert.strictEqual(colors.get('Pp'), P[1]);
    assert.notStrictEqual(colors.get('m1'), colors.get('aTip'), 'the two halves differ');
  });

  it('first-parent only — a merged side branch does not recolor the mainline', () => {
    const nodes = [
      node('mTip', ['mp', 'sTip'], [{ name: 'main', type: 'local' }]), // row 0 → P[0]
      node('mp', []),
      node('sTip', [], [{ name: 'side', type: 'local' }]), // row 2 → P[1]
    ];
    const colors = computeBranchColors(nodes);
    assert.strictEqual(colors.get('mTip'), P[0]);
    assert.strictEqual(colors.get('mp'), P[0], 'first parent = mainline');
    assert.strictEqual(colors.get('sTip'), P[1]);
  });

  it('dedupes a multi-ref tip to one branch (current branch wins the representative)', () => {
    // main + origin/main on the same commit → one tip, one color.
    const nodes = [
      node(
        't',
        ['p'],
        [
          { name: 'origin/main', type: 'remote' },
          { name: 'main', type: 'local' },
        ]
      ),
      node('p', []),
    ];
    const colors = computeBranchColors(nodes, { headBranchName: 'main' });
    assert.strictEqual(colors.get('t'), P[0]);
    assert.strictEqual(colors.get('p'), P[0]);
  });
});

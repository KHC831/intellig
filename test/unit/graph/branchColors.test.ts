/**
 * Unit tests for the per-branch graph coloring core (branchColors.ts):
 * the fixed palette, name-stable (position-independent) color assignment, and
 * the "most-specific branch owns the commit" ownership rule (the two locked
 * scenarios).
 */

import '../../setup';
import * as assert from 'assert';
import {
  GRAPH_BRANCH_COLORS,
  computeBranchColors,
  branchColorFor,
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

describe('branchColors — trunk pinned to blue', () => {
  it('main / master (and their remote forms) always get the blue slot, not a hashed hue', () => {
    // The trunk is the line users stare at all day; a name hash would hand
    // `main` orange (hashCode % 10 === 1). Pin every trunk spelling to blue.
    for (const name of ['main', 'master', 'origin/main', 'origin/master', 'upstream/main']) {
      assert.strictEqual(branchColorFor(name), P[0], `${name} is blue`);
    }
  });

  it('local trunk and its remote-tracking form share one color', () => {
    assert.strictEqual(branchColorFor('main'), branchColorFor('origin/main'));
    assert.strictEqual(branchColorFor('master'), branchColorFor('upstream/master'));
  });

  it('non-trunk names still hash across the palette (not everything is blue)', () => {
    assert.notStrictEqual(branchColorFor('feature/login'), P[0]);
    assert.notStrictEqual(
      branchColorFor('origin/mainline'),
      P[0],
      'prefix-only match is not trunk'
    );
  });

  it('a LOCAL branch named dev/main is not trunk — only a remote-form tail pins', () => {
    // The remote-tail strip applies to remote refs (`origin/main`); a local
    // branch whose LAST segment happens to be main/master is just a branch.
    // (Fixture names chosen so their hash slot is NOT blue.)
    assert.notStrictEqual(branchColorFor('dev/main', 'local'), P[0]);
    assert.notStrictEqual(branchColorFor('fix/master', 'local'), P[0]);
    assert.strictEqual(branchColorFor('origin/main', 'remote'), P[0]);
    assert.strictEqual(branchColorFor('main', 'local'), P[0]);
  });

  it('the graph colors a local dev/main by hash, not the trunk pin', () => {
    const colors = computeBranchColors([node('tip', [], [{ name: 'dev/main', type: 'local' }])]);
    assert.strictEqual(colors.get('tip'), branchColorFor('dev/main', 'local'));
    assert.notStrictEqual(colors.get('tip'), P[0], 'must not be trunk-pinned blue');
  });
});

describe('branchColors — name-stable (position-independent)', () => {
  it('colors each branch by its NAME, not its row — branchColorFor() is the source of truth', () => {
    const nodes = [
      node('b0', ['base'], [{ name: 'br0', type: 'local' }]),
      node('b1', ['base'], [{ name: 'br1', type: 'local' }]),
      node('b2', ['base'], [{ name: 'br2', type: 'local' }]),
      node('base', []),
    ];
    const colors = computeBranchColors(nodes);
    assert.strictEqual(colors.get('b0'), branchColorFor('br0'));
    assert.strictEqual(colors.get('b1'), branchColorFor('br1'));
    assert.strictEqual(colors.get('b2'), branchColorFor('br2'));
  });

  it('a branch keeps its color when a sibling branch is added (stable rendering)', () => {
    // 'feature' forks off a shared base. Adding a SIBLING branch ('newer', forking
    // off the same base) shifts feature's row index down — but feature must keep
    // the exact color it had, because color follows the name, not the position.
    const before = computeBranchColors([
      node('f', ['base'], [{ name: 'feature', type: 'local' }]),
      node('base', [], [{ name: 'main', type: 'local' }]),
    ]);
    const after = computeBranchColors([
      node('n', ['base'], [{ name: 'newer', type: 'local' }]), // sibling, now the topmost row
      node('f', ['base'], [{ name: 'feature', type: 'local' }]), // feature shifted from row 0 → 1
      node('base', [], [{ name: 'main', type: 'local' }]),
    ]);
    assert.strictEqual(
      after.get('f'),
      before.get('f'),
      "feature's color is unchanged after a sibling branch shifted its row"
    );
    assert.strictEqual(after.get('f'), branchColorFor('feature'));
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
    assert.strictEqual(colors.get('a'), branchColorFor('main'));
    assert.strictEqual(colors.get('b'), branchColorFor('main'));
    assert.strictEqual(colors.get('c'), branchColorFor('main'));
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
      node('newTip', ['nMid'], [{ name: 'feature', type: 'local' }]), // row 0
      node('trunkTip', ['Pp'], [{ name: 'main', type: 'local' }]), // row 1
      node('nMid', ['Pp']),
      node('Pp', ['base']), // common parent
      node('base', []),
    ];
    const colors = computeBranchColors(nodes);
    assert.strictEqual(colors.get('newTip'), branchColorFor('feature'), 'feature arm = its color');
    assert.strictEqual(colors.get('nMid'), branchColorFor('feature'));
    assert.strictEqual(colors.get('trunkTip'), branchColorFor('main'));
    assert.strictEqual(colors.get('Pp'), branchColorFor('main'), 'common parent owned by main');
    assert.strictEqual(colors.get('base'), branchColorFor('main'), 'shared base owned by main');
    assert.notStrictEqual(colors.get('newTip'), colors.get('trunkTip'));
  });

  it('scenario 2 (full overlap, no divergence): the whole line is ONE color', () => {
    // Several branch tips stacked on a SINGLE first-parent chain, no fork and no
    // merge — feature-b is simply ahead of feature-a on the same line. IntelliJ
    // collapses such a linear graph to a single head (the topmost tip) when that
    // tip is processed first, so the entire line is one color. The old
    // oldest-tip-first rule split it into a per-tip-segment rainbow (the
    // "5 colors on one line" bug); newest-tip-first lets feature-b's tip claim
    // the whole chain.
    const nodes = [
      node('bTip', ['m1'], [{ name: 'feature-b', type: 'local' }]), // row 0
      node('m1', ['aTip']),
      node('aTip', ['s1'], [{ name: 'feature-a', type: 'local' }]), // row 2
      node('s1', ['Pp']),
      node('Pp', []),
    ];
    const colors = computeBranchColors(nodes);
    // The topmost tip (feature-b) owns every commit down the overlapping chain.
    const bColor = branchColorFor('feature-b');
    assert.strictEqual(colors.get('bTip'), bColor);
    assert.strictEqual(colors.get('m1'), bColor);
    assert.strictEqual(colors.get('aTip'), bColor, 'no divergence → no new color at feature-a');
    assert.strictEqual(colors.get('s1'), bColor);
    assert.strictEqual(colors.get('Pp'), bColor);
    // Exactly one distinct color across the whole line.
    assert.strictEqual(
      new Set([
        colors.get('bTip'),
        colors.get('m1'),
        colors.get('aTip'),
        colors.get('s1'),
        colors.get('Pp'),
      ]).size,
      1
    );
  });

  it('IntelliJ tier: a remote branch owns the shared base over a local branch', () => {
    // Two branches fork from a shared base: a REMOTE branch (newer/topmost) and
    // a LOCAL branch (older). Tier beats row — the remote branch (published
    // history) is processed first and claims the shared base, mirroring
    // GitBranchLayoutComparator (REMOTE_BRANCH outranks LOCAL_BRANCH).
    const nodes = [
      node('rTip', ['base'], [{ name: 'origin/feature', type: 'remote' }]), // row 0
      node('lTip', ['base'], [{ name: 'local-feature', type: 'local' }]), // row 1
      node('base', []),
    ];
    const colors = computeBranchColors(nodes);
    assert.strictEqual(
      colors.get('rTip'),
      colors.get('base'),
      'remote branch owns the shared base'
    );
    assert.notStrictEqual(
      colors.get('lTip'),
      colors.get('base'),
      'local branch keeps only its tip'
    );
  });

  it('IntelliJ tier: origin/main (remote trunk) outranks a topmost local feature', () => {
    // The local feature is the NEWEST tip, but origin/main is a higher tier, so
    // origin/main owns the shared mainline below the fork (remote trunk = tier 0).
    const nodes = [
      // Local branch name chosen palette-distinct from origin/main so ownership
      // (not an incidental name-hash collision) is what's asserted.
      node('fTip', ['shared'], [{ name: 'topic', type: 'local' }]), // row 0 (newest)
      node('omTip', ['shared'], [{ name: 'origin/main', type: 'remote' }]), // row 1
      node('shared', ['base']),
      node('base', []),
    ];
    const colors = computeBranchColors(nodes);
    const trunk = colors.get('omTip');
    assert.strictEqual(colors.get('shared'), trunk, 'remote trunk owns the shared mainline');
    assert.strictEqual(colors.get('base'), trunk, 'remote trunk owns the shared base too');
    assert.notStrictEqual(
      colors.get('fTip'),
      trunk,
      'the topmost local feature keeps its own color despite being newer'
    );
  });

  it('trunk carrying BOTH main and origin/main owns its whole spine over a sibling remote branch', () => {
    // The common real-clone state: the trunk tip carries both the local `main`
    // and the tracking `origin/main`. A sibling `origin/feature` is branched off
    // an OLDER trunk commit. A tip's ownership priority must come from the
    // best-of-ALL its refs (remote trunk, tier 0) — not from the local-first
    // representative (local trunk, tier 2), which would let the remote feature
    // (tier 1) outrank the trunk and steal the spine below the fork (the
    // multi-colored-mainline regression).
    const nodes = [
      node(
        'mTip',
        ['m1'],
        [
          { name: 'main', type: 'local' },
          { name: 'origin/main', type: 'remote' },
        ]
      ), // row 0 — trunk tip
      // Sibling remote branch (name chosen palette-distinct from main so the
      // ownership — not an incidental name-hash color collision — is what's tested).
      node('fTip', ['m2'], [{ name: 'origin/topic', type: 'remote' }]), // row 1 — branched off m2
      node('m1', ['m2']), // row 2 — trunk spine below the fork
      node('m2', ['m3']), // row 3 — fork point
      node('m3', []), // row 4 — trunk base
    ];
    const colors = computeBranchColors(nodes);
    const trunk = colors.get('mTip');
    assert.strictEqual(colors.get('m1'), trunk, 'trunk spine below the fork');
    assert.strictEqual(colors.get('m2'), trunk, 'fork-point commit stays trunk color');
    assert.strictEqual(colors.get('m3'), trunk, 'trunk base stays trunk color');
    assert.notStrictEqual(colors.get('fTip'), trunk, 'sibling branch keeps only its own tip');
  });

  it('first-parent only — a merged side branch does not recolor the mainline', () => {
    const nodes = [
      node('mTip', ['mp', 'sTip'], [{ name: 'main', type: 'local' }]), // row 0
      node('mp', []),
      node('sTip', [], [{ name: 'side', type: 'local' }]), // row 2
    ];
    const colors = computeBranchColors(nodes);
    assert.strictEqual(colors.get('mTip'), branchColorFor('main'));
    assert.strictEqual(colors.get('mp'), branchColorFor('main'), 'first parent = mainline');
    assert.strictEqual(colors.get('sTip'), branchColorFor('side'));
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
    assert.strictEqual(colors.get('t'), branchColorFor('main'));
    assert.strictEqual(colors.get('p'), branchColorFor('main'));
  });

  it('characterization: exact hash→hex map on a multi-merge / multi-tier / off-window DAG', () => {
    // A permanent regression guard pinning the WHOLE-MAP output byte-for-byte.
    // It exercises every ownership axis at once so silent ownership OR palette
    // drift is caught:
    //   • a trunk (local `main`) with TWO merges on its first-parent spine;
    //   • a local feature branch merged into the trunk;
    //   • a REMOTE branch (higher layout tier than the local trunk);
    //   • an OFF-WINDOW first parent (m3 → `offwin`, not in the window).
    //
    //   row 0  m0     main (local trunk)        parents [m1, f2tip]  (merge)
    //   row 1  f2tip  feature (local)           parents [m2]
    //   row 2  m1     —                         parents [m2]
    //   row 3  m2     —                         parents [m3, f1tip]  (merge)
    //   row 4  f1tip  origin/featureX (remote)  parents [m3]
    //   row 5  m3     —                         parents [offwin]     (off-window)
    const nodes = [
      node('m0', ['m1', 'f2tip'], [{ name: 'main', type: 'local' }]),
      node('f2tip', ['m2'], [{ name: 'feature', type: 'local' }]),
      node('m1', ['m2']),
      node('m2', ['m3', 'f1tip']),
      node('f1tip', ['m3'], [{ name: 'origin/featureX', type: 'remote' }]),
      node('m3', ['offwin']),
    ];
    const colors = computeBranchColors(nodes);

    // Exact, whole-map pin. Each commit takes its OWNING branch's name-stable
    // color (branchColorFor): main's spine is main's color, the merged feature
    // keeps its own, and the remote branch owns the shared base it reaches.
    assert.deepStrictEqual(
      Object.fromEntries(colors),
      {
        m0: branchColorFor('main'), // trunk tip
        m1: branchColorFor('main'), // trunk spine below the feature-2 fork — main owns it
        m2: branchColorFor('main'), // trunk merge commit — main owns it
        f2tip: branchColorFor('feature'), // merged local feature keeps its own color
        f1tip: branchColorFor('origin/featureX'), // remote branch tip
        // m3 (off-window first parent) is owned by the REMOTE branch, not main:
        // origin/featureX is a higher tier (remote) than local trunk, so it
        // claims the shared base it reaches via first parent.
        m3: branchColorFor('origin/featureX'),
      },
      'whole hash→hex ownership map drifted'
    );

    // Independent structural cross-checks (so the pin is not a pure echo):
    // the trunk spine is ONE color across both merges …
    assert.strictEqual(new Set([colors.get('m0'), colors.get('m1'), colors.get('m2')]).size, 1);
    // … the two merged side branches each keep a DISTINCT color from the trunk …
    assert.notStrictEqual(colors.get('f2tip'), colors.get('m0'));
    assert.notStrictEqual(colors.get('f1tip'), colors.get('m0'));
    // … and the remote branch (higher tier) owns the off-window-rooted base m3.
    assert.strictEqual(colors.get('m3'), colors.get('f1tip'));
  });
});

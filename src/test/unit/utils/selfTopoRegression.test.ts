/**
 * Self-topology regression pin (anonymized capture of THIS repo).
 *
 * `src/test/fixtures/selfTopoAnon.json` is a fully anonymized
 * `git log --all --topo-order` capture of the intellig repo at the time a
 * "disconnected git tree" was reported: a merge commit whose mainline lane
 * continued down to a far parent rendered with a GAP below it, because the
 * renderer truncated a bezier-target lane to its top half even though that
 * lane was also a through-lane carrying a transiting line further down.
 *
 * All private data is stripped (SHAs renumbered c0.., branch names
 * genericised, authors/dates/messages dropped) — only parent topology +
 * branch tips + HEAD are kept.
 *
 * This pins the fix: at a merge row whose target lane CONTINUES below, the
 * pass-through for that lane must be drawn FULL height (no gap).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  generateCommitGraph,
  computeTerminalNodes,
  computeChildCountMap,
  isBranchSplit,
  IBranchRef,
  ICommitNode,
} from '../../../git-core/commitGraph';
import {
  computeActiveLanes,
  renderGraphSvg,
  DEFAULT_GRAPH_CONFIG,
} from '../../../utils/graphRenderer';
import type { ICommit } from '../../../git-core/interfaces/IGitService';

interface AnonFixture {
  commits: { hash: string; parents: string[] }[];
  branches: { commit: string; name: string; type: 'local' | 'remote' }[];
  headHash: string;
  headBranchName: string;
}

function mk(hash: string, parents: string[]): ICommit {
  return {
    hash,
    shortHash: hash,
    message: hash,
    author: { name: 'a', email: 'a@a' },
    committer: { name: 'a', email: 'a@a' },
    parents,
    authorDate: new Date(0),
    commitDate: new Date(0),
  } as ICommit;
}

describe('Self anonymized topology — disconnect regression', () => {
  const fx = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'selfTopoAnon.json'), 'utf-8')
  ) as AnonFixture;
  const commits = fx.commits.map((c) => mk(c.hash, c.parents));
  const branchMap = new Map<string, IBranchRef[]>();
  for (const b of fx.branches) {
    const arr = branchMap.get(b.commit) ?? [];
    arr.push({ name: b.name, type: b.type });
    branchMap.set(b.commit, arr);
  }

  function build(): ICommitNode[] {
    return generateCommitGraph(
      commits,
      branchMap,
      undefined,
      undefined,
      fx.headBranchName,
      fx.headHash
    );
  }

  it('no vertical gap: a through-lane that also receives a merge bezier is drawn full-height', () => {
    const nodes = build();
    const active = computeActiveLanes(nodes);
    const ccm = computeChildCountMap(nodes);
    const terminals = computeTerminalNodes(nodes);

    const gaps: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const nextActive = active.get(i + 1) ?? new Set<number>();
      const svg = renderGraphSvg(
        n,
        i,
        active.get(i)!,
        DEFAULT_GRAPH_CONFIG,
        terminals.has(n.commit.hash),
        isBranchSplit(n.commit.hash, ccm),
        new Set(),
        false,
        nextActive
      );

      // For every lane that is active at BOTH this row and the next row (a
      // through-lane that visually continues downward), the rendered SVG
      // must contain a FULL-height segment (y2="rowHeight") at that lane's
      // x — otherwise the line is severed and a gap shows.
      const rowHeight = DEFAULT_GRAPH_CONFIG.rowHeight;
      for (const lane of active.get(i)!) {
        if (!nextActive.has(lane)) {
          continue; // lane doesn't continue below — no continuity to enforce
        }
        if (lane === n.graphColumn) {
          continue; // the node's own lane is drawn as two segments around the dot
        }
        const x =
          lane * DEFAULT_GRAPH_CONFIG.columnWidth +
          DEFAULT_GRAPH_CONFIG.padding +
          DEFAULT_GRAPH_CONFIG.columnWidth / 2;
        const fullHeight = new RegExp(`<line x1="${x}" y1="0" x2="${x}" y2="${rowHeight}"`);
        if (!fullHeight.test(svg)) {
          gaps.push(
            `row ${i} (${n.commit.hash}): lane ${lane} continues below but is not full-height`
          );
        }
      }
    }
    assert.deepStrictEqual(
      gaps.slice(0, 15),
      [],
      `${gaps.length} through-lane gap(s) — a merge commit's mainline lane was truncated, ` +
        `leaving a disconnected segment below it.`
    );
  });
});

/**
 * Self-topology regression pin (anonymized capture of THIS repo).
 *
 * `test/fixtures/selfTopoAnon.json` is a fully anonymized
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
import { generateCommitGraph, IBranchRef, ICommitNode } from '../../../../src/git-core/commitGraph';
import {
  computeLaneContinuesFromAbove,
  getColumnX,
  DEFAULT_GRAPH_CONFIG,
} from '../../../../src/utils/graphRenderer';
import { buildGraphPrintModel } from '../../../../src/git-core/graph/printModel';
import { paintRow } from '../../../../src/git-core/graph/graphPainter';
import type { ICommit } from '../../../../src/git-core/interfaces/IGitService';

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
    fs.readFileSync(path.join(__dirname, 'selfTopoAnon.json'), 'utf-8')
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

  it('no vertical gap: a genuine through-lane keeps continuous ink across the boundary', () => {
    const nodes = build();
    // A lane carries a SINGLE line across boundary i -> i+1 exactly when
    // continuesFromAbove(i+1) holds for it (reuse starts a new interval and is
    // excluded). For such a lane the bottom of row i and the top of row i+1 must
    // BOTH have ink — otherwise the trunk is severed (the reported disconnect).
    const fromAbove = computeLaneContinuesFromAbove(nodes);
    const svgs = buildGraphPrintModel(nodes).map((m) => paintRow(m, DEFAULT_GRAPH_CONFIG));
    const rowHeight = DEFAULT_GRAPH_CONFIG.rowHeight;
    const inkAt = (svg: string, x: number, y: number): boolean => {
      const lineRe = /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g;
      for (let m = lineRe.exec(svg); m; m = lineRe.exec(svg)) {
        if (+m[1] === x && +m[3] === x && (+m[2] === y || +m[4] === y)) {
          return true;
        }
      }
      const pathRe = /<path d="M ([\d.-]+),([\d.-]+) C [\d.,\s-]* ([\d.-]+),([\d.-]+)"/g;
      for (let m = pathRe.exec(svg); m; m = pathRe.exec(svg)) {
        if ((+m[1] === x && +m[2] === y) || (+m[3] === x && +m[4] === y)) {
          return true;
        }
      }
      return false;
    };
    const gaps: string[] = [];
    for (let i = 0; i + 1 < nodes.length; i++) {
      for (const lane of fromAbove.get(i + 1) ?? new Set<number>()) {
        const x = getColumnX(lane, DEFAULT_GRAPH_CONFIG);
        const bottom = inkAt(svgs[i], x, rowHeight);
        const top = inkAt(svgs[i + 1], x, 0);
        if (!bottom || !top) {
          gaps.push(
            `lane ${lane} boundary ${i}->${i + 1} (${nodes[i].commit.hash}): bottom=${bottom} top=${top}`
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

/**
 * Real-git integration for the trunk-color regression.
 *
 * Builds a LIVE repo with the exact regression topology and drives the
 * PRODUCTION color pipeline over it (no mock nodes):
 *   - the real commit DAG via `getLog({ all: true })` (hash + parents),
 *   - the real ref set via `git for-each-ref` (local + remote-tracking),
 *   - the production `computeBranchColors` over those.
 *
 * Topology: a trunk tip carrying BOTH `main` (local) and `origin/main`
 * (remote-tracking), plus a sibling `origin/feature` branched off an OLDER
 * trunk commit. Under the pre-fix local-first priority the trunk tip ranked as
 * a LOCAL trunk, so the remote feature (a higher tier than local trunk)
 * outranked it and stole the spine below the fork → a multi-colored mainline.
 * Best-of-all-refs priority makes the tip rank as a remote trunk, so `main`
 * owns its whole spine. Asserts the mainline is ONE color above AND below the
 * fork, with the feature a distinct color.
 *
 * This is the wiring the mock unit tests can't prove: that a real repo's real
 * refs decorate the nodes such that the fix actually holds end-to-end.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { StashTagHistoryOps } from '../../../src/git-core/ops/StashTagHistoryOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { createGitCli } from '../../../src/git-core/gitCli';
import {
  computeBranchColors,
  type IColorNode,
  type IColorRef,
} from '../../../src/git-core/graph/branchColors';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

function makeRealOps(): StashTagHistoryOps {
  const ctx = {
    gitCli: createGitCli(),
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return new StashTagHistoryOps(ctx);
}

describe('Graph branch colors — real git: trunk owns its spine vs a sibling remote feature', function () {
  this.timeout(180000);

  let dir: string;
  const ops = makeRealOps();
  const repo = (): IRepository => ({ rootUri: { fsPath: dir } }) as unknown as IRepository;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trunkcolor-'));
    const git = (...a: string[]): string => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 't@t.io');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    git('checkout', '-q', '-B', 'main');
    git('commit', '--allow-empty', '-q', '-m', 'c1'); // trunk base
    git('commit', '--allow-empty', '-q', '-m', 'c2'); // fork point
    git('checkout', '-q', '-b', 'feature'); // feature off the older c2
    git('commit', '--allow-empty', '-q', '-m', 'f1');
    git('checkout', '-q', 'main'); // advance the trunk past the fork
    git('commit', '--allow-empty', '-q', '-m', 'c3');
    git('commit', '--allow-empty', '-q', '-m', 'c4'); // trunk tip
    // Simulate remote-tracking refs WITHOUT a real remote: the trunk tip now
    // carries main + origin/main. The feature tip must be REMOTE-ONLY
    // (`origin/feature`, no local branch) — that is the regression trigger: a
    // local-first `pickRef` then ranks it as a remote non-trunk (a higher tier
    // than the trunk tip's LOCAL `main`), so it outranks the trunk and steals the
    // spine. A lingering local `feature` would mask the bug (local non-trunk
    // ranks BELOW local trunk), so delete it.
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'main').trim());
    git('update-ref', 'refs/remotes/origin/feature', git('rev-parse', 'feature').trim());
    git('branch', '-D', 'feature');
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the mainline is one color above AND below the feature fork (feature distinct)', async () => {
    // Real DAG via the production all-branches log read.
    const commits = await ops.getLog(repo(), { all: true }).unwrapOr([]);
    assert.ok(commits.length >= 5, `expected the full DAG, got ${commits.length} commits`);

    // Real ref set: object hash → its branch refs (local heads + remote-tracking).
    const refsByHash = new Map<string, IColorRef[]>();
    const refLines = execFileSync('git', ['for-each-ref', '--format=%(objectname) %(refname)'], {
      cwd: dir,
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    for (const line of refLines) {
      const sp = line.indexOf(' ');
      const oid = line.slice(0, sp);
      const refname = line.slice(sp + 1);
      let ref: IColorRef | undefined;
      if (refname.startsWith('refs/heads/')) {
        ref = { name: refname.slice('refs/heads/'.length), type: 'local' };
      } else if (refname.startsWith('refs/remotes/')) {
        ref = { name: refname.slice('refs/remotes/'.length), type: 'remote' };
      }
      if (!ref) {
        continue;
      }
      const list = refsByHash.get(oid) ?? [];
      list.push(ref);
      refsByHash.set(oid, list);
    }

    // Production color-fn input: { hash, parents, refs } in graph (log) order.
    const nodes: IColorNode[] = commits.map((c) => ({
      hash: c.hash,
      parents: c.parents,
      refs: refsByHash.get(c.hash) ?? [],
    }));

    const byMsg = new Map(commits.map((c) => [c.message.trim(), c.hash]));
    const h = (m: string): string => {
      const hash = byMsg.get(m);
      if (!hash) {
        throw new Error(`commit ${m} not in the log`);
      }
      return hash;
    };

    // Guard the topology the regression needs (else the test would pass vacuously).
    const trunkTipRefs = refsByHash.get(h('c4')) ?? [];
    assert.ok(
      trunkTipRefs.some((r) => r.name === 'main' && r.type === 'local'),
      'trunk tip carries local main'
    );
    assert.ok(
      trunkTipRefs.some((r) => r.name === 'origin/main' && r.type === 'remote'),
      'trunk tip carries remote origin/main'
    );
    const featureRefs = refsByHash.get(h('f1')) ?? [];
    assert.ok(
      featureRefs.some((r) => r.name === 'origin/feature' && r.type === 'remote'),
      'feature tip carries remote origin/feature (the sibling that used to steal the spine)'
    );
    assert.ok(
      !featureRefs.some((r) => r.type === 'local'),
      'feature tip is REMOTE-ONLY (a local branch would mask the regression)'
    );

    const colors = computeBranchColors(nodes, { headBranchName: 'main' });

    const trunkColor = colors.get(h('c4'));
    assert.ok(trunkColor, 'trunk tip has a color');
    for (const m of ['c1', 'c2', 'c3', 'c4']) {
      assert.strictEqual(
        colors.get(h(m)),
        trunkColor,
        `trunk commit ${m} shares the one mainline color (no multi-colored spine)`
      );
    }
    // The two below-fork commits are the ones the pre-fix logic mis-colored.
    assert.strictEqual(colors.get(h('c2')), trunkColor, 'fork-point stays the main color');
    assert.strictEqual(colors.get(h('c1')), trunkColor, 'trunk base stays the main color');
    // The feature gets its own color, distinct from the trunk.
    assert.notStrictEqual(colors.get(h('f1')), trunkColor, 'feature has its own color');
  });
});

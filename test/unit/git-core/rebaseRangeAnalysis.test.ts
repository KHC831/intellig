/**
 * Real-git coverage for {@link analyzeRebaseRange} — the pre-flight behind
 * the merge-flattening warning on "Interactively Rebase from Here".
 *
 * Fixture topology (oldest → newest):
 *
 *   A ── B ────────── M ── C   ← main (HEAD = C)
 *    \              /
 *     F1 ── F2 ────           ← feat, merged by M
 *
 * The interesting case is a SIDE-BRANCH base (F1): it renders adjacent to
 * the merge in a topo-ordered graph, but `F1..HEAD` spans everything main
 * gained since the branch forked — the flattening-rebase trap this
 * analysis exists to expose.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GitCli } from '../../../src/git-core/gitCli';
import { analyzeRebaseRange, isFirstParentAncestor } from '../../../src/git-core/rebaseRange';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TMP_ROOT = path.join(REPO_ROOT, 'workspace-notes', 'tmp');

describe('analyzeRebaseRange (real git)', () => {
  let repoPath: string;
  let gitCli: GitCli;
  const sha: Record<string, string> = {};

  async function git(...args: string[]): Promise<string> {
    const result = await gitCli.exec(args, { cwd: repoPath, throwOnError: true });
    return result.stdout.trim();
  }

  async function commit(name: string, file: string, content: string): Promise<void> {
    fs.writeFileSync(path.join(repoPath, file), content);
    await git('add', '.');
    await git('commit', '-m', name);
    sha[name] = await git('rev-parse', 'HEAD');
  }

  before(async () => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    repoPath = fs.mkdtempSync(path.join(TMP_ROOT, 'rebase-range-'));
    gitCli = new GitCli();
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await git('config', 'commit.gpgsign', 'false');

    await commit('A', 'a.txt', 'a');
    await commit('B', 'b.txt', 'b');
    await git('checkout', '-b', 'feat', sha.A);
    await commit('F1', 'f1.txt', 'f1');
    await commit('F2', 'f2.txt', 'f2');
    await git('checkout', 'main');
    await git('merge', '--no-ff', '-m', 'M', 'feat');
    sha.M = await git('rev-parse', 'HEAD');
    await commit('C', 'c.txt', 'c');
  });

  after(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('counts the full range for a side-branch base', async () => {
    // F1..HEAD = {B, F2, M, C}: everything main gained since feat forked.
    const analysis = await analyzeRebaseRange(gitCli, repoPath, sha.F1);
    assert.ok(analysis, 'analysis must resolve for a reachable base');
    assert.strictEqual(analysis.todoCommits, 3, 'B, F2, C are the flat todo entries');
    assert.strictEqual(analysis.mergeCommits, 1, 'M would be flattened away');
  });

  it('counts a mainline base beneath a merge', async () => {
    // B..HEAD = {F1, F2, M, C}.
    const analysis = await analyzeRebaseRange(gitCli, repoPath, sha.B);
    assert.ok(analysis);
    assert.strictEqual(analysis.todoCommits, 3, 'F1, F2, C');
    assert.strictEqual(analysis.mergeCommits, 1);
  });

  it('reports a merge-free range with zero merges', async () => {
    // M..HEAD = {C}.
    const analysis = await analyzeRebaseRange(gitCli, repoPath, sha.M);
    assert.ok(analysis);
    assert.strictEqual(analysis.todoCommits, 1);
    assert.strictEqual(analysis.mergeCommits, 0);
  });

  it('handles onto === HEAD (empty range)', async () => {
    const analysis = await analyzeRebaseRange(gitCli, repoPath, sha.C);
    assert.ok(analysis);
    assert.strictEqual(analysis.todoCommits, 0);
    assert.strictEqual(analysis.mergeCommits, 0);
  });

  it('returns undefined for an unresolvable base instead of throwing', async () => {
    const analysis = await analyzeRebaseRange(gitCli, repoPath, 'f'.repeat(40));
    assert.strictEqual(analysis, undefined);
  });

  describe('isFirstParentAncestor — is the CLICKED commit on the mainline?', () => {
    // The merged-branch hint keys off the clicked commit, and the FIRST
    // commit of a merged branch is the common case (single-commit PRs):
    // its parent is the mainline fork point, so a base-side check misses it.

    it('is false for every commit of the merged branch — including its first', async () => {
      assert.strictEqual(await isFirstParentAncestor(gitCli, repoPath, sha.F1), false);
      assert.strictEqual(await isFirstParentAncestor(gitCli, repoPath, sha.F2), false);
    });

    it('is true along the first-parent chain: direct commits, merges, HEAD', async () => {
      assert.strictEqual(await isFirstParentAncestor(gitCli, repoPath, sha.B), true);
      assert.strictEqual(await isFirstParentAncestor(gitCli, repoPath, sha.M), true);
      assert.strictEqual(await isFirstParentAncestor(gitCli, repoPath, sha.C), true);
    });

    it('degrades to true (no hint) when the rev cannot be analyzed', async () => {
      assert.strictEqual(await isFirstParentAncestor(gitCli, repoPath, 'f'.repeat(40)), true);
    });
  });
});

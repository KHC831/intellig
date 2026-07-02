/**
 * The shared restore-to-HEAD writer — one classifier for the four flows that
 * previously each got the added/renamed/tracked partition subtly wrong.
 * See src/git-core/worktree/restoreToHead.ts.
 */

import '../../setup';
import * as assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { GitCli } from '../../../src/git-core/gitCli';
import { restorePathsToHead } from '../../../src/git-core/worktree/restoreToHead';

interface Scripted {
  cli: GitCli;
  calls: string[][];
}

/**
 * GitCli stub. `inHead` lists the paths for which `cat-file -e HEAD:<path>`
 * exits 0; everything else exits 1. checkout/rm succeed.
 */
function makeCli(inHead: Set<string>): Scripted {
  const calls: string[][] = [];
  const cli = {
    exec: async (args: string[]) => {
      calls.push([...args]);
      if (args[0] === 'cat-file' && args[1] === '-e') {
        const spec = args[2].replace(/^HEAD:/, '');
        return inHead.has(spec)
          ? { exitCode: 0, stdout: '', stderr: '', combined: '' }
          : { exitCode: 1, stdout: '', stderr: 'not in HEAD', combined: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
  } as unknown as GitCli;
  return { cli, calls };
}

/** The paths of a `checkout HEAD --` call, or [] if none ran. */
function checkoutTargets(calls: string[][]): string[] {
  const call = calls.find((c) => c[0] === 'checkout' && c[1] === 'HEAD');
  return call ? call.slice(3) : [];
}
function unindexTargets(calls: string[][]): string[] {
  const call = calls.find((c) => c[0] === 'rm' && c.includes('--cached'));
  return call ? call.slice(call.indexOf('--') + 1) : [];
}

describe('restorePathsToHead', () => {
  it('restores a HEAD-tracked (modified) file via checkout HEAD --', async () => {
    const { cli, calls } = makeCli(new Set(['mod.ts']));
    await restorePathsToHead(cli, '/repo', [{ path: 'mod.ts' }]);
    assert.deepStrictEqual(checkoutTargets(calls), ['mod.ts']);
    assert.deepStrictEqual(unindexTargets(calls), [], 'a tracked file must not be unindexed');
  });

  it('unindexes an ADDED file instead of checking it out (would fatal)', async () => {
    const { cli, calls } = makeCli(new Set()); // nothing in HEAD → added
    await restorePathsToHead(cli, '/repo', [{ path: 'added.ts' }]);
    assert.deepStrictEqual(unindexTargets(calls), ['added.ts']);
    assert.deepStrictEqual(
      checkoutTargets(calls),
      [],
      'an added file has no HEAD blob — checkout would fail'
    );
  });

  it('for a rename, unindexes the new path AND restores the old path from HEAD', async () => {
    const { cli, calls } = makeCli(new Set(['old.ts'])); // old in HEAD, new is not
    await restorePathsToHead(cli, '/repo', [{ path: 'new.ts', oldPath: 'old.ts' }]);
    assert.deepStrictEqual(unindexTargets(calls), ['new.ts']);
    assert.deepStrictEqual(checkoutTargets(calls), ['old.ts']);
  });

  it('batches every checkout into ONE call so a mixed selection cannot half-apply', async () => {
    const { cli, calls } = makeCli(new Set(['a.ts', 'b.ts']));
    await restorePathsToHead(cli, '/repo', [
      { path: 'a.ts' },
      { path: 'added.ts' },
      { path: 'b.ts' },
    ]);
    const checkoutCalls = calls.filter((c) => c[0] === 'checkout');
    assert.strictEqual(checkoutCalls.length, 1, 'exactly one checkout call');
    assert.deepStrictEqual(checkoutTargets(calls), ['a.ts', 'b.ts']);
    assert.deepStrictEqual(unindexTargets(calls), ['added.ts']);
  });

  it('runs unindex before the batched checkout', async () => {
    const { cli, calls } = makeCli(new Set(['a.ts']));
    await restorePathsToHead(cli, '/repo', [{ path: 'a.ts' }, { path: 'added.ts' }]);
    const verbs = calls.map((c) => c[0]);
    assert.ok(verbs.indexOf('rm') < verbs.lastIndexOf('checkout'), 'rm --cached before checkout');
  });

  it('deletes an added file from disk only when opted in — and refuses to escape the repo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'));
    try {
      const victim = path.join(dir, 'added.ts');
      fs.writeFileSync(victim, 'x');
      const { cli } = makeCli(new Set());
      await restorePathsToHead(cli, dir, [
        { path: 'added.ts', removeFromDiskIfAbsentFromHead: true },
      ]);
      assert.ok(!fs.existsSync(victim), 'opted-in added file must be deleted from disk');

      // Escape attempt is refused.
      const { cli: cli2 } = makeCli(new Set());
      await assert.rejects(
        restorePathsToHead(cli2, dir, [
          { path: '../escape.ts', removeFromDiskIfAbsentFromHead: true },
        ]),
        /outside the repository/
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an added file on disk when not opted in (git4idea default)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'));
    try {
      const kept = path.join(dir, 'added.ts');
      fs.writeFileSync(kept, 'x');
      const { cli } = makeCli(new Set());
      await restorePathsToHead(cli, dir, [{ path: 'added.ts' }]);
      assert.ok(fs.existsSync(kept), 'added file stays as untracked when not opted in');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

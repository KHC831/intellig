/**
 * P1 parity fix — merge-commit diff must offer a parent picker.
 *
 * `intellig.commit.showDiff` always diffed against `parents[0]`, so a merge
 * commit silently showed only the first-parent diff with no way to pick the
 * other side. IntelliJ prompts for which parent. `resolveDiffParent` is the
 * pure decision: sole parent / root `~1` pass through; a merge (2+ parents)
 * defers to an injected picker.
 */

import '../../setup';
import * as assert from 'assert';
import { resolveDiffParent } from '../../../src/commands/registration/commitMenuCommands';

describe('resolveDiffParent (P1: merge-commit diff parent picker)', () => {
  it('uses <hash>~1 for a root commit (no parents), without prompting', async () => {
    let picked = false;
    const r = await resolveDiffParent('abc123', [], async () => {
      picked = true;
      return undefined;
    });
    assert.strictEqual(r, 'abc123~1');
    assert.strictEqual(picked, false);
  });

  it('uses the sole parent for a normal commit, without prompting', async () => {
    let picked = false;
    const r = await resolveDiffParent('abc', ['p1'], async () => {
      picked = true;
      return undefined;
    });
    assert.strictEqual(r, 'p1');
    assert.strictEqual(picked, false);
  });

  it('prompts for a merge commit (2+ parents) and returns the chosen parent', async () => {
    const seen: string[][] = [];
    const r = await resolveDiffParent('m', ['p1', 'p2'], async (parents) => {
      seen.push(parents);
      return 'p2';
    });
    assert.deepStrictEqual(seen, [['p1', 'p2']]);
    assert.strictEqual(r, 'p2');
  });

  it('returns undefined when the merge-parent picker is cancelled', async () => {
    const r = await resolveDiffParent('m', ['p1', 'p2'], async () => undefined);
    assert.strictEqual(r, undefined);
  });
});

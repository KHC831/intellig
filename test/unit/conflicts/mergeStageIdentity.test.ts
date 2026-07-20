/**
 * The merge window keys open windows by the conflict's stage identity, and the
 * three outcomes of reading it are NOT interchangeable:
 *
 *   identity      — this exact conflict; reuse the window open on it
 *   notConflicted — resolved elsewhere; a window open on it is stale, dispose
 *   unreadable    — the index said nothing; act on nothing, reveal and return
 *
 * Confusing the last two is the expensive direction: disposing a window over a
 * transient `index.lock` destroys an unsaved resolution. `git ls-files -u` runs
 * with `throwOnError: false`, so a failed read arrives as a NON-ZERO EXIT, not
 * an exception — a fixture that only makes exec throw exercises a path that
 * already worked and proves nothing about the one that did not.
 */

import '../../setup';
import * as assert from 'assert';
import { GitCli } from '../../../src/git-core/gitCli';
import {
  readStageIdentity,
  stageIdentityOf,
} from '../../../src/conflicts/merge-window/mergeStages';
import { __mergeWindowKeyingForTest } from '../../../src/conflicts/MergeView';

const NUL = '\u0000';

/** A `git ls-files -u -z` record: `<mode> <sha> <stage>\t<path>\0`. */
function rec(stage: 1 | 2 | 3, path: string): string {
  return `100644 ${String(stage).repeat(40)} ${stage}\t${path}${NUL}`;
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A GitCli whose `exec` returns a fixed result, or throws when told to. */
function fakeCli(result: ExecResult | Error): GitCli {
  return {
    exec: async (): Promise<ExecResult> => {
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  } as unknown as GitCli;
}

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' });

describe('readStageIdentity — the three outcomes', () => {
  it('reports an identity for a conflicted path', async () => {
    const cli = fakeCli(ok(rec(1, 'f.txt') + rec(2, 'f.txt') + rec(3, 'f.txt')));

    const read = await readStageIdentity(cli, '/repo', 'f.txt');

    assert.strictEqual(read.kind, 'identity');
    assert.strictEqual(
      read.kind === 'identity' ? read.identity : '',
      stageIdentityOf({ base: '1'.repeat(40), ours: '2'.repeat(40), theirs: '3'.repeat(40) })
    );
  });

  it('reports notConflicted when the index genuinely lists no stages', async () => {
    // The control that gives the failing case its meaning: an EMPTY read on a
    // SUCCESSFUL command really does mean the path is resolved.
    const cli = fakeCli(ok(''));

    assert.strictEqual((await readStageIdentity(cli, '/repo', 'f.txt')).kind, 'notConflicted');
  });

  it('reports unreadable when git EXITS NON-ZERO', async () => {
    // The live defect: `ls-files -u` runs with throwOnError:false, so a locked
    // index arrives here as exit 128 with empty stdout. Flattened to an empty
    // map it becomes "notConflicted", and the caller disposes a window holding
    // the user's unsaved resolution.
    const cli = fakeCli({
      exitCode: 128,
      stdout: '',
      stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
    });

    const read = await readStageIdentity(cli, '/repo', 'f.txt');

    assert.strictEqual(read.kind, 'unreadable', 'a failed read is not a resolved path');
  });

  it('reports unreadable when exec throws', async () => {
    // The path that already worked. Kept as a control: it must not be the only
    // failing-read fixture, or the non-zero case above can regress unnoticed.
    const cli = fakeCli(new Error('spawn ENOENT'));

    assert.strictEqual((await readStageIdentity(cli, '/repo', 'f.txt')).kind, 'unreadable');
  });

  it('reports notConflicted for a path absent from a non-empty index read', async () => {
    // Another path is conflicted; this one is not. Still a real answer.
    const cli = fakeCli(ok(rec(2, 'other.txt')));

    assert.strictEqual((await readStageIdentity(cli, '/repo', 'f.txt')).kind, 'notConflicted');
  });

  it('changes identity when the conflict on a path changes', async () => {
    // What the key is FOR: a later, unrelated conflict on the same path must
    // not reuse the window holding the earlier one.
    const later =
      `100644 ${'a'.repeat(40)} 2\tf.txt${NUL}` + `100644 ${'b'.repeat(40)} 3\tf.txt${NUL}`;
    const first = await readStageIdentity(
      fakeCli(ok(rec(2, 'f.txt') + rec(3, 'f.txt'))),
      '/r',
      'f.txt'
    );
    const second = await readStageIdentity(fakeCli(ok(later)), '/r', 'f.txt');

    assert.strictEqual(first.kind, 'identity');
    assert.strictEqual(second.kind, 'identity');
    assert.notStrictEqual(
      first.kind === 'identity' ? first.identity : '',
      second.kind === 'identity' ? second.identity : ''
    );
  });
});

describe('mergeWindowKey — one window per conflict, not per path', () => {
  const { WINDOW_KEY_SEP, mergeWindowKey } = __mergeWindowKeyingForTest;

  it('separates path from identity with NUL', () => {
    // NUL cannot occur in a path or a SHA, which is what stops one pair from
    // spoofing another's key.
    assert.strictEqual(WINDOW_KEY_SEP, '\0');
    assert.strictEqual(mergeWindowKey('a.txt', 'x:y:z'), `a.txt\0x:y:z`);
  });

  it('keys two conflicts on the same path differently', () => {
    assert.notStrictEqual(mergeWindowKey('a.txt', 'x:y:z'), mergeWindowKey('a.txt', 'p:q:r'));
  });

  it('keys the same conflict on different paths differently', () => {
    assert.notStrictEqual(mergeWindowKey('a.txt', 'x:y:z'), mergeWindowKey('b.txt', 'x:y:z'));
  });

  it('gives an unknown identity an empty suffix that still carries the separator', () => {
    // The prefix `path + SEP` is what the supersede scan matches on, so it must
    // be present even when the identity is not known.
    const key = mergeWindowKey('a.txt', undefined);

    assert.strictEqual(key, `a.txt\0`);
    assert.ok(key.startsWith(`a.txt${WINDOW_KEY_SEP}`), 'the supersede scan can still find it');
  });

  it('cannot be spoofed by a path that contains the identity text', () => {
    // Without a separator no path/identity pair could be told from another.
    assert.notStrictEqual(
      mergeWindowKey('a.txtx:y:z', undefined),
      mergeWindowKey('a.txt', 'x:y:z')
    );
  });
});

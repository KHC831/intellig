/**
 * Tests for the shared test-scratch root helper (test/helpers/scratchRoot.ts):
 * the self-healing sweep that empties workspace-notes/tmp before and after a
 * mocha run, so repos leaked by an interrupted run never accumulate (and never
 * show up in the extension's repo discovery).
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT, cleanScratchRoot } from '../../helpers/scratchRoot';

describe('scratchRoot — self-healing test scratch dir', () => {
  it('SCRATCH_ROOT is the gitignored workspace-notes/tmp inside this repo', () => {
    assert.strictEqual(SCRATCH_ROOT, path.resolve(__dirname, '../../../workspace-notes/tmp'));
  });

  it('cleanScratchRoot removes every entry but keeps the root itself', () => {
    const leakedRepo = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'leaked-'));
    fs.mkdirSync(path.join(leakedRepo, '.git'));
    fs.writeFileSync(path.join(leakedRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const strayFile = path.join(SCRATCH_ROOT, 'stray.txt');
    fs.writeFileSync(strayFile, 'junk');

    cleanScratchRoot();

    assert.ok(!fs.existsSync(leakedRepo), 'leaked repo dir removed');
    assert.ok(!fs.existsSync(strayFile), 'stray file removed');
    assert.ok(fs.existsSync(SCRATCH_ROOT), 'the scratch root itself survives');
    assert.strictEqual(fs.readdirSync(SCRATCH_ROOT).length, 0, 'root left empty');
  });

  it('creates the root when it does not exist yet', () => {
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
    cleanScratchRoot();
    assert.ok(fs.existsSync(SCRATCH_ROOT));
  });

  it('refuses to sweep a directory that is not a workspace-notes/tmp', () => {
    assert.throws(() => cleanScratchRoot('/some/other/dir'), /workspace-notes.tmp/);
  });

  /**
   * Finder recreates .DS_Store inside a directory while the recursive delete is
   * walking it, so the rmdir lands on a now-non-empty directory and throws
   * ENOTEMPTY. That killed a whole suite run mid-sweep. One retry absorbs the
   * concurrent write; a second failure is a real fault and still propagates.
   */
  it('retries once when a concurrent write makes the sweep fail ENOTEMPTY', () => {
    let calls = 0;
    const removeTree = (target: string): void => {
      calls++;
      if (calls === 1) {
        const err = new Error('ENOTEMPTY: directory not empty') as NodeJS.ErrnoException;
        err.code = 'ENOTEMPTY';
        throw err;
      }
      fs.rmSync(target, { recursive: true, force: true });
    };

    assert.doesNotThrow(() => cleanScratchRoot(SCRATCH_ROOT, removeTree));
    assert.strictEqual(calls, 2, 'swept again after the concurrent write');
  });

  it('rethrows when the sweep keeps failing', () => {
    const removeTree = (): void => {
      const err = new Error('ENOTEMPTY: directory not empty') as NodeJS.ErrnoException;
      err.code = 'ENOTEMPTY';
      throw err;
    };

    assert.throws(() => cleanScratchRoot(SCRATCH_ROOT, removeTree), /ENOTEMPTY/);
  });

  it('does not retry an unrelated failure', () => {
    let calls = 0;
    const removeTree = (): void => {
      calls++;
      const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };

    assert.throws(() => cleanScratchRoot(SCRATCH_ROOT, removeTree), /EACCES/);
    assert.strictEqual(calls, 1, 'a permission fault is not a race — fail fast');
  });
});

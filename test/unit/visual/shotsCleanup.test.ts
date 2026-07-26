/**
 * The visual lane's screenshot directory is cleared at the start of every run.
 *
 * Without this it accumulates: a `--FAILED` image from a spec that was fixed
 * weeks ago sits beside one from the run that just finished, identical in every
 * respect, and the directory reads as a list of current failures. That happened
 * — ten stale images, every one from a test written to fail on purpose.
 *
 * Clearing deletes PNGs only, non-recursively. The directory is gitignored and
 * a person may well have put something else in it; a run of the test suite is
 * not licence to remove it.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { clearShots } from '../../visual/support/capture';

const TMP_ROOT = path.join(process.cwd(), 'workspace-notes/tmp');

function withDir(fn: (dir: string) => void): void {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'shots-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('visual lane screenshot cleanup', () => {
  it('removes images left by earlier runs', () => {
    withDir((dir) => {
      fs.writeFileSync(path.join(dir, 'some-spec.png'), 'x');
      fs.writeFileSync(path.join(dir, 'other-spec--FAILED.png'), 'x');
      clearShots(dir);
      assert.deepStrictEqual(fs.readdirSync(dir), []);
    });
  });

  it('leaves anything that is not an image alone', () => {
    withDir((dir) => {
      fs.writeFileSync(path.join(dir, 'stale.png'), 'x');
      fs.writeFileSync(path.join(dir, 'notes.md'), 'keep me');
      clearShots(dir);
      assert.deepStrictEqual(fs.readdirSync(dir), ['notes.md']);
    });
  });

  it('does not descend into subdirectories', () => {
    withDir((dir) => {
      const nested = path.join(dir, 'keep');
      fs.mkdirSync(nested);
      fs.writeFileSync(path.join(nested, 'saved.png'), 'x');
      clearShots(dir);
      assert.ok(fs.existsSync(path.join(nested, 'saved.png')), 'a nested image must survive');
    });
  });

  it('does nothing when the directory does not exist', () => {
    withDir((dir) => {
      const missing = path.join(dir, 'absent');
      assert.doesNotThrow(() => clearShots(missing));
      assert.strictEqual(fs.existsSync(missing), false, 'it must not create the directory either');
    });
  });
});

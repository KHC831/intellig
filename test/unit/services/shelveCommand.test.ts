/**
 * Unit tests for `normalizeShelvePreselect` — the argument normalizer behind
 * the single `intellig.shelve` command, which feeds the Shelve dialog's
 * pre-check set from whichever entry point invoked it.
 */

import '../../setup';
import * as assert from 'assert';
import {
  normalizeShelvePreselect,
  firstUriArg,
} from '../../../src/commands/registration/stashShelfCommands';
import { Uri } from '../../mocks/vscode';

const ROOT = '/repo';

describe('firstUriArg', () => {
  it('returns the Uri itself', () => {
    const u = Uri.file('/repo/src/a.ts');
    assert.strictEqual(firstUriArg(u), u);
  });
  it('returns the first Uri of an array (explorer multi-select)', () => {
    const a = Uri.file('/repo/src/a.ts');
    assert.strictEqual(firstUriArg([a, Uri.file('/repo/b.ts')]), a);
  });
  it('returns undefined for a path string or no arg', () => {
    assert.strictEqual(firstUriArg('src/a.ts'), undefined);
    assert.strictEqual(firstUriArg(undefined), undefined);
  });
});

describe('normalizeShelvePreselect', () => {
  it('no argument (command palette) → undefined (check all)', () => {
    assert.strictEqual(normalizeShelvePreselect(undefined, ROOT), undefined);
  });

  it('empty / whitespace string → undefined (check all)', () => {
    assert.strictEqual(normalizeShelvePreselect('', ROOT), undefined);
    assert.strictEqual(normalizeShelvePreselect('   ', ROOT), undefined);
  });

  it('a repo-relative path string → that single file', () => {
    assert.deepStrictEqual(normalizeShelvePreselect('src/a.ts', ROOT), ['src/a.ts']);
  });

  it('a Uri → repo-relative path', () => {
    assert.deepStrictEqual(normalizeShelvePreselect(Uri.file('/repo/src/a.ts'), ROOT), [
      'src/a.ts',
    ]);
  });

  it('a Uri[] (explorer multi-select) → repo-relative paths', () => {
    assert.deepStrictEqual(
      normalizeShelvePreselect([Uri.file('/repo/src/a.ts'), Uri.file('/repo/src/b.ts')], ROOT),
      ['src/a.ts', 'src/b.ts']
    );
  });

  it('unrecognized argument → undefined', () => {
    assert.strictEqual(normalizeShelvePreselect(42, ROOT), undefined);
    assert.strictEqual(normalizeShelvePreselect({ nope: true }, ROOT), undefined);
  });
});

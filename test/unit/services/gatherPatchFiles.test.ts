/**
 * Unit tests for the Import Patches recursive collection
 * (ShelveChangesManager.gatherPatchFiles counterpart): directory expansion,
 * patch-extension filtering, dedupe, and the missing-path deferral.
 */
import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { gatherPatchFiles, isPatchFilePath } from '../../../src/shelf/gatherPatchFiles';

const TMP_ROOT = path.join(path.resolve(__dirname, '../../..'), 'workspace-notes', 'tmp');

describe('gatherPatchFiles', () => {
  let root: string;

  beforeEach(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    root = fs.mkdtempSync(path.join(TMP_ROOT, 'gather-patch-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function seed(relPath: string, content = 'diff --git a/x b/x\n'): string {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  it('recursively collects *.patch and *.diff from a picked directory, skipping other files', async () => {
    const a = seed('a.patch');
    const b = seed('sub/b.diff');
    seed('sub/c.txt');
    seed('sub/deeper/readme.md');
    const d = seed('sub/deeper/d.PATCH');

    const result = await gatherPatchFiles([root]);

    assert.deepStrictEqual(result.sort(), [a, b, d].sort());
  });

  it('keeps directly picked patch files and drops directly picked non-patch files', async () => {
    const a = seed('a.patch');
    const txt = seed('notes.txt');

    const result = await gatherPatchFiles([a, txt]);

    assert.deepStrictEqual(result, [a]);
  });

  it('dedupes a file picked directly and reached through a picked directory', async () => {
    const a = seed('a.patch');

    const result = await gatherPatchFiles([a, root]);

    assert.deepStrictEqual(result, [a]);
  });

  it('keeps a missing patch-typed path so the import surfaces the real error', async () => {
    const ghost = path.join(root, 'missing.patch');

    const result = await gatherPatchFiles([ghost]);

    assert.deepStrictEqual(result, [ghost]);
  });

  it('drops a missing non-patch path', async () => {
    const result = await gatherPatchFiles([path.join(root, 'missing.txt')]);

    assert.deepStrictEqual(result, []);
  });

  it('returns [] for an empty selection and a patch-free directory', async () => {
    seed('sub/c.txt');
    assert.deepStrictEqual(await gatherPatchFiles([]), []);
    assert.deepStrictEqual(await gatherPatchFiles([root]), []);
  });
});

describe('isPatchFilePath', () => {
  it('accepts .patch/.diff case-insensitively and rejects everything else', () => {
    assert.strictEqual(isPatchFilePath('/x/a.patch'), true);
    assert.strictEqual(isPatchFilePath('/x/a.DIFF'), true);
    assert.strictEqual(isPatchFilePath('/x/a.txt'), false);
    assert.strictEqual(isPatchFilePath('/x/patch'), false);
    assert.strictEqual(isPatchFilePath('/x/a.patch.bak'), false);
  });
});

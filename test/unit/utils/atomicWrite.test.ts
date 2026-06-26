/**
 * Unit tests for the atomic-write helper.
 *
 * Exercises the three guarantees callers rely on:
 *   1. Happy path — content lands at targetPath, no debris.
 *   2. Crash-during-write — an error mid-write leaves the existing target
 *      file untouched and removes the temp file.
 *   3. Mode preservation — `{ mode: 0o755 }` is honored (RebaseService
 *      relies on the script being executable).
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  atomicWriteFile,
  atomicWriteFileSync,
  type IAtomicWriteFs,
  type IAtomicWriteFsAsync,
} from '../../../src/utils/atomicWrite';

describe('atomicWriteFileSync', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-atomic-write-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('writes content atomically to the target path', () => {
    const target = path.join(tmpDir, 'state.json');
    atomicWriteFileSync(target, '{"a":1}', { encoding: 'utf8' });
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"a":1}');
  });

  it('leaves no temp files in the target directory after a successful write', () => {
    const target = path.join(tmpDir, 'state.json');
    atomicWriteFileSync(target, '{}', { encoding: 'utf8' });
    const entries = fs.readdirSync(tmpDir);
    // Only the target file should remain.
    assert.deepStrictEqual(entries, ['state.json']);
  });

  it('overwrites an existing file at the target path', () => {
    const target = path.join(tmpDir, 'state.json');
    fs.writeFileSync(target, 'OLD', 'utf8');
    atomicWriteFileSync(target, 'NEW', { encoding: 'utf8' });
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'NEW');
  });

  it('applies the requested file mode (executable bits preserved for RebaseService)', function () {
    if (process.platform === 'win32') {
      // Windows NTFS ignores POSIX mode bits the way we care about. Skip.
      this.skip();
      return;
    }
    const target = path.join(tmpDir, 'rebase-todo-script.sh');
    atomicWriteFileSync(target, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    const stat = fs.statSync(target);
    // Masking: we only care about the lower 9 bits (user/group/other rwx).
    assert.strictEqual(
      stat.mode & 0o777,
      0o755,
      `expected 0o755, got ${(stat.mode & 0o777).toString(8)}`
    );
  });

  it('crash-sim: when renameSync throws, no temp file is left behind AND target is unchanged', () => {
    const target = path.join(tmpDir, 'state.json');
    fs.writeFileSync(target, 'OLD', 'utf8');

    // Inject a fault-injection fs double that simulates a mid-write crash
    // (e.g. filesystem busy on Windows NTFS). The real writeFileSync runs
    // so the temp file actually materializes and our cleanup path must
    // remove it.
    const faulty: IAtomicWriteFs = {
      writeFileSync: fs.writeFileSync,
      renameSync: (): never => {
        throw new Error('simulated crash during rename');
      },
      existsSync: fs.existsSync,
      unlinkSync: fs.unlinkSync,
    };

    assert.throws(
      () => atomicWriteFileSync(target, 'NEW', { encoding: 'utf8' }, faulty),
      /simulated crash/
    );

    // Existing file still has the OLD content — atomic guarantee.
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'OLD');
    // Directory should contain ONLY the target, no .state.json.tmp-* leftover.
    const entries = fs.readdirSync(tmpDir);
    assert.deepStrictEqual(
      entries,
      ['state.json'],
      `expected no temp debris; got ${entries.join(',')}`
    );
  });

  it('crash-sim: when writeFileSync throws, no temp file is left behind AND target is unchanged', () => {
    const target = path.join(tmpDir, 'state.json');
    fs.writeFileSync(target, 'OLD', 'utf8');

    const faulty: IAtomicWriteFs = {
      writeFileSync: ((): never => {
        throw new Error('disk full');
      }) as unknown as typeof fs.writeFileSync,
      renameSync: fs.renameSync,
      existsSync: fs.existsSync,
      unlinkSync: fs.unlinkSync,
    };

    assert.throws(
      () => atomicWriteFileSync(target, 'NEW', { encoding: 'utf8' }, faulty),
      /disk full/
    );

    // Existing file intact.
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'OLD');
    // No temp files leaked — the writeFileSync threw BEFORE producing a file.
    const entries = fs.readdirSync(tmpDir);
    assert.deepStrictEqual(entries, ['state.json']);
  });

  it('swallows secondary errors from unlink when cleanup itself fails, preserving the original error', () => {
    const target = path.join(tmpDir, 'state.json');
    fs.writeFileSync(target, 'OLD', 'utf8');

    const faulty: IAtomicWriteFs = {
      writeFileSync: fs.writeFileSync,
      renameSync: (): never => {
        throw new Error('primary rename error');
      },
      existsSync: (): boolean => true,
      unlinkSync: (): never => {
        throw new Error('secondary unlink error');
      },
    };

    // Primary error (rename) must surface; the secondary (unlink) is swallowed.
    assert.throws(
      () => atomicWriteFileSync(target, 'NEW', { encoding: 'utf8' }, faulty),
      /primary rename error/
    );
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'OLD');
  });

  it('supports Buffer payloads (no-encoding mode)', () => {
    const target = path.join(tmpDir, 'state.bin');
    const payload = Buffer.from([0x01, 0x02, 0x03]);
    atomicWriteFileSync(target, payload);
    assert.deepStrictEqual(fs.readFileSync(target), payload);
  });
});

// Async variant covering the same invariants. Used by
// MergeView.markResolved, which runs on the extension-host event loop
// and cannot block on sync I/O.
describe('atomicWriteFile (async)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-atomic-write-async-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('writes content atomically to the target path', async () => {
    const target = path.join(tmpDir, 'resolved.ts');
    await atomicWriteFile(target, 'const x = 1;\n', { encoding: 'utf8' });
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'const x = 1;\n');
  });

  it('leaves no temp files in the target directory after a successful write', async () => {
    const target = path.join(tmpDir, 'resolved.ts');
    await atomicWriteFile(target, 'ok', { encoding: 'utf8' });
    const entries = fs.readdirSync(tmpDir);
    assert.deepStrictEqual(entries, ['resolved.ts']);
  });

  it('overwrites an existing file at the target path', async () => {
    const target = path.join(tmpDir, 'resolved.ts');
    fs.writeFileSync(target, 'OLD', 'utf8');
    await atomicWriteFile(target, 'NEW', { encoding: 'utf8' });
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'NEW');
  });

  it('applies the requested file mode', async function () {
    if (process.platform === 'win32') {
      this.skip();
      return;
    }
    const target = path.join(tmpDir, 'executable.sh');
    await atomicWriteFile(target, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    const stat = fs.statSync(target);
    assert.strictEqual(
      stat.mode & 0o777,
      0o755,
      `expected 0o755, got ${(stat.mode & 0o777).toString(8)}`
    );
  });

  it('crash-sim: when rename throws, no temp file is left behind AND target is unchanged', async () => {
    const target = path.join(tmpDir, 'resolved.ts');
    fs.writeFileSync(target, 'OLD', 'utf8');

    const faulty: IAtomicWriteFsAsync = {
      writeFile: fs.promises.writeFile,
      rename: (): Promise<never> => Promise.reject(new Error('simulated crash during rename')),
      unlink: fs.promises.unlink,
      exists: async (p) => {
        try {
          await fs.promises.access(p);
          return true;
        } catch {
          return false;
        }
      },
    };

    await assert.rejects(
      () => atomicWriteFile(target, 'NEW', { encoding: 'utf8' }, faulty),
      /simulated crash/
    );

    // Original content preserved — atomic guarantee.
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'OLD');
    // No temp debris.
    const entries = fs.readdirSync(tmpDir);
    assert.deepStrictEqual(
      entries,
      ['resolved.ts'],
      `expected no temp debris; got ${entries.join(',')}`
    );
  });

  it('crash-sim: when writeFile throws, no temp file is left behind AND target is unchanged', async () => {
    const target = path.join(tmpDir, 'resolved.ts');
    fs.writeFileSync(target, 'OLD', 'utf8');

    const faulty: IAtomicWriteFsAsync = {
      writeFile: ((): Promise<never> =>
        Promise.reject(new Error('disk full'))) as unknown as typeof fs.promises.writeFile,
      rename: fs.promises.rename,
      unlink: fs.promises.unlink,
      exists: async () => false,
    };

    await assert.rejects(
      () => atomicWriteFile(target, 'NEW', { encoding: 'utf8' }, faulty),
      /disk full/
    );

    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'OLD');
    const entries = fs.readdirSync(tmpDir);
    assert.deepStrictEqual(entries, ['resolved.ts']);
  });

  it('swallows secondary errors from unlink when cleanup itself fails, preserving the original error', async () => {
    const target = path.join(tmpDir, 'resolved.ts');
    fs.writeFileSync(target, 'OLD', 'utf8');

    const faulty: IAtomicWriteFsAsync = {
      writeFile: fs.promises.writeFile,
      rename: (): Promise<never> => Promise.reject(new Error('primary rename error')),
      unlink: (): Promise<never> => Promise.reject(new Error('secondary unlink error')),
      exists: async () => true,
    };

    await assert.rejects(
      () => atomicWriteFile(target, 'NEW', { encoding: 'utf8' }, faulty),
      /primary rename error/
    );
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'OLD');
  });

  it('supports Buffer payloads (no-encoding mode)', async () => {
    const target = path.join(tmpDir, 'resolved.bin');
    const payload = Buffer.from([0x01, 0x02, 0x03]);
    await atomicWriteFile(target, payload);
    assert.deepStrictEqual(fs.readFileSync(target), payload);
  });

  it('falls through to real fs when no fsImpl argument is provided', async () => {
    // Smoke test — ensures the default `defaultFsAsync` object is well-formed
    // (i.e. every field resolves to a real `fs.promises.*` function). Guards
    // against a regression where a typo in one of the defaults would only
    // surface when a caller opted out of DI.
    const target = path.join(tmpDir, 'default-impl.txt');
    await atomicWriteFile(target, 'hello');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'hello');
  });
});

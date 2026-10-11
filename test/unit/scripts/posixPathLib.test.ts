/**
 * Spec for scripts/lib/posix-path.mjs: a relative path is spelled with `/`
 * whatever the host separator, so guards compare and print one form.
 */
import * as assert from 'assert';
import * as path from 'path';

interface PosixPathLib {
  posixRelative(from: string, to: string, impl?: typeof path): string;
}

const load = (): Promise<PosixPathLib> =>
  import(path.join(process.cwd(), 'scripts/lib/posix-path.mjs')) as Promise<PosixPathLib>;

describe('posixRelative (scripts/lib/posix-path.mjs)', () => {
  it('spells a Windows relative path with forward slashes', async () => {
    const { posixRelative } = await load();
    assert.strictEqual(
      posixRelative('D:\\a\\repo', 'D:\\a\\repo\\src\\x\\a.ts', path.win32),
      'src/x/a.ts'
    );
  });

  it('leaves a POSIX relative path as it is', async () => {
    const { posixRelative } = await load();
    assert.strictEqual(posixRelative('/repo', '/repo/src/a.ts', path.posix), 'src/a.ts');
    assert.strictEqual(posixRelative('/repo/src', '/repo/docs/b.md', path.posix), '../docs/b.md');
  });
});

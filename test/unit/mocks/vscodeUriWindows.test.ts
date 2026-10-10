/**
 * The vscode mock's Uri behaves like `vscode-uri` on Windows, so a test run
 * on a Windows runner reads the same paths production gets there. Checked
 * here with the Windows rules switched on explicitly, on any platform.
 */
import * as assert from 'assert';
import * as path from 'path';
import { fileUriPath, uriFsPath } from '../../mocks/vscode';

const win = (p: string): string => uriFsPath(fileUriPath(p, true), true);

describe('vscode mock Uri on Windows', () => {
  it('stores a drive path with slashes and a leading slash', () => {
    assert.strictEqual(fileUriPath('C:\\repo\\a.txt', true), '/C:/repo/a.txt');
    assert.strictEqual(fileUriPath('\\repo', true), '/repo');
  });

  it('gives back the backslash path it was built from', () => {
    assert.strictEqual(win('C:\\repo\\a.txt'), 'C:\\repo\\a.txt');
    assert.strictEqual(win('\\repo'), '\\repo');
  });

  it('reads a joined path the way path.win32.join writes it', () => {
    const joined = `${fileUriPath('\\repo', true)}/changes.patch`;
    assert.strictEqual(uriFsPath(joined, true), path.win32.join('\\repo', 'changes.patch'));
  });

  it('leaves POSIX paths exactly as given', () => {
    assert.strictEqual(fileUriPath('/repo/a', false), '/repo/a');
    assert.strictEqual(uriFsPath('/repo/a', false), '/repo/a');
  });
});

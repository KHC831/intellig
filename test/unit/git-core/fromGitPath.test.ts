/**
 * Spec for fromGitPath: an absolute path git printed, spelled the way this
 * host spells paths. Git prints `D:/a/b` on Windows, where Node and VS Code
 * spell `D:\a\b`.
 */
import * as assert from 'assert';
import * as path from 'path';
import { fromGitPath } from '../../../src/git-core/fromGitPath';

describe('fromGitPath', () => {
  it('spells a Windows path git printed with backslashes', () => {
    assert.strictEqual(fromGitPath('D:/a/repo', path.win32), 'D:\\a\\repo');
    assert.strictEqual(fromGitPath('C:/Users/me/My Repo', path.win32), 'C:\\Users\\me\\My Repo');
  });

  it('leaves a POSIX path as git printed it', () => {
    assert.strictEqual(fromGitPath('/home/me/repo', path.posix), '/home/me/repo');
  });

  it('uses the host spelling by default', () => {
    assert.strictEqual(fromGitPath('/a//b'), path.normalize('/a//b'));
  });
});

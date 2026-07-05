import '../../setup';
import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { abbreviateHomePath } from '../../../src/utils/displayPath';

describe('abbreviateHomePath', () => {
  const home = os.homedir();

  it('replaces a leading home directory with ~', () => {
    const p = path.join(home, 'Documents', 'workspace', 'intellig');
    assert.strictEqual(abbreviateHomePath(p), path.join('~', 'Documents', 'workspace', 'intellig'));
  });

  it('returns ~ for the home directory itself', () => {
    assert.strictEqual(abbreviateHomePath(home), '~');
  });

  it('leaves a path outside home unchanged', () => {
    const p = path.join(path.sep, 'srv', 'repos', 'app');
    assert.strictEqual(abbreviateHomePath(p), p);
  });

  it('does not abbreviate a path that merely shares a home prefix without a separator', () => {
    // e.g. home=/Users/bob, path=/Users/bobby/x must NOT become ~by/x
    const sibling = home + 'by';
    assert.strictEqual(abbreviateHomePath(sibling), sibling);
  });
});

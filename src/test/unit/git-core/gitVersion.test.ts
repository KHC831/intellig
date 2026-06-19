/**
 * Unit tests for git version parsing + capability gating (M6).
 */

import '../../setup';
import * as assert from 'assert';
import {
  parseGitVersion,
  gitVersionAtLeast,
  supportsUpdateRefs,
} from '../../../git-core/gitVersion';

describe('parseGitVersion', () => {
  it('parses the standard banner', () => {
    assert.deepStrictEqual(parseGitVersion('git version 2.38.1'), {
      major: 2,
      minor: 38,
      patch: 1,
    });
  });

  it('parses an Apple/vendor-suffixed banner', () => {
    assert.deepStrictEqual(parseGitVersion('git version 2.50.1 (Apple Git-155)'), {
      major: 2,
      minor: 50,
      patch: 1,
    });
  });

  it('defaults patch to 0 when absent', () => {
    assert.deepStrictEqual(parseGitVersion('git version 2.26'), { major: 2, minor: 26, patch: 0 });
  });

  it('returns undefined for an unparseable banner', () => {
    assert.strictEqual(parseGitVersion('not a version'), undefined);
  });

  it('returns undefined for non-string input', () => {
    assert.strictEqual(parseGitVersion(undefined as unknown as string), undefined);
  });
});

describe('gitVersionAtLeast', () => {
  it('true when major is greater', () => {
    assert.strictEqual(gitVersionAtLeast({ major: 3, minor: 0, patch: 0 }, 2, 38), true);
  });

  it('true when same major and minor >= target', () => {
    assert.strictEqual(gitVersionAtLeast({ major: 2, minor: 38, patch: 0 }, 2, 38), true);
    assert.strictEqual(gitVersionAtLeast({ major: 2, minor: 50, patch: 1 }, 2, 38), true);
  });

  it('false when same major but minor below target', () => {
    assert.strictEqual(gitVersionAtLeast({ major: 2, minor: 37, patch: 9 }, 2, 38), false);
  });

  it('false when major below target', () => {
    assert.strictEqual(gitVersionAtLeast({ major: 1, minor: 99, patch: 0 }, 2, 38), false);
  });

  it('fails open (true) when version is undefined', () => {
    assert.strictEqual(gitVersionAtLeast(undefined, 2, 38), true);
  });
});

describe('supportsUpdateRefs', () => {
  it('true for git 2.38+', () => {
    assert.strictEqual(supportsUpdateRefs({ major: 2, minor: 38, patch: 0 }), true);
    assert.strictEqual(supportsUpdateRefs({ major: 2, minor: 50, patch: 1 }), true);
  });

  it('false for git < 2.38', () => {
    assert.strictEqual(supportsUpdateRefs({ major: 2, minor: 37, patch: 0 }), false);
    assert.strictEqual(supportsUpdateRefs({ major: 2, minor: 25, patch: 0 }), false);
  });
});

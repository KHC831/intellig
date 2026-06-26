/**
 * `validateBranchName` (extension.ts) must enforce git `check-ref-format`, not
 * just a leading-`-`/`.` guard — it previously accepted `..`, a trailing `/`,
 * a `.lock` suffix, and empty path segments. It now delegates to the shared
 * `isValidRefNameFormat` validator (single source of truth).
 */

import '../../setup';
import * as assert from 'assert';
import { validateBranchName } from '../../../src/extension';

describe('validateBranchName — git check-ref-format', () => {
  it('accepts ordinary valid names', () => {
    for (const name of ['feature/x', 'release-1.2', 'main', 'a/b/c']) {
      assert.strictEqual(validateBranchName(name), undefined, `${name} should be valid`);
    }
  });

  it('rejects empty / whitespace', () => {
    assert.ok(validateBranchName(''));
    assert.ok(validateBranchName('   '));
  });

  it('rejects the check-ref-format violations the old regex let through', () => {
    for (const bad of ['foo..bar', 'foo/', 'foo//bar', 'foo.lock', '/foo', 'foo/.bar', 'foo.']) {
      assert.ok(validateBranchName(bad), `${bad} must be rejected`);
    }
  });

  it('still rejects a leading dash / dot (flag injection / invalid)', () => {
    assert.ok(validateBranchName('-foo'));
    assert.ok(validateBranchName('.foo'));
  });
});

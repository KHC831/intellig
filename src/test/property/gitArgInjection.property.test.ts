/**
 * Property: any string passed as a ref MUST land in argv
 * positionally, never as a flag, regardless of leading characters.
 *
 * Bug class: a malicious branch name like `--upload-pack=evil` would
 * inject as a git flag without `--end-of-options`. Hardened
 * `getMergeBase` ad-hoc; generalizes via `buildGitArgs`.
 */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';
import { buildGitArgs } from '../../git-core/gitCli';

describe('Wave I — argv injection property', () => {
  it('any ref containing --flag-shape lands AFTER --end-of-options', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
        (ref, flags) => {
          const argv = buildGitArgs('checkout', flags, [ref]);
          const eooIdx = argv.indexOf('--end-of-options');
          // separator present whenever refs.length > 0
          assert.ok(
            eooIdx > 0,
            `expected --end-of-options at index > 0, got ${eooIdx} in ${JSON.stringify(argv)}`
          );
          // every flag lands BEFORE the separator
          for (let i = 1; i < eooIdx; i++) {
            assert.strictEqual(argv[i], flags[i - 1]);
          }
          // ref lands AFTER the separator. `indexOf` from `eooIdx` skips
          // any earlier accidental match against a flag string.
          const refIdx = argv.indexOf(ref, eooIdx);
          assert.ok(
            refIdx > eooIdx,
            `expected ref ${JSON.stringify(ref)} after --end-of-options at ${eooIdx}, got idx ${refIdx} in ${JSON.stringify(argv)}`
          );
        }
      ),
      { numRuns: 200 }
    );
  });

  it('empty refs array → no --end-of-options inserted', () => {
    const argv = buildGitArgs('status', ['--porcelain'], []);
    assert.deepStrictEqual(argv, ['status', '--porcelain']);
  });

  it('paths after refs separated by `--`', () => {
    const argv = buildGitArgs('checkout', [], ['main'], ['src/file.ts']);
    assert.deepStrictEqual(argv, ['checkout', '--end-of-options', 'main', '--', 'src/file.ts']);
  });

  it('empty refs but with paths still inserts `--`', () => {
    const argv = buildGitArgs('rm', ['-r'], [], ['some/path']);
    assert.deepStrictEqual(argv, ['rm', '-r', '--', 'some/path']);
  });

  it('no flags + refs only emits subcommand + --end-of-options + refs', () => {
    const argv = buildGitArgs('checkout', [], ['main']);
    assert.deepStrictEqual(argv, ['checkout', '--end-of-options', 'main']);
  });

  it('multiple refs all land after --end-of-options', () => {
    const argv = buildGitArgs('cherry-pick', [], ['abc123', 'def456', 'ghi789']);
    assert.deepStrictEqual(argv, ['cherry-pick', '--end-of-options', 'abc123', 'def456', 'ghi789']);
  });
});

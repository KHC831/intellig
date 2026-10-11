/**
 * unquoteCStylePath decodes the C-style quoting git applies to a path (and to
 * a worktree lock reason) that holds a quote, a backslash or a control
 * character. What happens to non-ASCII depends on `core.quotePath`: by default
 * git writes each such byte as an octal escape, and with `core.quotePath=false`
 * — common for CJK users — it leaves the UTF-8 literal inside the quotes.
 */
import * as assert from 'assert';
import { unquoteCStylePath } from '../../../src/git-core/cQuote';

describe('unquoteCStylePath', () => {
  it('returns an unquoted token unchanged', () => {
    assert.strictEqual(unquoteCStylePath('plain/path.txt'), 'plain/path.txt');
  });

  it('decodes octal-escaped UTF-8 (core.quotePath on)', () => {
    assert.strictEqual(unquoteCStylePath('"caf\\303\\251"'), 'café');
  });

  it('keeps literal UTF-8 inside the quotes (core.quotePath=false)', () => {
    assert.strictEqual(unquoteCStylePath('"say \\"café\\""'), 'say "café"');
    assert.strictEqual(unquoteCStylePath('"日本語 \\"x\\""'), '日本語 "x"');
  });

  it('keeps a literal character outside the Basic Multilingual Plane', () => {
    assert.strictEqual(unquoteCStylePath('"tag \\"🙂\\""'), 'tag "🙂"');
  });

  it('decodes the named escapes', () => {
    assert.strictEqual(unquoteCStylePath('"a\\tb\\nc\\\\d"'), 'a\tb\nc\\d');
  });
});

/**
 * Word-breaking guard for the Details Panel's metadata values.
 *
 * `word-break: break-all` splits a run at ANY character, which is right for an
 * opaque 40-char hash but shatters human text: an author name or branch name
 * wraps mid-word ("John Do|e", "fea|ture/login"). These specs pin break-all to
 * the hash rows, leaving other values to break at sensible boundaries.
 */

import '../../setup';
import * as assert from 'assert';
import { buildInlineStyles } from '../../../src/git-core/gitToolWindow/provider/stylesBuilder';

/** Body of the first `<selector> { ... }` block, or undefined when absent. */
function ruleBody(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(css)?.[1];
}

describe('Details Panel value word-breaking', () => {
  it('does not break generic metadata values mid-word', () => {
    const body = ruleBody(buildInlineStyles(), '.detail-value');

    assert.ok(body, '.detail-value rule must exist');
    assert.ok(
      !/word-break:\s*break-all/.test(body),
      'break-all here shatters author and branch names mid-word'
    );
  });

  it('breaks the full commit hash anywhere so it never overflows the panel', () => {
    const body = ruleBody(buildInlineStyles(), '.hash-value');

    assert.ok(body, '.hash-value rule must exist');
    assert.ok(/word-break:\s*break-all/.test(body), 'an opaque hash may break at any character');
  });
});

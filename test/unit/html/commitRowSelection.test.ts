/**
 * Log rows are list rows, not selectable text: shift-click range selection
 * must not drag-highlight commit message/author/date across rows (IntelliJ's
 * log table has no text selection; hash copying goes through the Ctrl+C
 * multi-hash copy command). The details panel stays selectable.
 */

import '../../setup';
import * as assert from 'assert';
import { buildInlineStyles } from '../../../src/git-core/gitToolWindow/provider/stylesBuilder';

describe('log commit-row text selection', () => {
  it('.commit-row suppresses native text selection (user-select: none)', () => {
    const css = buildInlineStyles();
    const rule = css.match(/\.commit-row\s*\{[^}]*\}/)?.[0] ?? '';
    assert.ok(rule.length > 0, 'a .commit-row rule exists');
    assert.match(rule, /user-select:\s*none/);
  });

  it('the details panel does not inherit the suppression', () => {
    const css = buildInlineStyles();
    const detailRules = css.match(/\.details-panel[^{]*\{[^}]*\}/g) ?? [];
    for (const rule of detailRules) {
      assert.ok(!/user-select:\s*none/.test(rule), `details panel stays selectable: ${rule}`);
    }
  });
});

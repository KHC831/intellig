/**
 * Ownership guard for the Console tab's CSS.
 *
 * The Console tab body (consoleHtml.renderConsoleTabBody) is styled solely by
 * consoleHtml.consoleTabStyles(), which the tool window folds into `extraStyles`
 * only when the tabbed layout (and thus the Console tab) is shown. The always-on
 * inline stylesheet (buildInlineStyles, reused by buildThreePanelStyles and the
 * loading / no-repo states) must NOT also define `.console-*` rules: a stale
 * console block there (a) is dead — no renderer emits `.console-content`,
 * `.console-exit-code`, `.console-toolbar`, or `.clear-console-button` — and
 * (b) collides with the live `.console-entry`, layering an 8px all-around
 * padding + border-bottom onto every console row and bloating it (the reported
 * "console rows are way too big"). These specs pin that console styling lives
 * only in consoleTabStyles.
 */

import '../../setup';
import * as assert from 'assert';
import {
  buildInlineStyles,
  buildThreePanelStyles,
} from '../../../src/git-core/gitToolWindow/provider/stylesBuilder';
import { consoleTabStyles } from '../../../src/git-core/gitToolWindow/html/consoleHtml';

describe('Console tab CSS ownership', () => {
  it('the always-on inline stylesheet defines no .console-* rules', () => {
    const css = buildInlineStyles();
    assert.ok(
      !/\.console-[a-z-]+\s*\{/.test(css),
      'buildInlineStyles must not define console rules; they belong to consoleTabStyles'
    );
  });

  it('the three-panel stylesheet (which reuses the inline styles) defines no .console-* rules', () => {
    const css = buildThreePanelStyles();
    assert.ok(
      !/\.console-[a-z-]+\s*\{/.test(css),
      'buildThreePanelStyles must not define console rules'
    );
  });

  it('drops the dead console classes that no renderer emits', () => {
    const css = buildThreePanelStyles();
    for (const dead of [
      'console-content',
      'console-exit-code',
      'console-toolbar',
      'clear-console-button',
    ]) {
      assert.ok(!css.includes(dead), `dead console class ".${dead}" must be removed`);
    }
  });

  it('console rows are not bloated: no 8px padding / border-bottom on .console-entry anywhere on the always-on sheet', () => {
    const css = buildThreePanelStyles();
    // The live .console-entry is compact (margin only) via consoleTabStyles;
    // the bloating block set padding: 8px + a border-bottom on every row.
    assert.ok(!/\.console-entry\s*\{[^}]*padding/.test(css), 'no padding on .console-entry');
    assert.ok(
      !/\.console-entry\s*\{[^}]*border-bottom/.test(css),
      'no per-row border-bottom on .console-entry'
    );
  });

  it('consoleTabStyles still owns the compact console-entry styling', () => {
    const css = consoleTabStyles();
    assert.ok(/\.console-entry\s*\{/.test(css), 'consoleTabStyles must style .console-entry');
    assert.ok(
      !/\.console-entry\s*\{[^}]*padding:\s*8px/.test(css),
      'and it stays compact (no 8px pad)'
    );
  });
});

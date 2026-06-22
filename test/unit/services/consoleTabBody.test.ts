/**
 * Unit tests for the Console tab body renderer.
 *
 * The Console tab in the tabbed Git tool window mirrors IntelliJ's Version
 * Control Console: each executed git command is shown with its timestamp,
 * command line, and captured output. The renderer must escape all
 * git-derived text (commands and output are attacker-influenceable) and
 * fall back to a useful empty state when no command has run yet.
 */

import '../../setup';
import * as assert from 'assert';
import {
  renderConsoleTabBody,
  consoleTabStyles,
} from '../../../src/git-core/gitToolWindow/html/consoleHtml';
import { IConsoleEntry } from '../../../src/services/interfaces';

function entry(partial: Partial<IConsoleEntry>): IConsoleEntry {
  return {
    timestamp: new Date('2026-06-19T13:05:09.123Z'),
    command: 'git status',
    output: 'On branch main',
    isError: false,
    ...partial,
  };
}

describe('renderConsoleTabBody', () => {
  it('renders an empty state (no "coming soon" stub) when there are no entries', () => {
    const html = renderConsoleTabBody([]);
    assert.ok(
      !/coming soon/i.test(html),
      'empty Console tab must not advertise the feature as unbuilt'
    );
    // Still keeps the pointer to the raw Output-panel channel.
    assert.ok(/Output/.test(html), 'empty state should still mention the Output panel');
  });

  it('renders each captured command line and its output', () => {
    const html = renderConsoleTabBody([
      entry({ command: 'git fetch origin', output: 'Fetching origin', isError: false }),
    ]);
    assert.ok(html.includes('git fetch origin'), 'command line must be shown');
    assert.ok(html.includes('Fetching origin'), 'command output must be shown');
    assert.ok(!/coming soon/i.test(html), 'populated tab must not show the stub copy');
  });

  it('marks failed commands with an error class', () => {
    const ok = renderConsoleTabBody([entry({ isError: false, exitCode: 0 })]);
    const failed = renderConsoleTabBody([
      entry({ command: 'git push', output: 'rejected', isError: true, exitCode: 1 }),
    ]);
    assert.ok(/console-entry-error/.test(failed), 'failed command should carry the error class');
    assert.ok(!/console-entry-error/.test(ok), 'a clean command must not carry the error class');
  });

  it('escapes HTML metacharacters in commands and output', () => {
    const html = renderConsoleTabBody([
      entry({
        command: 'git log --format=<script>',
        output: '<img src=x onerror=alert(1)>',
      }),
    ]);
    assert.ok(!html.includes('<script>'), 'command must be HTML-escaped');
    assert.ok(!html.includes('<img src=x'), 'output must be HTML-escaped');
    assert.ok(html.includes('&lt;script&gt;'), 'escaped command should appear');
  });

  it('renders entries newest-friendly: all entries are present in order', () => {
    const html = renderConsoleTabBody([
      entry({ command: 'git one' }),
      entry({ command: 'git two' }),
    ]);
    assert.ok(html.indexOf('git one') < html.indexOf('git two'), 'entries render in array order');
  });
});

// ─── consoleTabStyles whitespace ownership ──────────────────────────────────
// Regression: `.console-entry { white-space: pre-wrap }` made the renderer's
// pretty-print indentation render literally — timestamp/command split onto
// separate indented lines with blank-line gaps (reported "console rows way too
// big"). Only the <pre class="console-output"> may preserve whitespace.
describe('consoleTabStyles whitespace', () => {
  const entryBlock = (css: string): string => {
    const m = css.match(/\.console-entry\s*\{([^}]*)\}/);
    return m ? m[1] : '';
  };
  const outputBlock = (css: string): string => {
    const m = css.match(/\.console-output\s*\{([^}]*)\}/);
    return m ? m[1] : '';
  };

  it('.console-entry does NOT preserve whitespace (no white-space: pre*)', () => {
    const css = consoleTabStyles();
    assert.ok(
      !/white-space\s*:\s*pre/.test(entryBlock(css)),
      'the entry wrapper must not preserve whitespace; that renders the template indentation'
    );
  });

  it('.console-output (the <pre>) DOES preserve whitespace for git output', () => {
    const css = consoleTabStyles();
    assert.ok(
      /white-space\s*:\s*pre-wrap/.test(outputBlock(css)),
      'git output must keep pre-wrap so its own line breaks survive'
    );
  });
});

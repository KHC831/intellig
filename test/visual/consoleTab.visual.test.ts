/**
 * Computed-style specs for the Console tab (consoleTabStyles).
 *
 * This stylesheet's shipped defect is the oversized-row one: `white-space:
 * pre-wrap` on `.console-entry` (the row WRAPPER) rendered the renderer's
 * pretty-printed template whitespace literally — timestamp and command split
 * onto separate indented lines with blank-line gaps — and the first fix
 * removed dead CSS that was already losing the cascade, exactly the
 * present-but-not-applied class this lane exists for. The unit lane pins the
 * emitted text (consoleStylesOwnership); the two row-geometry specs here pin
 * what that text does in a real layout engine, which is what the wrong fix
 * could not see.
 */

import '../setup';
import * as assert from 'assert';
import { withRenderedPage } from './support/browser';
import {
  assertNoHorizontalOverflow,
  assertReadable,
  assertResolvesToToken,
} from './support/assert';
import { consoleEntry, gitToolWindowCss, tabbedBody } from './support/gitToolWindowFixture';
import type { ThemeName } from './support/theme';

const THEMES: readonly ThemeName[] = ['dark', 'light'];

/** One plain no-output entry, one entry with output, one failed entry. */
const consoleBody = (): string =>
  tabbedBody({
    activeTab: 'console',
    console: [
      consoleEntry({ command: 'git status --porcelain=v1' }),
      consoleEntry({
        command: 'git fetch origin --prune',
        output: 'From github.com:acme/app\n   1111111..2222222  main -> origin/main',
      }),
      consoleEntry({
        command: 'git push origin main',
        output: 'error: failed to push some refs',
        isError: true,
      }),
    ],
  });

describe('console tab (computed style)', () => {
  for (const theme of THEMES) {
    describe(`${theme} theme`, () => {
      it('lays the timestamp and command on one line, not on the template’s literal line breaks', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: consoleBody(), theme },
          async (page) => {
            const boxes = await page.evaluate(() => {
              const line = document.querySelector('.console-entry .console-command-line');
              const ts = line?.querySelector('.console-timestamp');
              const cmd = line?.querySelector('.console-command');
              if (!ts || !cmd) {
                return null;
              }
              const a = ts.getBoundingClientRect();
              const b = cmd.getBoundingClientRect();
              return { tsTop: a.top, tsRight: a.right, cmdTop: b.top, cmdLeft: b.left };
            });
            assert.ok(boxes, 'expected a timestamp and a command in the first console entry');
            assert.ok(
              Math.abs(boxes.tsTop - boxes.cmdTop) < 1,
              `the command sits ${Math.round(boxes.cmdTop - boxes.tsTop)}px below its timestamp: ` +
                `the row wrapper is rendering the template's whitespace as line breaks`
            );
            assert.ok(
              boxes.tsRight <= boxes.cmdLeft,
              'the timestamp must precede the command on the same line'
            );
          }
        );
      });

      it('keeps a row compact: command line plus output, no blank template lines', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: consoleBody(), theme },
          async (page) => {
            const heights = await page.evaluate(() => {
              const entries = Array.from(document.querySelectorAll('.console-entry'));
              const withOutput = entries.find((e) => e.querySelector('.console-output'));
              if (!withOutput) {
                return null;
              }
              const line = withOutput.querySelector('.console-command-line');
              const output = withOutput.querySelector('.console-output');
              if (!line || !output) {
                return null;
              }
              return {
                entry: withOutput.getBoundingClientRect().height,
                line: line.getBoundingClientRect().height,
                output: output.getBoundingClientRect().height,
              };
            });
            assert.ok(heights, 'expected a console entry that carries output');
            // 2px is the output's own margin-top; the slack covers rounding.
            assert.ok(
              heights.entry <= heights.line + heights.output + 4,
              `the entry is ${Math.round(heights.entry)}px tall for ${Math.round(heights.line)}px ` +
                `of command line and ${Math.round(heights.output)}px of output: the difference is ` +
                `template whitespace rendered as blank lines`
            );
          }
        );
      });

      it('colours the command with the link token and the timestamp with the description token', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: consoleBody(), theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '.console-entry:not(.console-entry-error) .console-command',
              'color',
              theme,
              'vscode-textLink-foreground'
            );
            await assertResolvesToToken(
              page,
              '.console-entry:not(.console-entry-error) .console-timestamp',
              'color',
              theme,
              'vscode-descriptionForeground'
            );
          }
        );
      });

      it('flags a failed command and its output in the error token', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: consoleBody(), theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '.console-entry-error .console-command',
              'color',
              theme,
              'vscode-errorForeground'
            );
            await assertResolvesToToken(
              page,
              '.console-entry-error .console-output',
              'color',
              theme,
              'vscode-errorForeground'
            );
          }
        );
      });

      it('themes the Clear button with the secondary-button tokens', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: consoleBody(), theme },
          async (page) => {
            await assertResolvesToToken(
              page,
              '.console-clear-btn',
              'background-color',
              theme,
              'vscode-button-secondaryBackground'
            );
            await assertResolvesToToken(
              page,
              '.console-clear-btn',
              'color',
              theme,
              'vscode-button-secondaryForeground'
            );
          }
        );
      });

      it('renders commands, timestamps, output and the Clear button readably', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: consoleBody(), theme, realistic: true },
          async (page) => {
            await assertReadable(page, '.console-entry:not(.console-entry-error) .console-command');
            await assertReadable(
              page,
              '.console-entry:not(.console-entry-error) .console-timestamp'
            );
            await assertReadable(page, '.console-entry:not(.console-entry-error) .console-output');
            await assertReadable(page, '.console-clear-btn');
          }
        );
      });

      it('keeps a failed command visible in the palette’s own error red', async () => {
        await withRenderedPage(
          { css: gitToolWindowCss(), body: consoleBody(), theme, realistic: true },
          async (page) => {
            // The real palette pairs errorForeground with the panel background
            // at ≈5.3:1 dark but only ≈3.2:1 light, so AA's 4.5 floor would
            // fail VS Code's own theme. The reduced floor still catches the
            // defect classes this lane exists for: an overpaint, a
            // near-transparent foreground, an ancestor opacity fade.
            await assertReadable(page, '.console-entry-error .console-command', 2.5);
          }
        );
      });

      it('fits a 640px panel without forcing a sideways scroll', async () => {
        await withRenderedPage(
          {
            css: gitToolWindowCss(),
            body: consoleBody(),
            theme,
            realistic: true,
            viewport: { width: 640, height: 600 },
          },
          async (page) => {
            await assertNoHorizontalOverflow(page);
          }
        );
      });
    });
  }
});

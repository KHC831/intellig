/**
 * Date presets keep their identity through the filter.
 *
 * "Last 24 Hours" used to be a client-side label over a plain `since`
 * instant: the host re-rendered it as "Since <date>", reopening the popup
 * showed a CHECKED custom After bound holding that instant rounded down to a
 * calendar day, and a bare Apply then widened the filter to that day's
 * midnight — silently turning a 24-hour window into up to 48 hours.
 */

import '../../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../../src/git-core/gitToolWindow/GitToolWindowProvider';
import { Uri } from '../../../mocks/vscode';
import type { ILogFilter } from '../../../../src/git-core/interfaces/IGitToolWindowProvider';

/** The filter row + date popup the host renders for `filter`. */
function filterRowHtml(filter: ILogFilter | undefined): string {
  const provider = new GitToolWindowProvider(Uri.file('/ext'));
  provider.setLogFilter(filter);
  return provider._getLogFilterRowHtml();
}

const SINCE = new Date('2026-06-01T09:30:00Z');

describe('log filter date presets', () => {
  it('shows the preset name, not a Since-date', () => {
    const html = filterRowHtml({ since: SINCE, datePreset: '24h' });

    assert.ok(html.includes('Last 24 Hours'), `the button must name the preset:\n${html}`);
    assert.ok(!html.includes('Since 2026-06-01'), 'a preset is not a custom Since bound');
  });

  it('marks the active preset in the popup', () => {
    const html = filterRowHtml({ since: SINCE, datePreset: '7d' });

    assert.match(
      html,
      /data-range="7d"[^>]*>|<button[^>]*aria-checked="true"[^>]*data-range="7d"/,
      'the 7d entry must render'
    );
    const sevenDay = /<button[^>]*data-range="7d"[^>]*>/.exec(html)?.[0] ?? '';
    assert.ok(sevenDay.includes('aria-checked="true"'), `7d must read as selected: ${sevenDay}`);
    const dayOne = /<button[^>]*data-range="24h"[^>]*>/.exec(html)?.[0] ?? '';
    assert.ok(!dayOne.includes('aria-checked="true"'), '24h must not');
  });

  it('leaves the custom bounds unchecked and closed under a preset', () => {
    const html = filterRowHtml({ since: SINCE, datePreset: '24h' });

    const afterBox = /<input[^>]*id="filter-after-enabled"[^>]*>/.exec(html)?.[0] ?? '';
    assert.ok(
      !afterBox.includes('checked'),
      `a preset must not arm the custom After bound: ${afterBox}`
    );
    const afterDate = /<input[^>]*id="filter-after-date"[^>]*>/.exec(html)?.[0] ?? '';
    assert.ok(
      afterDate.includes('value=""'),
      `and must not seed it with the preset instant: ${afterDate}`
    );
    assert.match(html, /id="filter-date-custom"[^>]*hidden/, 'the custom section stays closed');
  });

  it('still renders a genuine custom range as a checked bound', () => {
    const html = filterRowHtml({ since: SINCE });

    const afterBox = /<input[^>]*id="filter-after-enabled"[^>]*>/.exec(html)?.[0] ?? '';
    assert.ok(afterBox.includes('checked'), `a custom range keeps its bound: ${afterBox}`);
    assert.ok(html.includes('Since 2026-06-01'), 'and its Since label');
  });

  it('seeds the filter row so the webview can post the preset back', () => {
    const html = filterRowHtml({ since: SINCE, datePreset: '24h' });

    assert.ok(html.includes('data-f-date-preset="24h"'), `the row must carry it:\n${html}`);
  });
});

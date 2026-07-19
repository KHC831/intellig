/**
 * Tab strip layout + accessibility.
 *
 * The strip and the panels rendered as plain flow siblings, so tall tab content
 * grew the page and the BODY scrolled — carrying the tab buttons off the top and
 * making it impossible to switch tabs without scrolling back up. Only the Log tab
 * looked pinned, and only because its own containers bound their height.
 *
 * Separately the strip implemented `role="tablist"` without the relationships or
 * the keyboard behaviour the WAI-ARIA tabs pattern requires.
 *
 * jsdom does not lay out or paint, so these assert the LAYOUT RULES that pin the
 * strip rather than a pixel position.
 */

import '../../setup';
import * as assert from 'assert';
import {
  renderTabStrip,
  renderTabPanels,
  wrapTabbedBody,
  tabStripStyles,
} from '../../../src/git-core/gitToolWindow/html/commonHtml';
import { TAB_IDS } from '../../../src/git-core/gitToolWindow/tabRouter';

function wrapped(): string {
  return wrapTabbedBody({
    activeTab: 'console',
    logBodyHtml: '<div id="log"></div>',
    consoleBodyHtml: '<div id="console"></div>',
    incomingBodyHtml: '<div id="incoming"></div>',
    updateInfoBodyHtml: '<div id="updateInfo"></div>',
    historyBodyHtml: '<div id="history"></div>',
  });
}

/** Body of the CSS rule for `selector`, or undefined when there is none. */
function ruleFor(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1] : undefined;
}

describe('tabbed layout keeps the strip in view', () => {
  it('wraps the strip and panels in a single bounded container', () => {
    assert.match(wrapped(), /^<div class="intellig-tabbed">/);
  });

  it('bounds that container to the viewport as a flex column', () => {
    const rule = ruleFor(tabStripStyles(), '.intellig-tabbed');

    assert.ok(rule, '.intellig-tabbed must be styled');
    assert.match(rule, /display:\s*flex/);
    assert.match(rule, /flex-direction:\s*column/);
    assert.match(rule, /height:\s*100vh/);
  });

  it('keeps the strip at its natural height so it cannot be pushed away', () => {
    const rule = ruleFor(tabStripStyles(), '.intellig-tab-strip');

    assert.ok(rule, '.intellig-tab-strip must be styled');
    assert.match(rule, /flex:\s*0 0 auto/);
  });

  it('gives the panels the remaining space and their own scrollbar', () => {
    const rule = ruleFor(tabStripStyles(), '.intellig-tab-panel');

    assert.ok(rule, '.intellig-tab-panel must be styled');
    assert.match(rule, /flex:\s*1 1 auto/);
    assert.match(rule, /overflow:\s*auto/);
    // Without min-height:0 a flex child refuses to shrink below its content,
    // which is what let tall content push the page tall in the first place.
    assert.match(rule, /min-height:\s*0/);
  });
});

describe('tab strip ARIA relationships', () => {
  it('points every tab at the panel it controls', () => {
    const strip = renderTabStrip('log');

    for (const tab of TAB_IDS) {
      assert.match(
        strip,
        new RegExp(`data-tab="${tab}"[^>]*aria-controls="intellig-tabpanel-${tab}"`),
        `tab ${tab} must declare aria-controls`
      );
    }
  });

  it('gives every tab the id its panel labels itself by', () => {
    const strip = renderTabStrip('log');

    for (const tab of TAB_IDS) {
      assert.match(strip, new RegExp(`id="intellig-tab-${tab}"`), `tab ${tab} needs an id`);
    }
  });

  it('labels every panel by its tab and gives it the matching id', () => {
    const panels = renderTabPanels({
      activeTab: 'log',
      logBodyHtml: '',
      consoleBodyHtml: '',
      incomingBodyHtml: '',
      updateInfoBodyHtml: '',
      historyBodyHtml: '',
    });

    for (const tab of TAB_IDS) {
      assert.match(panels, new RegExp(`id="intellig-tabpanel-${tab}"`), `panel ${tab} needs an id`);
      assert.match(
        panels,
        new RegExp(`data-tab-panel="${tab}"[^>]*aria-labelledby="intellig-tab-${tab}"`),
        `panel ${tab} must be labelled by its tab`
      );
    }
  });

  it('puts only the active tab in the keyboard tab order (roving tabindex)', () => {
    const strip = renderTabStrip('console');

    assert.match(strip, /data-tab="console"[^>]*tabindex="0"/);
    assert.match(strip, /data-tab="log"[^>]*tabindex="-1"/);
  });
});

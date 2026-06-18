/**
 * Workstream C, Item 3 — Git tool-window header toolbar (`view/title`).
 *
 * The audit flagged `view/title` as an empty `[]` — no
 * Fetch/Pull/Push/Update/Refresh/branch buttons on the tool-window header.
 * This guard pins the populated toolbar against the shipped `package.json`:
 *
 *   - the toolbar is non-empty,
 *   - every toolbar entry targets the Git tool window view id,
 *   - every toolbar command is declared in `contributes.commands` AND carries
 *     an icon (a `view/title` navigation button with no icon renders as an
 *     invisible click target),
 *   - the IntelliJ-parity action set (Fetch / Pull / Push / Update / Refresh /
 *     Branches) is present,
 *   - branch widget (showBranchPopup) is the first navigation entry,
 *   - intellig.fetch uses a distinct icon from intellig.updateProject.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, 'package.json');
const GIT_TOOL_WINDOW_VIEW_ID = 'intellig.toolWindow';

interface PackageJson {
  contributes: {
    commands: Array<{ command: string; icon?: unknown }>;
    menus: { 'view/title'?: Array<{ command: string; when?: string; group?: string }> };
    views: Record<string, Array<{ id: string }>>;
  };
}

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as PackageJson;
}

/** Extract the numeric order suffix from a group string like "navigation@3". */
function navOrder(group: string | undefined): number {
  if (!group) {
    return Infinity;
  }
  const m = /navigation@(\d+)$/.exec(group);
  return m ? parseInt(m[1], 10) : Infinity;
}

describe('Workstream C Item 3 — Git tool-window header toolbar (view/title)', () => {
  it('the view/title toolbar is populated (no longer the empty audit baseline)', () => {
    const toolbar = readPackageJson().contributes.menus['view/title'] ?? [];
    assert.ok(toolbar.length > 0, 'view/title must have header buttons');
  });

  it('every toolbar entry targets the Git tool window view', () => {
    const toolbar = readPackageJson().contributes.menus['view/title'] ?? [];
    for (const entry of toolbar) {
      assert.ok(
        (entry.when ?? '').includes(`view == ${GIT_TOOL_WINDOW_VIEW_ID}`),
        `toolbar entry ${entry.command} must be gated to view == ${GIT_TOOL_WINDOW_VIEW_ID} (when: ${entry.when})`
      );
    }
  });

  it('every toolbar command is declared with an icon', () => {
    const pj = readPackageJson();
    const toolbar = pj.contributes.menus['view/title'] ?? [];
    const byId = new Map(pj.contributes.commands.map((c) => [c.command, c]));
    const problems: string[] = [];
    for (const entry of toolbar) {
      const decl = byId.get(entry.command);
      if (!decl) {
        problems.push(`${entry.command}: not declared in contributes.commands`);
      } else if (!decl.icon) {
        problems.push(`${entry.command}: declared without an icon (invisible header button)`);
      }
    }
    assert.deepStrictEqual(problems, [], problems.join('\n  '));
  });

  it('exposes the IntelliJ-parity action set', () => {
    const toolbar = readPackageJson().contributes.menus['view/title'] ?? [];
    const ids = new Set(toolbar.map((e) => e.command));
    for (const expected of [
      'intellig.fetch',
      'intellig.pull',
      'intellig.push',
      'intellig.updateProject',
      'intellig.refresh',
      'intellig.showBranchPopup',
    ]) {
      assert.ok(ids.has(expected), `expected ${expected} on the tool-window header`);
    }
  });

  it('showBranchPopup is the first navigation entry (branch widget leads the toolbar)', () => {
    const toolbar = readPackageJson().contributes.menus['view/title'] ?? [];
    const navEntries = toolbar
      .filter((e) => (e.group ?? '').startsWith('navigation@'))
      .sort((a, b) => navOrder(a.group) - navOrder(b.group));
    assert.ok(navEntries.length > 0, 'no navigation entries found in view/title');
    assert.strictEqual(
      navEntries[0].command,
      'intellig.showBranchPopup',
      `expected intellig.showBranchPopup to be navigation@1 (first), ` +
        `but first entry is ${navEntries[0].command} in group ${navEntries[0].group ?? '<none>'}`
    );
  });

  it('intellig.fetch uses a distinct icon from intellig.updateProject', () => {
    const pj = readPackageJson();
    const byId = new Map(pj.contributes.commands.map((c) => [c.command, c]));
    const fetchIcon = byId.get('intellig.fetch')?.icon;
    const updateIcon = byId.get('intellig.updateProject')?.icon;
    assert.ok(fetchIcon, 'intellig.fetch must have an icon');
    assert.ok(updateIcon, 'intellig.updateProject must have an icon');
    assert.notStrictEqual(
      fetchIcon,
      updateIcon,
      `intellig.fetch and intellig.updateProject must use distinct icons (both are "${String(fetchIcon)}")`
    );
  });
});

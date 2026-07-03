/**
 * Settings-page organization spec: `contributes.configuration` is an ARRAY of
 * titled sections (VS Code renders each as a navigable group under the
 * extension instead of one long unordered list), and the user-facing setting
 * text describes what the setting controls without upstream-product
 * references or internal task codes.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface IConfigSection {
  title?: string;
  order?: number;
  properties?: Record<string, Record<string, unknown>>;
}

function loadConfiguration(): IConfigSection[] {
  const raw = fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw) as {
    contributes?: { configuration?: IConfigSection | IConfigSection[] };
  };
  const cfg = pkg.contributes?.configuration;
  assert.ok(cfg, 'contributes.configuration present');
  assert.ok(Array.isArray(cfg), 'configuration is an array of titled sections');
  return cfg;
}

function flatten(sections: IConfigSection[]): Record<string, Record<string, unknown>> {
  return Object.assign({}, ...sections.map((s) => s.properties ?? {})) as Record<
    string,
    Record<string, unknown>
  >;
}

describe('package.json — settings-page sections', () => {
  it('every section has a unique title and a unique order', () => {
    const sections = loadConfiguration();
    assert.ok(sections.length >= 5, 'settings are actually grouped, not one bucket');
    const titles = sections.map((s) => s.title);
    assert.ok(
      titles.every((t) => typeof t === 'string' && t.length > 0),
      'every section is titled'
    );
    assert.strictEqual(new Set(titles).size, titles.length, 'titles are unique');
    const orders = sections.map((s) => s.order);
    assert.ok(
      orders.every((o) => typeof o === 'number'),
      'every section has an explicit order'
    );
    assert.strictEqual(new Set(orders).size, orders.length, 'orders are unique');
  });

  it('no setting key is lost or duplicated across sections', () => {
    const sections = loadConfiguration();
    const perSection = sections.flatMap((s) => Object.keys(s.properties ?? {}));
    const flat = flatten(sections);
    assert.strictEqual(
      perSection.length,
      Object.keys(flat).length,
      'no key appears in two sections'
    );
    // Representative members from each former region of the flat list — a
    // dropped group fails loudly here.
    for (const key of [
      'intellig.keymapPreset',
      'intellig.useCommitToolWindow',
      'intellig.log.showAllRoots',
      'intellig.log.showRootNames',
      'intellig.autoFetchInterval',
      'intellig.branches.showTags',
      'intellig.blame.colorMode',
      'intellig.diff.ignorePolicy',
      'intellig.mergeWindow.enabled',
      'intellig.shelve.removeAppliedFiles',
      'intellig.modifiedFileColor',
      'intellig.repositoryScanMaxDepth',
      'intellig.log.level',
      'intellig.protectedBranches',
    ]) {
      assert.ok(flat[key], `${key} survives the regrouping`);
    }
  });

  it('setting text has no upstream-product references (keymapPreset excepted)', () => {
    const flat = flatten(loadConfiguration());
    for (const [key, schema] of Object.entries(flat)) {
      if (key === 'intellig.keymapPreset') {
        // The preset's enum value IS 'intellij'; naming what it emulates here
        // is the information, not a stray reference.
        continue;
      }
      const blob = JSON.stringify(schema);
      assert.ok(!/intellij/i.test(blob), `${key} must not reference IntelliJ: ${blob}`);
    }
  });

  it('setting text has no internal task codes', () => {
    const flat = flatten(loadConfiguration());
    for (const [key, schema] of Object.entries(flat)) {
      const blob = JSON.stringify(schema);
      assert.ok(
        !/\((?:G\d+|T\d+-\d+|TL-\d+)\)/.test(blob),
        `${key} must not carry an internal task code: ${blob}`
      );
    }
  });

  it('keymapPreset documents the destructive chord collision (moved from README)', () => {
    const flat = flatten(loadConfiguration());
    const preset = flat['intellig.keymapPreset'] as { markdownDescription?: string };
    assert.ok(
      preset.markdownDescription && /Revert File/.test(preset.markdownDescription),
      'the Ctrl/Cmd+Alt+Z revert-vs-unstage warning lives on the setting'
    );
  });
});

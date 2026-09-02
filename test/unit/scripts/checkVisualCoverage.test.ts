/**
 * Companion spec for scripts/check-visual-coverage.mjs.
 *
 * The guard's whole value is its INVENTORY: it decides what counts as a
 * stylesheet before it decides whether one is covered. Its first version keyed
 * on exported `*Styles()` builders only and saw 9 of 26 producers, because
 * every dialog in the repo declares its stylesheet as a private `_getStyles()`
 * method — so a new dialog written the ordinary way was not "unclassified", it
 * was invisible. These cases pin the detector's reach as much as its verdicts.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-visual-coverage.mjs');
const TMP_ROOT = SCRATCH_ROOT;

interface IManifest {
  statuses: string[];
  files: Record<string, { status: string; note?: string }>;
}

function runGuard(args: string[] = []): { status: number | null; out: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Runs the guard over a synthetic src tree + manifest + visual spec dir. */
function checkTree(
  sources: Record<string, string>,
  manifest: IManifest,
  specs: Record<string, string> = {}
): { status: number | null; out: string } {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'visual-coverage-'));
  try {
    for (const [name, text] of Object.entries(sources)) {
      const file = path.join(dir, 'src', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, 'utf8');
    }
    const specDir = path.join(dir, 'visual');
    fs.mkdirSync(specDir, { recursive: true });
    for (const [name, text] of Object.entries(specs)) {
      fs.writeFileSync(path.join(specDir, name), text, 'utf8');
    }
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    return runGuard([path.join(dir, 'src'), manifestPath, specDir]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const EXPORTED = 'export function widgetStyles(): string {\n  return `.a { color: red; }`;\n}\n';
const DIALOG =
  'class Dialog {\n  protected override _getStyles(): string {\n    return `.b { color: blue; }`;\n  }\n}\n';
const manifest = (files: IManifest['files']): IManifest => ({
  statuses: ['tested', 'backlog'],
  files,
});

describe('check-visual-coverage guard', () => {
  it('passes against the real tree', () => {
    const { status, out } = runGuard();
    assert.strictEqual(status, 0, `guard should pass on a clean tree; output:\n${out}`);
  });

  it('reports every producer, not just the exported builders', () => {
    // Non-vacuity with teeth: the real tree has far more private producers than
    // exported ones, so a detector that silently narrowed back to exports would
    // fail this rather than keep reporting a comfortable number.
    const { out } = runGuard();
    const total = /OK \((\d+) stylesheet producers/.exec(out);
    assert.ok(total, `expected a producer count in: ${out}`);
    assert.ok(
      Number(total[1]) >= 25,
      `expected the detector to see every producer, it reported ${total[1]}`
    );
  });

  it('fails on an unclassified exported builder', () => {
    const { status } = checkTree({ 'widget.ts': EXPORTED }, manifest({}));
    assert.strictEqual(status, 1, 'an unclassified builder must fail');
  });

  it('fails on an unclassified private dialog stylesheet', () => {
    // The case the original detector could not see at all. The exported builder
    // is present and classified so the failure can only be about the dialog.
    const { status, out } = checkTree(
      { 'widget.ts': EXPORTED, 'Dialog.ts': DIALOG },
      manifest({ 'src/widget.ts::widgetStyles': { status: 'backlog' } })
    );
    assert.strictEqual(status, 1, 'a private _getStyles must require classification');
    assert.match(out, /Dialog\.ts::_getStyles/);
  });

  it("fails a 'tested' claim no spec backs", () => {
    const { status, out } = checkTree(
      { 'widget.ts': EXPORTED },
      manifest({ 'src/widget.ts::widgetStyles': { status: 'tested' } })
    );
    assert.strictEqual(status, 1, "an unbacked 'tested' must fail");
    assert.match(out, /marked 'tested' but no spec/);
  });

  it("accepts 'tested' when a spec renders the builder", () => {
    const { status, out } = checkTree(
      { 'widget.ts': EXPORTED },
      manifest({ 'src/widget.ts::widgetStyles': { status: 'tested' } }),
      { 'widget.visual.test.ts': 'withRenderedPage({ css: widgetStyles() })' }
    );
    assert.strictEqual(status, 0, `a rendered builder must pass; output:\n${out}`);
  });

  it('does not credit a builder a spec only mentions in prose', () => {
    // Specs name the builders they render AND the ones they deliberately do
    // not, so crediting a bare mention would let a comment vouch for coverage.
    const { status, out } = checkTree(
      { 'widget.ts': EXPORTED },
      manifest({ 'src/widget.ts::widgetStyles': { status: 'tested' } }),
      { 'widget.visual.test.ts': '// unlike widgetStyles(), this renders nothing\nconst x = 1;' }
    );
    assert.strictEqual(status, 1, 'a commented mention must not back a tested claim');
    assert.match(out, /marked 'tested' but no spec/);
  });

  it('does not credit a builder a spec only imports', () => {
    const { status } = checkTree(
      { 'widget.ts': EXPORTED },
      manifest({ 'src/widget.ts::widgetStyles': { status: 'tested' } }),
      { 'widget.visual.test.ts': "import { widgetStyles } from '../src/widget';\n" }
    );
    assert.strictEqual(status, 1, 'an import without a call must not back a tested claim');
  });

  it('credits a builder interpolated by a rendered one', () => {
    const parent = 'export function parentStyles(): string {\n  return `${widgetStyles()}`;\n}\n';
    const { status, out } = checkTree(
      { 'widget.ts': EXPORTED, 'parent.ts': parent },
      manifest({
        'src/widget.ts::widgetStyles': { status: 'tested' },
        'src/parent.ts::parentStyles': { status: 'tested' },
      }),
      { 'parent.visual.test.ts': 'withRenderedPage({ css: parentStyles() })' }
    );
    assert.strictEqual(status, 0, `an interpolated builder must count as covered; output:\n${out}`);
  });

  it("does not let one file's coverage vouch for another file's _getStyles", () => {
    // Both dialogs declare a method of the same name. Only the first forwards
    // to the rendered builder; a global name match would pass both.
    const covered =
      'class A {\n  protected override _getStyles(): string {\n    return widgetStyles();\n  }\n}\n';
    const { status, out } = checkTree(
      { 'widget.ts': EXPORTED, 'A.ts': covered, 'B.ts': DIALOG },
      manifest({
        'src/widget.ts::widgetStyles': { status: 'tested' },
        'src/A.ts::_getStyles': { status: 'tested' },
        'src/B.ts::_getStyles': { status: 'tested' },
      }),
      { 'a.visual.test.ts': 'withRenderedPage({ css: widgetStyles() })' }
    );
    assert.strictEqual(status, 1, "B's identically-named method must not inherit A's coverage");
    assert.match(out, /B\.ts::_getStyles/);
    assert.doesNotMatch(out, /A\.ts::_getStyles/);
  });

  it('fails on a stale manifest entry', () => {
    const { status, out } = checkTree(
      { 'widget.ts': EXPORTED },
      manifest({
        'src/widget.ts::widgetStyles': { status: 'backlog' },
        'src/gone.ts::goneStyles': { status: 'backlog' },
      })
    );
    assert.strictEqual(status, 1, 'a stale entry must fail');
    assert.match(out, /stale/);
  });

  // The detector's reach is pinned by discrimination, not by a producer count.
  // A count changes whenever a legitimate stylesheet is added, so editing it
  // becomes routine and a routinely-edited pin is decorative. These fail when
  // someone loosens or tightens the pattern and need no edit when src changes.
  // The count pin exists for free: a non-CSS helper the pattern starts catching
  // lands unclassified and fails the manifest check.

  it('sees a producer whose name only CONTAINS Styles', () => {
    const continued =
      'class View {\n  private _getStylesContinued(): string {\n    return `.c { color: red; }`;\n  }\n}\n';
    const { status, out } = checkTree(
      { 'widget.ts': EXPORTED, 'View.ts': continued },
      manifest({ 'src/widget.ts::widgetStyles': { status: 'backlog' } })
    );
    assert.strictEqual(status, 1, 'a contains-Styles producer must require classification');
    assert.match(out, /View\.ts::_getStylesContinued/);
  });

  it('sees an async producer returning Promise<string>', () => {
    // Not pinned as an exclusion: the pattern tolerated `async` while gating on
    // a literal `: string`, so this shape emitted CSS no fence could see.
    const asyncMethod =
      'class View {\n  async panelStyles(): Promise<string> {\n    return `.d { color: red; }`;\n  }\n}\n';
    const { status, out } = checkTree(
      { 'widget.ts': EXPORTED, 'View.ts': asyncMethod },
      manifest({ 'src/widget.ts::widgetStyles': { status: 'backlog' } })
    );
    assert.strictEqual(status, 1, 'an async producer must require classification');
    assert.match(out, /View\.ts::panelStyles/);
  });

  it('does not mistake a singular-Style helper for a stylesheet', () => {
    // `unquoteCStylePath` is a path parser; singular `Style` would claim it.
    const parser =
      'export function unquoteCStylePath(token: string): string {\n  return token;\n}\n';
    const { status, out } = checkTree(
      { 'widget.ts': EXPORTED, 'parse.ts': parser },
      manifest({ 'src/widget.ts::widgetStyles': { status: 'backlog' } })
    );
    assert.strictEqual(status, 0, `a singular-Style helper must be ignored; output:\n${out}`);
  });

  it('sees an arrow-const producer', () => {
    // Not pinned as an exclusion: an arrow-const emits CSS exactly as a
    // function declaration does, so leaving it out of the pattern was a blind
    // spot, not a design decision — the same reasoning as the async case.
    const arrow = 'export const fooStyles = (): string => `.e { color: red; }`;\n';
    const { status, out } = checkTree(
      { 'widget.ts': EXPORTED, 'arrow.ts': arrow },
      manifest({ 'src/widget.ts::widgetStyles': { status: 'backlog' } })
    );
    assert.strictEqual(status, 1, 'an arrow-const producer must require classification');
    assert.match(out, /arrow\.ts::fooStyles/);
  });

  it('sees an async arrow-const producer', () => {
    const arrow = 'export const barStyles = async (): Promise<string> => `.f { color: red; }`;\n';
    const { status, out } = checkTree(
      { 'widget.ts': EXPORTED, 'arrow.ts': arrow },
      manifest({ 'src/widget.ts::widgetStyles': { status: 'backlog' } })
    );
    assert.strictEqual(status, 1, 'an async arrow-const producer must require classification');
    assert.match(out, /arrow\.ts::barStyles/);
  });

  it('does not mistake a non-string arrow-const for a producer', () => {
    // The return gate applies to the arrow form too: a Styles-named handler
    // that returns nothing emits no CSS.
    const arrow = 'export const fooStylesHandler = (): void => {};\n';
    const { status, out } = checkTree(
      { 'widget.ts': EXPORTED, 'arrow.ts': arrow },
      manifest({ 'src/widget.ts::widgetStyles': { status: 'backlog' } })
    );
    assert.strictEqual(status, 0, `a void arrow-const emits no CSS; output:\n${out}`);
  });

  it('rejects an unknown status', () => {
    const { status } = checkTree(
      { 'widget.ts': EXPORTED },
      manifest({ 'src/widget.ts::widgetStyles': { status: 'someday' } })
    );
    assert.strictEqual(status, 1, 'an unknown status must fail');
  });

  it('honours the visual-coverage-exempt marker', () => {
    const exempt =
      'class Base {\n  // visual-coverage-exempt: the empty default\n  protected _getStyles(): string {\n    return "";\n  }\n}\n';
    const { status, out } = checkTree(
      { 'widget.ts': EXPORTED, 'Base.ts': exempt },
      manifest({ 'src/widget.ts::widgetStyles': { status: 'backlog' } })
    );
    assert.strictEqual(status, 0, `an exempt producer must be skipped; output:\n${out}`);
  });

  it('does not count an interface declaration as a producer', () => {
    const iface = 'export interface IStyled {\n  getStyles(): string;\n}\n';
    const { status, out } = checkTree(
      { 'widget.ts': EXPORTED, 'IStyled.ts': iface },
      manifest({ 'src/widget.ts::widgetStyles': { status: 'backlog' } })
    );
    assert.strictEqual(status, 0, `a declaration emits no CSS; output:\n${out}`);
  });

  it('fails when the detector matches nothing at all', () => {
    const { status, out } = checkTree({ 'plain.ts': 'export const x = 1;\n' }, manifest({}));
    assert.strictEqual(status, 1, 'a guard aimed at nothing must fail loudly');
    assert.match(out, /found no stylesheet producers/);
  });
});

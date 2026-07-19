/**
 * Companion spec for scripts/check-tab-styles-wired.mjs.
 *
 * A guard that cannot fail is worse than no guard — it reads as coverage. These
 * drive the script over fixture trees and pin BOTH failure arms (no styles
 * export at all; a styles export the provider never wires) plus the passing
 * shape, so a future edit that neuters the heuristic breaks here.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-tab-styles-wired.mjs');

/** Build a fixture html dir + provider file; returns their paths. */
function makeFixture(files: Record<string, string>, providerSource: string): [string, string] {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'tab-styles-'));
  const htmlDir = path.join(root, 'html');
  fs.mkdirSync(htmlDir);
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(htmlDir, name), source);
  }
  const providerFile = path.join(root, 'Provider.ts');
  fs.writeFileSync(providerFile, providerSource);
  return [htmlDir, providerFile];
}

/** Run the guard; returns exit code + combined output. */
function runGuard(htmlDir: string, providerFile: string): { code: number; output: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT, htmlDir, providerFile], { encoding: 'utf8' });
    return { code: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const WIRED_TAB = `
export function renderFooTabBody(): string {
  return \`<div class="foo-body"><span class="foo-row">x</span></div>\`;
}
export function fooTabStyles(): string {
  return \`.foo-body { display: flex; } .foo-row { padding: 2px; }\`;
}
`;

describe('check-tab-styles-wired guard', () => {
  it('passes a renderer that exports styles the provider wires', () => {
    const [htmlDir, provider] = makeFixture(
      { 'fooHtml.ts': WIRED_TAB },
      `const styles = fooTabStyles();`
    );

    assert.strictEqual(runGuard(htmlDir, provider).code, 0);
  });

  it('fails a renderer that emits classed markup with no styles export', () => {
    const [htmlDir, provider] = makeFixture(
      {
        'barHtml.ts': `export function renderBarTabBody(): string {
          return \`<div class="bar-body">x</div>\`;
        }`,
      },
      `const nothing = 1;`
    );

    const result = runGuard(htmlDir, provider);

    assert.strictEqual(result.code, 1);
    assert.match(result.output, /barHtml\.ts/);
    assert.match(result.output, /exports no/);
  });

  it('fails a styles export the provider never references', () => {
    const [htmlDir, provider] = makeFixture(
      { 'fooHtml.ts': WIRED_TAB },
      `const unrelated = otherTabStyles();`
    );

    const result = runGuard(htmlDir, provider);

    assert.strictEqual(result.code, 1);
    assert.match(result.output, /never references it/);
  });

  it('ignores a module that emits no classed markup', () => {
    const [htmlDir, provider] = makeFixture(
      { 'helpers.ts': `export function toPosix(p: string): string { return p; }` },
      `const nothing = 1;`
    );

    assert.strictEqual(runGuard(htmlDir, provider).code, 0);
  });
});

describe('check-tab-styles-wired guard — the real tree', () => {
  it('passes on the shipped tool-window tab renderers', () => {
    const stdout = execFileSync('node', [SCRIPT], { encoding: 'utf8' });

    assert.match(stdout, /OK/);
  });
});

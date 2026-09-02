/**
 * Companion spec for scripts/check-ctw-button-menu-wired.mjs.
 *
 * A guard that cannot fail is worse than no guard — it reads as coverage.
 * These drive the script over fixture trees and pin both failure arms (a
 * `.ctw-*-menu` CSS rule with no matching createButtonMenuPanel call; a
 * createButtonMenuPanel call with no matching CSS rule) plus the passing
 * shape, so a third panel added on only one side of the pairing breaks here.
 */

import '../../setup';
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-ctw-button-menu-wired.mjs');

/** Build a fixture styles file + webview dir; returns their paths. */
function makeFixture(stylesSource: string, webviewFiles: Record<string, string>): [string, string] {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'ctw-button-menu-'));
  const stylesFile = path.join(root, 'commitToolWindowStyles.ts');
  fs.writeFileSync(stylesFile, stylesSource);
  const webviewDir = path.join(root, 'webview');
  fs.mkdirSync(webviewDir);
  for (const [name, source] of Object.entries(webviewFiles)) {
    fs.writeFileSync(path.join(webviewDir, name), source);
  }
  return [stylesFile, webviewDir];
}

/** Run the guard; returns exit code + combined output. */
function runGuard(stylesFile: string, webviewDir: string): { code: number; output: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT, stylesFile, webviewDir], { encoding: 'utf8' });
    return { code: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('check-ctw-button-menu-wired guard', () => {
  it('passes a CSS rule and a createButtonMenuPanel call that name the same class', () => {
    const [stylesFile, webviewDir] = makeFixture(
      `export function commitToolWindowStyles(): string {
        return \`.ctw-gear-menu { position: absolute; }\`;
      }`,
      {
        'commitToolWindow.ts': `
          const gearMenu = createButtonMenuPanel('ctw-gear-menu');
        `,
      }
    );

    assert.strictEqual(runGuard(stylesFile, webviewDir).code, 0);
  });

  it('fails a `.ctw-*-menu` CSS rule with no matching createButtonMenuPanel call', () => {
    const [stylesFile, webviewDir] = makeFixture(
      `export function commitToolWindowStyles(): string {
        return \`.ctw-orphan-menu { position: absolute; }\`;
      }`,
      { 'commitToolWindow.ts': `const nothing = 1;` }
    );

    const result = runGuard(stylesFile, webviewDir);

    assert.strictEqual(result.code, 1);
    assert.match(result.output, /ctw-orphan-menu/);
    assert.match(result.output, /no createButtonMenuPanel/);
  });

  it('fails a createButtonMenuPanel call with no matching `.ctw-*-menu` CSS rule', () => {
    const [stylesFile, webviewDir] = makeFixture(
      `export function commitToolWindowStyles(): string {
        return \`.ctw-gear-menu { position: absolute; }\`;
      }`,
      {
        'commitToolWindow.ts': `
          const gearMenu = createButtonMenuPanel('ctw-gear-menu');
          const untitled = createButtonMenuPanel('ctw-unstyled-menu');
        `,
      }
    );

    const result = runGuard(stylesFile, webviewDir);

    assert.strictEqual(result.code, 1);
    assert.match(result.output, /ctw-unstyled-menu/);
    assert.match(result.output, /no `\.ctw-\*-menu` CSS rule/);
  });

  it('finds a createButtonMenuPanel call in any file under the webview directory', () => {
    const [stylesFile, webviewDir] = makeFixture(
      `export function commitToolWindowStyles(): string {
        return \`.ctw-gear-menu { position: absolute; }\`;
      }`,
      {
        'ctwButtonMenus.ts': `const PANEL_SELECTOR = '[data-ctw-button-menu]';`,
        'commitToolWindow.ts': `const gearMenu = createButtonMenuPanel('ctw-gear-menu');`,
      }
    );

    assert.strictEqual(runGuard(stylesFile, webviewDir).code, 0);
  });

  it('still finds a CSS rule declared only with a modifier chain (`.ctw-x-menu.open`)', () => {
    const [stylesFile, webviewDir] = makeFixture(
      `export function commitToolWindowStyles(): string {
        return \`.ctw-gear-menu.open { display: block; }\`;
      }`,
      { 'commitToolWindow.ts': `const gearMenu = createButtonMenuPanel('ctw-gear-menu');` }
    );

    const result = runGuard(stylesFile, webviewDir);

    assert.strictEqual(result.code, 0, result.output);
  });

  it('does NOT let a class name mentioned only in a comment count as a CSS rule, even when a real rule follows it in the same file', () => {
    const [stylesFile, webviewDir] = makeFixture(
      `export function commitToolWindowStyles(): string {
        return \`/* .ctw-gear-menu is styled elsewhere */
        .ctw-primary-menu { position: absolute; }\`;
      }`,
      {
        'commitToolWindow.ts':
          "const gearMenu = createButtonMenuPanel('ctw-gear-menu');\n" +
          "const primaryMenu = createButtonMenuPanel('ctw-primary-menu');",
      }
    );

    const result = runGuard(stylesFile, webviewDir);

    assert.strictEqual(
      result.code,
      1,
      `a comment mention must not excuse an unstyled panel, even with a real rule right after it:\n${result.output}`
    );
    assert.match(result.output, /ctw-gear-menu/);
    assert.match(result.output, /renders unstyled/);
    assert.doesNotMatch(
      result.output,
      /ctw-primary-menu/,
      'the real rule must not also be flagged'
    );
  });

  it('finds every class in a grouped selector, not only the first (`.ctw-x-menu, .ctw-y-menu { … }`)', () => {
    const [stylesFile, webviewDir] = makeFixture(
      `export function commitToolWindowStyles(): string {
        return \`.ctw-gear-menu, .ctw-primary-menu { position: absolute; }\`;
      }`,
      {
        'commitToolWindow.ts':
          "const gearMenu = createButtonMenuPanel('ctw-gear-menu');\n" +
          "const primaryMenu = createButtonMenuPanel('ctw-primary-menu');",
      }
    );

    const result = runGuard(stylesFile, webviewDir);

    assert.strictEqual(result.code, 0, result.output);
  });

  it('fails loudly, not vacuously, when both the styles file and the webview directory are missing', () => {
    const missingStyles = path.join(SCRATCH_ROOT, 'does-not-exist-styles.ts');
    const missingWebview = path.join(SCRATCH_ROOT, 'does-not-exist-webview');

    const result = runGuard(missingStyles, missingWebview);

    assert.strictEqual(result.code, 1, 'missing inputs must fail, not report OK');
    assert.match(result.output, /styles file does not exist/);
  });

  it('rejects a single positional argument rather than silently scanning the real tree', () => {
    let output = '';
    let code = 0;
    try {
      output = execFileSync('node', [SCRIPT, '/some/path'], { encoding: 'utf8' });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      code = e.status ?? 1;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }

    assert.strictEqual(code, 1, 'a single argument must not fall through to real mode');
    assert.match(output, /expected 0 arguments.*or 2-3/);
  });

  it('opts back into the floor in fixture mode with --check-floor, and fails below it', () => {
    const [stylesFile, webviewDir] = makeFixture(
      `export function commitToolWindowStyles(): string {
        return \`.ctw-gear-menu { position: absolute; }\`;
      }`,
      { 'commitToolWindow.ts': `const gearMenu = createButtonMenuPanel('ctw-gear-menu');` }
    );

    let output = '';
    let code = 0;
    try {
      output = execFileSync('node', [SCRIPT, stylesFile, webviewDir, '--check-floor'], {
        encoding: 'utf8',
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      code = e.status ?? 1;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }

    assert.strictEqual(code, 1, 'a single-class fixture must fail once the floor applies');
    assert.match(output, /only 1 .ctw-\*-menu CSS rule/);
  });

  it('rejects a third argument that is not exactly --check-floor', () => {
    const [stylesFile, webviewDir] = makeFixture(
      `export function commitToolWindowStyles(): string {
        return \`.ctw-gear-menu { position: absolute; }\`;
      }`,
      { 'commitToolWindow.ts': `const gearMenu = createButtonMenuPanel('ctw-gear-menu');` }
    );

    let output = '';
    let code = 0;
    try {
      output = execFileSync('node', [SCRIPT, stylesFile, webviewDir, 'banana'], {
        encoding: 'utf8',
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      code = e.status ?? 1;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }

    assert.strictEqual(
      code,
      1,
      'an unrecognised third argument must not silently leave the floor off'
    );
    assert.match(output, /--check-floor/);
  });

  it('the floor is off by default in fixture mode, so a single-class fixture still passes', () => {
    const [stylesFile, webviewDir] = makeFixture(
      `export function commitToolWindowStyles(): string {
        return \`.ctw-gear-menu { position: absolute; }\`;
      }`,
      { 'commitToolWindow.ts': `const gearMenu = createButtonMenuPanel('ctw-gear-menu');` }
    );

    assert.strictEqual(runGuard(stylesFile, webviewDir).code, 0);
  });
});

describe('check-ctw-button-menu-wired guard — the real tree', () => {
  it('passes on the shipped commit tool window button menus', () => {
    const stdout = execFileSync('node', [SCRIPT], { encoding: 'utf8' });

    assert.match(stdout, /OK/);
  });
});

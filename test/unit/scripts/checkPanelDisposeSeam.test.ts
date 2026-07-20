/**
 * Companion spec for scripts/check-panel-dispose-seam.mjs.
 *
 * The guard exists because a BaseWebviewPanel subclass that registers its own
 * onDidDispose into the disposables the base drains never fires that callback,
 * hanging any promise it was meant to settle. The fixtures below pin the shapes
 * the guard must see — critically BOTH the multi-line and the single-line
 * registration, since prettier keeps a short one on one line and that is the
 * most likely form a reintroduction would take.
 *
 * Re-proving the guard against real history: use the commit BEFORE "Settle
 * dialog promises from dispose() instead of a drained onDidDispose", which is
 * genuinely red for THIS guard. Do not reuse the host guard's ancestor — the
 * two guards have different true-red commits, and picking the wrong one reads
 * as a false OK. Extract with `git show <rev>:<path>` into a fixture root.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-panel-dispose-seam.mjs');

function makeFixture(files: Record<string, string>): string {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'dispose-seam-'));
  for (const [rel, source] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source);
  }
  return root;
}

function runGuard(root: string): { code: number; output: string } {
  try {
    return { code: 0, output: execFileSync('node', [SCRIPT, root], { encoding: 'utf8' }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const MULTILINE = `
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
export class DemoDialog extends BaseWebviewPanel<never> {
  prompt(): void {
    this._panel.onDidDispose(
      () => {
        this._finish(undefined);
      },
      null,
      this._disposables
    );
  }
}
`;

const SINGLE_LINE = `
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
export class DemoDialog extends BaseWebviewPanel<never> {
  prompt(): void {
    this._panel.onDidDispose(() => this._finish(undefined), null, this._disposables);
  }
}
`;

const ALIASED = `
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
export class DemoDialog extends BaseWebviewPanel<never> {
  prompt(): void {
    const panel = this._panel;
    panel.onDidDispose(() => this._finish(undefined), null, this._disposables);
  }
}
`;

const COMPLIANT = `
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
export class DemoDialog extends BaseWebviewPanel<never> {
  override dispose(): void {
    this._settle(undefined);
    super.dispose();
  }
}
`;

describe('check-panel-dispose-seam guard', () => {
  it('fails the multi-line registration', () => {
    const result = runGuard(makeFixture({ 'sync/DemoDialog.ts': MULTILINE }));

    assert.strictEqual(result.code, 1);
    assert.match(result.output, /onDidDispose/);
  });

  it('fails the SINGLE-LINE registration — prettier keeps a short one on one line', () => {
    const result = runGuard(makeFixture({ 'sync/DemoDialog.ts': SINGLE_LINE }));

    assert.strictEqual(result.code, 1, 'a one-line registration is the same defect');
  });

  it('fails a registration that aliases the panel to a local', () => {
    const result = runGuard(makeFixture({ 'sync/DemoDialog.ts': ALIASED }));

    assert.strictEqual(result.code, 1, 'aliasing must not hide the call');
  });

  it('passes a subclass that settles from an overridden dispose()', () => {
    assert.strictEqual(runGuard(makeFixture({ 'sync/DemoDialog.ts': COMPLIANT })).code, 0);
  });

  it('passes when the call carries the escape-hatch annotation directly above it', () => {
    const annotated = SINGLE_LINE.replace(
      '    this._panel.onDidDispose(',
      '    // dispose-seam-exempt: fixture\n    this._panel.onDidDispose('
    );

    assert.strictEqual(runGuard(makeFixture({ 'sync/DemoDialog.ts': annotated })).code, 0);
  });

  it('does NOT let an annotation elsewhere in the file exempt an unrelated call', () => {
    const strayAnnotation = SINGLE_LINE.replace(
      "import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';",
      "// dispose-seam-exempt: about something else entirely\nimport { BaseWebviewPanel } from '../utils/BaseWebviewPanel';"
    );

    assert.strictEqual(
      runGuard(makeFixture({ 'sync/DemoDialog.ts': strayAnnotation })).code,
      1,
      'a file-level mention must not blanket-exempt every call in it'
    );
  });

  it('fails a subclass reached through an intermediate class', () => {
    const files = {
      'utils/MidPanel.ts':
        "import { BaseWebviewPanel } from './BaseWebviewPanel';\nexport class MidPanel extends BaseWebviewPanel<never> {}\n",
      'sync/DemoDialog.ts': SINGLE_LINE.replace(
        'extends BaseWebviewPanel<never>',
        'extends MidPanel'
      ).replace(
        "import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';",
        "import { MidPanel } from '../utils/MidPanel';"
      ),
    };

    assert.strictEqual(runGuard(makeFixture(files)).code, 1, 'inheritance is transitive');
  });

  it('fails an anonymous default-exported subclass', () => {
    const anonymous = SINGLE_LINE.replace(
      'export class DemoDialog extends BaseWebviewPanel<never>',
      'export default class extends BaseWebviewPanel<never>'
    );

    assert.strictEqual(runGuard(makeFixture({ 'sync/DemoDialog.ts': anonymous })).code, 1);
  });

  it('fails a registration made through optional chaining', () => {
    const optional = SINGLE_LINE.replace('this._panel.onDidDispose(', 'this._panel?.onDidDispose(');

    assert.strictEqual(runGuard(makeFixture({ 'sync/DemoDialog.ts': optional })).code, 1);
  });

  it('does NOT accept the escape hatch inside a string literal', () => {
    const stringy = SINGLE_LINE.replace(
      '    this._panel.onDidDispose(',
      "    const note = 'dispose-seam-exempt: not a comment';\n    this._panel.onDidDispose("
    );

    assert.strictEqual(
      runGuard(makeFixture({ 'sync/DemoDialog.ts': stringy })).code,
      1,
      'only a real comment may exempt'
    );
  });

  it('is not disabled by prose naming the base class in a comment', () => {
    const prose = SINGLE_LINE.replace(
      'export class DemoDialog',
      '// Unlike class BaseWebviewPanel, this one is special.\nexport class DemoDialog'
    );

    assert.strictEqual(
      runGuard(makeFixture({ 'sync/DemoDialog.ts': prose })).code,
      1,
      'a comment must not switch the guard off for the file'
    );
  });

  it('sees a registration below a regex literal containing quote characters', () => {
    // An odd number of quote characters inside a regex literal used to open
    // string mode in the shared scanner, blanking the rest of the file from the
    // code view and switching the guard off for everything below it.
    const afterRegex = SINGLE_LINE.replace(
      'export class DemoDialog',
      'const quoted = /["\']/;\nexport class DemoDialog'
    );

    assert.strictEqual(
      runGuard(makeFixture({ 'sync/DemoDialog.ts': afterRegex })).code,
      1,
      'a regex literal must not blank the code below it'
    );
  });

  it('sees a registration below a postfix ++ followed by division', () => {
    // `i++ / 2` divides. Reading that slash as opening a regex would mask the
    // rest of the line and, worse, hide real code from the guard.
    const afterDivision = SINGLE_LINE.replace(
      '    this._panel.onDidDispose(',
      '    const half = counter++ / 2;\n    void half;\n    this._panel.onDidDispose('
    );

    assert.strictEqual(
      runGuard(makeFixture({ 'sync/DemoDialog.ts': afterDivision })).code,
      1,
      'division after a postfix increment is not a regex literal'
    );
  });

  it('reports the real file line for a call below a line continuation', () => {
    // A backslash-newline inside a string literal used to drop that newline
    // from every view. Scoping stayed self-consistent (both views shifted
    // alike), but the REPORTED line no longer addressed the real file, so the
    // diagnostic pointed a reader at the wrong line.
    const continued = SINGLE_LINE.replace(
      '    this._panel.onDidDispose(',
      "    const banner = 'wide \\\n text';\n    this._panel.onDidDispose("
    );
    const expectedLine =
      continued.split('\n').findIndex((l) => l.includes('this._panel.onDidDispose(')) + 1;

    const result = runGuard(makeFixture({ 'sync/DemoDialog.ts': continued }));

    assert.strictEqual(result.code, 1);
    assert.match(
      result.output,
      new RegExp(`DemoDialog\\.ts:${expectedLine}:`),
      'the reported line must address the real file'
    );
  });

  it('does not read a full call shape inside a string literal as a registration', () => {
    // The code view exists to blank string bodies. Without this the guard has
    // no spec that fails when that blanking stops, since every other fixture
    // puts its call shape in real code.
    const quotedCall = COMPLIANT.replace(
      '  override dispose(): void {',
      "  readonly hint = 'this._panel.onDidDispose(cb, null, this._disposables)';\n" +
        '  override dispose(): void {'
    );

    assert.strictEqual(
      runGuard(makeFixture({ 'sync/DemoDialog.ts': quotedCall })).code,
      0,
      'a call shape in a string is not a registration'
    );
  });

  it('sees a registration sharing a line with a division', () => {
    // A `/` misread as opening a regex masks to end-of-line, so a violation on
    // the same line as a division would vanish. The lexer's division direction
    // is load-bearing for this guard, not a detail of the lexer alone.
    const sameLine = `
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
export class DemoDialog extends BaseWebviewPanel<never> {
  w(a: number, b: number): void { const q = a / b; void q; this._panel.onDidDispose(() => this._f(), null, this._disposables); }
}
`;

    assert.strictEqual(
      runGuard(makeFixture({ 'sync/DemoDialog.ts': sameLine })).code,
      1,
      'a division must not mask the rest of its line'
    );
  });

  it('reports the declared false positive for a regex written after `)`', () => {
    // Pins the limitation section 4(e) declares: a regex directly after `)` is
    // read as division, so its body is scanned as code and a call shape inside
    // it is reported. Compliant source, non-zero exit. Documented, not silent.
    const regexAfterParen = `
import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';
export class DemoDialog extends BaseWebviewPanel<never> {
  override dispose(): void {
    this._settle(undefined);
    super.dispose();
  }
  probe(s: string, x: boolean): void {
    if (x) /this._panel.onDidDispose(cb, null, this._disposables)/.test(s);
  }
}
`;

    assert.strictEqual(
      runGuard(makeFixture({ 'sync/DemoDialog.ts': regexAfterParen })).code,
      1,
      'the declared over-scan costs a false positive, never a missed violation'
    );
  });

  it('ignores a class that does not extend BaseWebviewPanel', () => {
    const standalone = SINGLE_LINE.replace(
      'extends BaseWebviewPanel<never>',
      'implements Disposable'
    ).replace("import { BaseWebviewPanel } from '../utils/BaseWebviewPanel';\n", '');

    assert.strictEqual(
      runGuard(makeFixture({ 'rebase/DemoDialog.ts': standalone })).code,
      0,
      'a standalone panel has no earlier draining listener'
    );
  });
});

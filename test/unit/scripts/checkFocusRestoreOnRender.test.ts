/**
 * Companion spec for scripts/check-focus-restore-on-render.mjs.
 *
 * The guard has two arms: a render from a gesture handler must ask for focus
 * restore, and the flag that carries that request may only be written inside
 * `_renderForGesture`. Each recognised handler shape gets a failing fixture and
 * a passing twin, so a shape cannot go green by matching nothing — which is how
 * class methods, object-literal methods and generic headers went unchecked.
 *
 * Re-proving the guard against real history: use the commit BEFORE focus
 * restore moved behind `_renderForGesture`, extracted with
 * `git show <rev>:<path>` into a fixture root.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-focus-restore-on-render.mjs');

/** A provider whose only write to the flag is the sanctioned one. */
const CLEAN_PROVIDER = `export class GitToolWindowProvider {
  private _restoreFocusOnNextRender = false;
  _renderForGesture(): void {
    this._restoreFocusOnNextRender = true;
    this._render();
    this._restoreFocusOnNextRender = false;
  }
}
`;

/** A handler module that renders the compliant way. */
const CLEAN_HANDLER = `export function handleClean(ctx: Ctx): void {
  ctx.updateWebview(true);
}
`;

function makeFixture(handler: string, provider: string = CLEAN_PROVIDER): string {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'focus-restore-'));
  const toolWindow = path.join(root, 'git-core', 'gitToolWindow');
  fs.mkdirSync(path.join(toolWindow, 'provider'), { recursive: true });
  fs.writeFileSync(path.join(toolWindow, 'provider', 'handlers.ts'), handler);
  fs.writeFileSync(path.join(toolWindow, 'GitToolWindowProvider.ts'), provider);
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

describe('check-focus-restore-on-render guard', () => {
  describe('arm (a): handler shapes', () => {
    it('fails a plain exported function that renders without the flag', () => {
      const result = runGuard(
        makeFixture(`export function handleThing(ctx: Ctx): void {\n  ctx.updateWebview();\n}\n`)
      );

      assert.strictEqual(result.code, 1);
      assert.match(result.output, /handleThing/);
    });

    it('passes the same function when it renders for a gesture', () => {
      assert.strictEqual(runGuard(makeFixture(CLEAN_HANDLER)).code, 0);
    });

    it('fails an arrow assigned to a const', () => {
      const result = runGuard(
        makeFixture(
          `export const handleThing = (ctx: Ctx): void => {\n  ctx.updateWebview();\n};\n`
        )
      );

      assert.strictEqual(result.code, 1);
    });

    it('fails a CLASS METHOD that renders without the flag', () => {
      const result = runGuard(
        makeFixture(
          `export class Handlers {\n  handleThing(ctx: Ctx): void {\n    ctx.updateWebview();\n  }\n}\n`
        )
      );

      assert.strictEqual(result.code, 1, 'a method is a handler like any other');
    });

    it('passes a class method that renders for a gesture', () => {
      const result = runGuard(
        makeFixture(
          `export class Handlers {\n  handleThing(ctx: Ctx): void {\n    ctx.updateWebview(true);\n  }\n}\n`
        )
      );

      assert.strictEqual(result.code, 0);
    });

    it('fails an OBJECT-LITERAL METHOD that renders without the flag', () => {
      const result = runGuard(
        makeFixture(
          `export const handlers = {\n  handleThing(ctx: Ctx): void {\n    ctx.updateWebview();\n  },\n};\n`
        )
      );

      assert.strictEqual(result.code, 1);
    });

    it('fails a GENERIC function header that renders without the flag', () => {
      // A `<T>` used to break the header anchor, so the body was absorbed into
      // the preceding function and never checked on its own.
      const result = runGuard(
        makeFixture(`export function handleThing<T>(ctx: Ctx): void {\n  ctx.updateWebview();\n}\n`)
      );

      assert.strictEqual(result.code, 1);
    });

    it('checks a generic handler on its own, not as part of its predecessor', () => {
      // The predecessor is compliant; only the generic one offends. If the
      // generic header were unrecognised, the offending render would be read as
      // part of the clean function above it and pass.
      const result = runGuard(
        makeFixture(
          CLEAN_HANDLER +
            `export function handleGeneric<T>(ctx: Ctx): void {\n  ctx.updateWebview();\n}\n`
        )
      );

      assert.strictEqual(result.code, 1);
      assert.match(result.output, /handleGeneric/, 'the generic function is named as the offender');
    });

    it('fails a GENERIC const arrow that renders without the flag', () => {
      // The `<T,>` sits between the `=` and the parameter list, which the arrow
      // headers did not allow for, so the body absorbed into the function above
      // it — the same absorption the generic `function` header had.
      const result = runGuard(
        makeFixture(
          `export const handleThing = <T,>(ctx: Ctx): void => {\n  ctx.updateWebview();\n};\n`
        )
      );

      assert.strictEqual(result.code, 1);
    });

    it('checks a generic arrow on its own, not as part of its predecessor', () => {
      const result = runGuard(
        makeFixture(
          CLEAN_HANDLER +
            `export const handleGenericArrow = <T,>(ctx: Ctx): void => {\n  ctx.updateWebview();\n};\n`
        )
      );

      assert.strictEqual(result.code, 1);
      assert.match(result.output, /handleGenericArrow/);
    });

    it('fails an arrow taking a single unparenthesised parameter', () => {
      const result = runGuard(
        makeFixture(`export const handleThing = ctx => {\n  ctx.updateWebview();\n};\n`)
      );

      assert.strictEqual(result.code, 1);
    });

    it('fails a default-exported function declaration', () => {
      const result = runGuard(
        makeFixture(
          `export default function handleThing(ctx: Ctx): void {\n  ctx.updateWebview();\n}\n`
        )
      );

      assert.strictEqual(result.code, 1);
    });

    it('does not read a statement keyword as a function name', () => {
      // `if (…) {` matches the method shape structurally, so it must be
      // rejected by name. The annotation sits in the function body while the
      // render sits inside the branch: accept `if` as a header and the two are
      // split apart, leaving the render looking unannotated. A fixture whose
      // render sits beside its annotation passes either way and proves nothing.
      const result = runGuard(
        makeFixture(
          `export function handleThing(ctx: Ctx, flag: boolean): void {\n` +
            `  // focus-restore-exempt: fixture\n` +
            `  if (flag) {\n    ctx.updateWebview();\n  }\n}\n`
        )
      );

      assert.strictEqual(result.code, 0, 'the branch belongs to the function that annotated it');
    });

    it('finds a handler in a SUBDIRECTORY of provider/', () => {
      // The scan listed provider/ one level deep, so a nested handler was never
      // read at all.
      fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
      const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'focus-restore-nested-'));
      const providerDir = path.join(root, 'git-core', 'gitToolWindow', 'provider');
      fs.mkdirSync(path.join(providerDir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(providerDir, 'top.ts'), CLEAN_HANDLER);
      fs.writeFileSync(
        path.join(providerDir, 'sub', 'nested.ts'),
        `export function handleNested(ctx: Ctx): void {\n  ctx.updateWebview();\n}\n`
      );
      fs.writeFileSync(
        path.join(root, 'git-core', 'gitToolWindow', 'GitToolWindowProvider.ts'),
        CLEAN_PROVIDER
      );

      const result = runGuard(root);

      assert.strictEqual(result.code, 1);
      assert.match(result.output, /handleNested/);
    });

    it('does not accept a COMMENTED-OUT gesture render as compliance', () => {
      // Testing compliance against raw text let a one-line comment silence the
      // fence. Rendering for a gesture is a code question.
      const result = runGuard(
        makeFixture(
          `export function handleThing(ctx: Ctx): void {\n` +
            `  // ctx.updateWebview(true);\n  ctx.updateWebview();\n}\n`
        )
      );

      assert.strictEqual(result.code, 1);
    });

    it('does not accept a gesture render quoted in a string as compliance', () => {
      const result = runGuard(
        makeFixture(
          `export function handleThing(ctx: Ctx): void {\n` +
            `  const hint = 'ctx.updateWebview(true)';\n  void hint;\n  ctx.updateWebview();\n}\n`
        )
      );

      assert.strictEqual(result.code, 1);
    });

    it('does not treat a commented-out render as a render at all', () => {
      const result = runGuard(
        makeFixture(
          `export function handleThing(ctx: Ctx): void {\n` +
            `  // ctx.updateWebview();\n  ctx.log('nothing');\n}\n`
        )
      );

      assert.strictEqual(result.code, 0);
    });

    it('fails a plain (unexported) const arrow that renders without the flag', () => {
      // The unexported arrow has its own header arm; an exported fixture would
      // exercise the arm above it instead.
      const result = runGuard(
        makeFixture(`const handleThing = (ctx: Ctx): void => {\n  ctx.updateWebview();\n};\n`)
      );

      assert.strictEqual(result.code, 1);
    });

    it('fails a GENERIC class method that renders without the flag', () => {
      const result = runGuard(
        makeFixture(
          `export class Handlers {\n  handleThing<T>(ctx: Ctx): void {\n    ctx.updateWebview();\n  }\n}\n`
        )
      );

      assert.strictEqual(result.code, 1);
    });

    it('passes a handler carrying the exempt annotation in its body', () => {
      const result = runGuard(
        makeFixture(
          `export function handleThing(ctx: Ctx): void {\n` +
            `  // focus-restore-exempt: fixture\n  ctx.updateWebview();\n}\n`
        )
      );

      assert.strictEqual(result.code, 0);
    });

    it('does NOT accept the exempt annotation spelled inside a string', () => {
      const result = runGuard(
        makeFixture(
          `export function handleThing(ctx: Ctx): void {\n` +
            `  const hint = 'focus-restore-exempt: nope';\n` +
            `  void hint;\n  ctx.updateWebview();\n}\n`
        )
      );

      assert.strictEqual(result.code, 1, 'only a real comment may exempt');
    });

    it('ignores a function that never renders', () => {
      const result = runGuard(
        makeFixture(`export function handleThing(ctx: Ctx): void {\n  ctx.log('nothing');\n}\n`)
      );

      assert.strictEqual(result.code, 0);
    });
  });

  describe('arm (b): who may write the gesture flag', () => {
    const withWrite = (body: string): string => `export class GitToolWindowProvider {
  private _restoreFocusOnNextRender = false;
  _renderForGesture(): void {
    this._restoreFocusOnNextRender = true;
    this._render();
    this._restoreFocusOnNextRender = false;
  }
  sneak(): void {
    ${body}
  }
}
`;

    it('passes a provider whose only writes are inside _renderForGesture', () => {
      assert.strictEqual(runGuard(makeFixture(CLEAN_HANDLER, CLEAN_PROVIDER)).code, 0);
    });

    it('fails a plain assignment outside _renderForGesture', () => {
      const result = runGuard(
        makeFixture(CLEAN_HANDLER, withWrite('this._restoreFocusOnNextRender = true;'))
      );

      assert.strictEqual(result.code, 1);
    });

    it('fails a logical assignment outside _renderForGesture', () => {
      const result = runGuard(
        makeFixture(CLEAN_HANDLER, withWrite('this._restoreFocusOnNextRender ||= true;'))
      );

      assert.strictEqual(result.code, 1, '||= sets the flag as effectively as =');
    });

    it('fails a write smuggled through Object.assign', () => {
      const result = runGuard(
        makeFixture(
          CLEAN_HANDLER,
          withWrite('Object.assign(this, { _restoreFocusOnNextRender: true });')
        )
      );

      assert.strictEqual(result.code, 1);
    });

    it('does not treat a comparison as a write', () => {
      const result = runGuard(
        makeFixture(
          CLEAN_HANDLER,
          withWrite('if (this._restoreFocusOnNextRender === true) { this._render(); }')
        )
      );

      assert.strictEqual(result.code, 0, 'reading the flag is not writing it');
    });

    it('does not treat the field declaration itself as a write', () => {
      const typedField = CLEAN_PROVIDER.replace(
        'private _restoreFocusOnNextRender = false;',
        'private _restoreFocusOnNextRender: boolean = false;'
      );

      assert.strictEqual(runGuard(makeFixture(CLEAN_HANDLER, typedField)).code, 0);
    });
  });

  describe('scope', () => {
    it('fails loudly when the scan root holds neither target', () => {
      const result = runGuard(path.join(SCRATCH_ROOT, 'focus-restore-absent'));

      assert.strictEqual(result.code, 1);
      assert.match(result.output, /does not exist/);
    });
  });
});

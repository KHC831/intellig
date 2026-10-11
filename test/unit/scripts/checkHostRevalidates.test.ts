/**
 * Companion spec for scripts/check-host-revalidates.mjs.
 *
 * The guard exists because a webview is a separate scripting context: its
 * validation is a UX affordance, and the host is the trust boundary. The
 * fixtures pin the evasions that matter — a host that only NAMES the validator
 * in a comment (the original W10 signature was exactly such a claim), and a
 * validator module renamed off the naming convention.
 *
 * Re-proving the guard against real history: use the commit BEFORE
 * "Re-validate the submitted remote name and URL on the host". The panel
 * guard's ancestor is NOT interchangeable — it already contains this fix, so
 * it reads as a false OK. Extract with `git show <rev>:<path>` into a fixture
 * root.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-host-revalidates.mjs');

function makeFixture(files: Record<string, string>): string {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'host-revalidates-'));
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

const VALIDATOR = `
export function validateThingName(n: string): string | undefined {
  return n.length > 0 ? undefined : 'empty';
}
`;

const ENTRY = `
import { validateThingName } from '../thingValidation';
export function render(): void {
  validateThingName('x');
}
`;

/** Files for one scenario, parameterised by host body and validator module name. */
function scenario(hostBody: string, validatorModule = 'thingValidation'): Record<string, string> {
  return {
    [`sync/${validatorModule}.ts`]: VALIDATOR,
    'sync/webview/thingDialog.ts': ENTRY.replace('../thingValidation', `../${validatorModule}`),
    'sync/ThingDialog.ts': hostBody,
  };
}

describe('check-host-revalidates guard', () => {
  it('fails a host that never validates', () => {
    const result = runGuard(
      makeFixture(scenario(`export class ThingDialog { submit(n: string): string { return n; } }`))
    );

    assert.strictEqual(result.code, 1);
    assert.match(result.output, /validateThingName/);
  });

  it('fails a host that only NAMES the validator in a comment', () => {
    const result = runGuard(
      makeFixture(
        scenario(
          `// The host trusts that validateThingName(n) has already been applied.\n` +
            `export class ThingDialog { submit(n: string): string { return n; } }`
        )
      )
    );

    assert.strictEqual(result.code, 1, 'a claim in a comment is not validation');
  });

  it('fails a host that only names the validator in a block comment', () => {
    const result = runGuard(
      makeFixture(
        scenario(
          `/* validateThingName(n) runs upstream, allegedly. */\n` +
            `export class ThingDialog { submit(n: string): string { return n; } }`
        )
      )
    );

    assert.strictEqual(result.code, 1);
  });

  it('fails when the validator module is renamed off the naming convention', () => {
    const result = runGuard(
      makeFixture(
        scenario(
          `export class ThingDialog { submit(n: string): string { return n; } }`,
          'thingRules'
        )
      )
    );

    assert.strictEqual(result.code, 1, 'a validator is detected by its exports, not just its name');
  });

  it('passes a host that actually calls the validator', () => {
    const result = runGuard(
      makeFixture(
        scenario(
          `import { validateThingName } from './thingValidation';\n` +
            `export class ThingDialog {\n` +
            `  submit(n: string): string | undefined { return validateThingName(n); }\n` +
            `}`
        )
      )
    );

    assert.strictEqual(result.code, 0);
  });

  it('passes a host that reaches the validator through a re-export', () => {
    const files = scenario(
      `import { validateThingName } from './ThingService';\n` +
        `export class ThingDialog {\n` +
        `  submit(n: string): string | undefined { return validateThingName(n); }\n` +
        `}`
    );
    files['sync/ThingService.ts'] = `export { validateThingName } from './thingValidation';`;

    assert.strictEqual(runGuard(makeFixture(files)).code, 0);
  });

  it('passes a host that validates and also contains a URL string literal', () => {
    // G4 regression: stripping line comments before string literals ate from
    // the `//` inside 'https://…' to end of line, deleting the real call. The
    // guard's live subject is a remote-URL dialog, so this shape is natural.
    const result = runGuard(
      makeFixture(
        scenario(
          `import { validateThingName } from './thingValidation';\n` +
            `export class ThingDialog {\n` +
            `  submit(n: string): string | undefined {\n` +
            `    const placeholder = 'https://example.com/repo.git';\n` +
            `    void placeholder;\n` +
            `    return validateThingName(n);\n` +
            `  }\n` +
            `}`
        )
      )
    );

    assert.strictEqual(result.code, 0, 'a URL literal must not hide the validation call');
  });

  it('fails a host whose only mention of the validator is inside a string literal', () => {
    const result = runGuard(
      makeFixture(
        scenario(
          `export class ThingDialog {\n` +
            `  submit(n: string): string { return n; }\n` +
            `  note = 'call validateThingName(n) here one day';\n` +
            `}`
        )
      )
    );

    assert.strictEqual(result.code, 1, 'a string literal is not a call');
  });

  it('does NOT accept the escape hatch inside a string literal', () => {
    const result = runGuard(
      makeFixture(
        scenario(
          `export class ThingDialog {\n` +
            `  note = 'host-validated-elsewhere: not a comment';\n` +
            `  submit(n: string): string { return n; }\n` +
            `}`
        )
      )
    );

    assert.strictEqual(result.code, 1, 'only a real comment may exempt');
  });

  it('follows a barrel re-export on the ENTRY side', () => {
    const files = scenario(`export class ThingDialog { submit(n: string): string { return n; } }`);
    files['sync/webview/thingDialog.ts'] =
      "import { validateThingName } from '../barrel';\nexport function render(): void { validateThingName('x'); }\n";
    files['sync/barrel.ts'] = "export { validateThingName } from './thingValidation';";

    assert.strictEqual(
      runGuard(makeFixture(files)).code,
      1,
      'a barrel must not hide the dependency'
    );
  });

  it('fails hard when a validator-named module exports nothing recognisable', () => {
    // Skipping silently would let a renamed export shape switch the guard off.
    const files = scenario(`export class ThingDialog { submit(n: string): string { return n; } }`);
    files['sync/thingValidation.ts'] =
      'export class Rules { static check(n: string): boolean { return !!n; } }';

    const result = runGuard(makeFixture(files));

    assert.strictEqual(result.code, 1);
    assert.match(result.output, /exports no/);
  });

  it('detects a validator exported as an arrow const', () => {
    const files = scenario(`export class ThingDialog { submit(n: string): string { return n; } }`);
    files['sync/thingRules.ts'] =
      "export const validateThingName = (n: string): string | undefined => (n ? undefined : 'bad');";
    files['sync/webview/thingDialog.ts'] =
      "import { validateThingName } from '../thingRules';\nexport function render(): void { validateThingName('x'); }\n";
    delete files['sync/thingValidation.ts'];

    assert.strictEqual(
      runGuard(makeFixture(files)).code,
      1,
      'an arrow-const validator is still a validator'
    );
  });

  const INLINE_VALIDATING_HOST =
    `export class ThingDialog {\n` +
    `  submit(n: string): string | undefined {\n` +
    `    if (n.length === 0) { return 'empty'; }\n` +
    `    if (n.includes(' ')) { return 'no spaces'; }\n` +
    `    return undefined;\n` +
    `  }\n` +
    `}`;

  it('fails a host that validates inline without the annotation', () => {
    // A declared false positive, per section 3: the host does re-validate, so
    // the trust boundary holds, but the guard cannot see an inline check.
    const result = runGuard(makeFixture(scenario(INLINE_VALIDATING_HOST)));

    assert.strictEqual(result.code, 1);
  });

  it('passes an inline-validating host that names the inline check in the hatch', () => {
    // The documented remedy. Pinned alongside the failure so the escape route
    // cannot quietly stop working and strand anyone validating inline.
    const result = runGuard(
      makeFixture(
        scenario(
          `// host-validated-elsewhere: submit() checks length and spaces inline\n` +
            INLINE_VALIDATING_HOST
        )
      )
    );

    assert.strictEqual(result.code, 0);
  });

  it('passes a host carrying the escape-hatch annotation', () => {
    const result = runGuard(
      makeFixture(
        scenario(
          `// host-validated-elsewhere: the ops layer rejects it\n` +
            `export class ThingDialog { submit(n: string): string { return n; } }`
        )
      )
    );

    assert.strictEqual(result.code, 0);
  });

  it('fails closed when it finds no webview entry to check', () => {
    const result = runGuard(
      makeFixture({ 'sync/ThingDialog.ts': 'export class ThingDialog {}\n' })
    );
    assert.strictEqual(result.code, 1, result.output);
    assert.match(result.output, /no webview entry/);
  });
});

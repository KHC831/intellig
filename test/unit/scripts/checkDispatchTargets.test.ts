/**
 * Companion spec for scripts/check-dispatch-targets.mjs.
 *
 * Proves the guard (a) passes against the real tree, and (b) has teeth —
 * an `executeCommand('intellig.*')` dispatch with no registration fails,
 * while registered dispatches, exempt-annotated lines, and comment-only
 * mentions pass.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-dispatch-targets.mjs');
const TMP_ROOT = SCRATCH_ROOT;

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeFixture(files: Record<string, string>, pkg?: object): { src: string; pkg: string } {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'dispatch-guard-'));
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(src, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  const pkgPath = path.join(dir, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg ?? { contributes: { commands: [] } }), 'utf8');
  return { src, pkg: pkgPath };
}

describe('check-dispatch-targets guard', () => {
  it('passes against the real tree', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on the real tree; stderr:\n${stderr}`);
  });

  it('fails on a dispatch to an unregistered id (has teeth)', () => {
    const { src, pkg } = makeFixture({
      'sender.ts': `await vscode.commands.executeCommand('intellig.ghost', path);\n`,
    });
    const { status, stderr } = runGuard([src, pkg]);
    assert.strictEqual(status, 1, 'unregistered dispatch must fail');
    assert.ok(/intellig\.ghost/.test(stderr), 'should name the unresolved id');
  });

  it('resolves ids registered via spine spec `id:` literals and registerLoggedCommand', () => {
    const { src, pkg } = makeFixture({
      'reg.ts':
        `registerRepoCommand(ctx, { id: 'intellig.specRegistered' });\n` +
        `registerLoggedCommand('intellig.directRegistered', handler);\n`,
      'sender.ts':
        `await vscode.commands.executeCommand('intellig.specRegistered');\n` +
        `await vscode.commands.executeCommand('intellig.directRegistered');\n`,
    });
    const { status, stderr } = runGuard([src, pkg]);
    assert.strictEqual(status, 0, `both registration shapes must resolve; stderr:\n${stderr}`);
  });

  it('resolves ids declared only in package.json contributes.commands', () => {
    const { src, pkg } = makeFixture(
      { 'sender.ts': `await vscode.commands.executeCommand('intellig.declared');\n` },
      { contributes: { commands: [{ command: 'intellig.declared' }] } }
    );
    const { status } = runGuard([src, pkg]);
    assert.strictEqual(status, 0);
  });

  it('covers multiline dispatch call shapes', () => {
    const { src, pkg } = makeFixture({
      'sender.ts': `await vscode.commands.executeCommand(\n  'intellig.ghostMultiline',\n  arg\n);\n`,
    });
    const { status, stderr } = runGuard([src, pkg]);
    assert.strictEqual(status, 1, 'multiline dispatch must still be scanned');
    assert.ok(/intellig\.ghostMultiline/.test(stderr));
  });

  it('honors the dispatch-exempt escape hatch and skips comment-only mentions', () => {
    const { src, pkg } = makeFixture({
      'sender.ts':
        `// dispatch-exempt: contributed by a companion extension when installed\n` +
        `await vscode.commands.executeCommand('intellig.external');\n` +
        `// executeCommand('intellig.commentedOut') — prose mention only\n`,
    });
    const { status, stderr } = runGuard([src, pkg]);
    assert.strictEqual(status, 0, `exempt + comment mentions must pass; stderr:\n${stderr}`);
  });

  it('ignores dispatches under test subtrees', () => {
    // The src dispatch keeps the scan non-vacuous, so this asserts the test
    // subtree is EXCLUDED rather than that the guard saw nothing at all.
    const { src, pkg } = makeFixture(
      {
        'test/e2e.ts': `await vscode.commands.executeCommand('intellig.testOnly');\n`,
        'ok.ts': `await vscode.commands.executeCommand('intellig.declared');\n`,
      },
      { contributes: { commands: [{ command: 'intellig.declared' }] } }
    );
    const { status } = runGuard([src, pkg]);
    assert.strictEqual(status, 0, 'test subtree dispatches are out of scope');
  });

  // A computed first argument matches the literal scan nowhere, so the id it
  // dispatches leaves the guard's inventory entirely — a rename then passes
  // green. A ternary over two intellig ids did exactly that in this repo.
  it('rejects a computed dispatch id (anti-vacuity)', () => {
    const { src, pkg } = makeFixture(
      {
        'sender.ts':
          `await vscode.commands.executeCommand('intellig.declared');\n` +
          `await vscode.commands.executeCommand(cond ? 'intellig.declared' : 'intellig.other');\n`,
      },
      { contributes: { commands: [{ command: 'intellig.declared' }] } }
    );
    const { status, stderr } = runGuard([src, pkg]);
    assert.strictEqual(status, 1, `a computed id must fail; stderr:\n${stderr}`);
    assert.ok(/computed id/.test(stderr), `expected the computed-id arm; got:\n${stderr}`);
  });

  it('lets a computed dispatch through when it is exempt-annotated', () => {
    const { src, pkg } = makeFixture(
      {
        'sender.ts':
          `await vscode.commands.executeCommand('intellig.declared');\n` +
          `// dispatch-exempt: the id comes from a registered menu descriptor\n` +
          `await vscode.commands.executeCommand(item.commandId);\n`,
      },
      { contributes: { commands: [{ command: 'intellig.declared' }] } }
    );
    const { status, stderr } = runGuard([src, pkg]);
    assert.strictEqual(status, 0, `annotated dynamic dispatch must pass; stderr:\n${stderr}`);
  });

  // The literal arm exits before the computed arm, so a WRAPPED literal
  // misclassified as computed would still exit 1 with matching stderr — the
  // multiline case above cannot tell the two apart. This pins the positive:
  // a registered wrapped literal must PASS, which is the regression the
  // zero-width lookahead was written to fix.
  it('classifies a wrapped literal as a literal, not as a computed id', () => {
    const { src, pkg } = makeFixture(
      {
        'sender.ts': `await vscode.commands.executeCommand(\n  'intellig.declared',\n  arg\n);\n`,
      },
      { contributes: { commands: [{ command: 'intellig.declared' }] } }
    );
    const { status, stderr } = runGuard([src, pkg]);
    assert.strictEqual(status, 0, `a wrapped registered literal must pass; stderr:\n${stderr}`);
  });

  it('is FAIL-CLOSED: a scan matching zero dispatches fails', () => {
    const { src, pkg } = makeFixture({ 'sender.ts': `const x = 1;\n` });
    const { status, stderr } = runGuard([src, pkg]);
    assert.strictEqual(status, 1, 'a vacuous scan must fail, not report OK');
    assert.ok(/vacuous/.test(stderr), `expected the vacuity arm; got:\n${stderr}`);
  });
});

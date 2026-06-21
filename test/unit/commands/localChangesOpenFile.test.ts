/**
 * Unit tests for the `intellig.localChanges.openFile` command (F4 / Jump
 * to Source).
 *
 * The command was previously a "Coming soon" stub. Both `package.json`
 * (the F4 keybinding) and `CommitToolWindow.ts` (Local-Changes tree →
 * Jump-to-Source) invoke it from real call sites, so the stub is
 * replaced by a real handler.
 *
 * Surfaces tested:
 *   1. Pure helper `resolveLocalChangesOpenFileTarget(arg, currentSelection)`
 *      exported from `extension.ts`. Centralises the rules:
 *        - explicit `vscode.Uri` arg → use that URI directly
 *        - explicit string arg → wrap with `Uri.file(<path>)`
 *        - no arg + non-empty selection → wrap with `Uri.file(<selection>)`
 *        - no arg + no selection → `undefined` (caller surfaces toast)
 *   2. The `package.json` command + keybinding contract: the command is
 *      still declared and the F4 binding still references it.
 */

import '../../../test/setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { resolveLocalChangesOpenFileTarget } from '../../../src/extension';
import { Uri } from '../../mocks/vscode';

describe('resolveLocalChangesOpenFileTarget', () => {
  it('returns the explicit URI when called with a vscode.Uri argument', () => {
    const fileUri = Uri.file('/workspace/repo/src/foo.ts');
    const result = resolveLocalChangesOpenFileTarget(fileUri, undefined);
    assert.ok(result, 'expected a URI result for an explicit Uri arg');
    assert.strictEqual(result.fsPath, fileUri.fsPath);
    assert.strictEqual(result.scheme, 'file');
  });

  it('wraps a string path argument with Uri.file', () => {
    const result = resolveLocalChangesOpenFileTarget('/workspace/repo/src/bar.ts', undefined);
    assert.ok(result, 'expected a URI result for a string path arg');
    assert.strictEqual(result.fsPath, '/workspace/repo/src/bar.ts');
    assert.strictEqual(result.scheme, 'file');
  });

  it('falls back to the supplied current-selection path when no arg is given', () => {
    const result = resolveLocalChangesOpenFileTarget(undefined, '/workspace/repo/src/baz.ts');
    assert.ok(result, 'expected a URI result when selection is non-empty');
    assert.strictEqual(result.fsPath, '/workspace/repo/src/baz.ts');
  });

  it('returns undefined when neither arg nor selection is provided', () => {
    const result = resolveLocalChangesOpenFileTarget(undefined, undefined);
    assert.strictEqual(result, undefined);
  });

  it('returns undefined when the current selection is an empty string', () => {
    const result = resolveLocalChangesOpenFileTarget(undefined, '');
    assert.strictEqual(result, undefined);
  });

  // CommitToolWindow could legitimately forward a stripped-empty
  // `message.path` if upstream tracking changes; the helper must NOT wrap
  // that with `Uri.file('')` (which would crash `vscode.open`). An empty
  // explicit arg downgrades to undefined just like the empty-string
  // `currentSelection` case.
  it('returns undefined when the explicit string arg is empty', () => {
    const result = resolveLocalChangesOpenFileTarget('', '/workspace/repo/src/baz.ts');
    assert.strictEqual(
      result,
      undefined,
      'empty string arg must NOT fall through to currentSelection — it is an explicit "no target"'
    );
  });
});

// ─── package.json contract ────────────────────────────────────────────────────

describe('package.json contract for intellig.localChanges.openFile', () => {
  interface PackageJson {
    contributes?: {
      commands?: Array<{ command: string; title?: string }>;
      keybindings?: Array<{ command: string; key: string; mac?: string; when?: string }>;
    };
  }

  function loadPackageJson(): PackageJson {
    const pkgPath = path.resolve(__dirname, '../../../package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageJson;
  }

  it('still declares the intellig.localChanges.openFile command', () => {
    const pkg = loadPackageJson();
    const cmd = pkg.contributes?.commands?.find(
      (c) => c.command === 'intellig.localChanges.openFile'
    );
    assert.ok(cmd, 'expected intellig.localChanges.openFile to remain registered');
  });

  it('still binds F4 → intellig.localChanges.openFile', () => {
    const pkg = loadPackageJson();
    const kb = pkg.contributes?.keybindings?.find(
      (k) => k.command === 'intellig.localChanges.openFile' && k.key === 'f4'
    );
    assert.ok(kb, 'expected F4 keybinding to remain wired to localChanges.openFile');
  });
});

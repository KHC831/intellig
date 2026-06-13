/**
 * Unit tests for — Explorer / editor menu parity.
 *
 * Two test surfaces:
 *
 *   1. **Pure helpers** exported from `extension.ts`:
 *        - `resolveExplorerFileUri`
 *        - `buildCompareWithRepoVersionLeftUri`
 *        - `buildCompareWithRepoVersionTitle`
 *      These are the bits of command-handler logic the spec requires
 *      verifying (URI scheme, title format, fallback-to-active-editor rule),
 *      extracted into side-effect-free functions for direct unit testing.
 *
 *   2. **`package.json` contract**: the new explorer/editor submenu entries
 *      exist in the expected groups and reference registered commands.
 *      This guards against regressions where a refactor accidentally drops
 *      a menu contribution or a command declaration.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildCompareWithRepoVersionLeftUri,
  buildCompareWithRepoVersionTitle,
  resolveExplorerFileUri,
} from '../../../extension';
import { Uri } from '../../mocks/vscode';

// ─── resolveExplorerFileUri ──────────────────────────────────────────────────

describe('resolveExplorerFileUri', () => {
  it('returns the explicit fileUri when provided', () => {
    const fileUri = Uri.file('/workspace/a/src/foo.ts');
    const activeUri = Uri.file('/workspace/a/src/bar.ts');
    const result = resolveExplorerFileUri(fileUri, activeUri);
    assert.strictEqual(result, fileUri);
  });

  it('falls back to the active editor URI when no fileUri is provided', () => {
    const activeUri = Uri.file('/workspace/a/src/bar.ts');
    const result = resolveExplorerFileUri(undefined, activeUri);
    assert.strictEqual(result, activeUri);
  });

  it('returns undefined when neither source yields a URI', () => {
    const result = resolveExplorerFileUri(undefined, undefined);
    assert.strictEqual(result, undefined);
  });

  it('returns undefined when the active editor is not a file (e.g. untitled, output)', () => {
    // Our mock Uri always uses `file` scheme, so we hand-build one with a
    // different scheme to simulate a non-file editor.
    const nonFileUri = Object.assign(Object.create(Uri.prototype) as object, {
      scheme: 'untitled',
      authority: '',
      path: '/scratch',
      query: '',
      fragment: '',
      fsPath: '/scratch',
    }) as Uri;
    const result = resolveExplorerFileUri(undefined, nonFileUri);
    assert.strictEqual(result, undefined);
  });
});

// ─── buildCompareWithRepoVersionLeftUri ──────────────────────────────────────

describe('buildCompareWithRepoVersionLeftUri', () => {
  it('constructs an `intellig-git:` URI with the file path and encoded ref', () => {
    const uri = buildCompareWithRepoVersionLeftUri('src/foo.ts');
    const str = uri.toString();
    assert.ok(str.includes('intellig-git:'), `expected intellig-git scheme, got: "${str}"`);
    assert.ok(str.includes('src/foo.ts'), `expected path, got: "${str}"`);
    assert.ok(str.includes('HEAD'), `expected HEAD ref, got: "${str}"`);
  });

  it('URL-encodes refs that contain `/` (e.g. remote-qualified branches)', () => {
    const uri = buildCompareWithRepoVersionLeftUri('src/foo.ts', 'origin/main');
    const str = uri.toString();
    assert.ok(
      str.includes('origin%2Fmain'),
      `remote-qualified ref should be URL-encoded, got: "${str}"`
    );
  });

  it('defaults the ref to HEAD when not supplied', () => {
    const uri = buildCompareWithRepoVersionLeftUri('a.ts');
    assert.ok(uri.toString().includes('HEAD'));
  });
});

// ─── buildCompareWithRepoVersionTitle ────────────────────────────────────────

describe('buildCompareWithRepoVersionTitle', () => {
  it('formats the title as `<basename> (HEAD ↔ Working Tree)`', () => {
    assert.strictEqual(
      buildCompareWithRepoVersionTitle('src/foo.ts'),
      'foo.ts (HEAD ↔ Working Tree)'
    );
  });

  it('uses the basename only, not the full path', () => {
    const title = buildCompareWithRepoVersionTitle('nested/deeply/src/bar.ts');
    assert.ok(title.startsWith('bar.ts'), `title should start with basename, got: "${title}"`);
    assert.ok(!title.includes('nested/'), `title must not leak the path, got: "${title}"`);
  });

  it('includes the supplied ref when non-default', () => {
    assert.strictEqual(
      buildCompareWithRepoVersionTitle('a.ts', 'origin/main'),
      'a.ts (origin/main ↔ Working Tree)'
    );
  });
});

// ─── package.json contract ──────────────────────────────────────────────────

describe('package.json menu contract', () => {
  interface MenuEntry {
    command?: string;
    submenu?: string;
    group?: string;
    when?: string;
  }
  interface CommandEntry {
    command: string;
    title: string;
    category?: string;
  }

  const packageJsonPath = path.resolve(__dirname, '..', '..', '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    contributes: {
      commands: CommandEntry[];
      menus: Record<string, MenuEntry[]>;
    };
  };

  function hasCommand(id: string): CommandEntry | undefined {
    return pkg.contributes.commands.find((c) => c.command === id);
  }
  function inSubmenu(submenuId: string, command: string): MenuEntry | undefined {
    const entries = pkg.contributes.menus[submenuId] ?? [];
    return entries.find((e) => e.command === command);
  }

  // ── New commands declared ───────────────────────────────────────────────

  it('declares the three new commands', () => {
    for (const id of [
      'intellig.explorer.addToVcs',
      'intellig.explorer.compareWithRepoVersion',
      'intellig.explorer.createPatchFromFile',
    ]) {
      assert.ok(hasCommand(id), `command ${id} should be declared in package.json`);
    }
  });

  it('uses Unicode `…` in titles that open a prompt', () => {
    const createPatch = hasCommand('intellig.explorer.createPatchFromFile');
    assert.ok(createPatch);
    assert.ok(
      createPatch.title.endsWith('…'),
      `Create Patch from File… should use Unicode ellipsis, got: "${createPatch.title}"`
    );
    const compareWithBranch = hasCommand('intellig.explorer.compareWithBranch');
    assert.ok(compareWithBranch);
    assert.ok(
      compareWithBranch.title.endsWith('…'),
      `Compare with Revision… should use Unicode ellipsis, got: "${compareWithBranch.title}"`
    );
  });

  it('Add to VCS title matches IntelliJ wording', () => {
    assert.strictEqual(hasCommand('intellig.explorer.addToVcs')?.title, 'Add to VCS');
  });

  it('Compare with the Same Repository Version title matches IntelliJ wording', () => {
    assert.strictEqual(
      hasCommand('intellig.explorer.compareWithRepoVersion')?.title,
      'Compare with the Same Repository Version'
    );
  });

  // ── Explorer submenu placement ──────────────────────────────────────────

  it('places explorer submenu entries in the expected IntelliJ-parity groups', () => {
    const cases: Array<{ command: string; group: string }> = [
      { command: 'intellig.explorer.showHistory', group: '1_navigate@1' },
      { command: 'intellig.explorer.addToVcs', group: '2_add@1' },
      { command: 'intellig.explorer.stage', group: '2_add@2' },
      { command: 'intellig.explorer.unstage', group: '2_add@3' },
      { command: 'intellig.explorer.revert', group: '3_modify@1' },
      { command: 'intellig.explorer.showDiff', group: '4_compare@1' },
      { command: 'intellig.explorer.compareWithBranch', group: '4_compare@2' },
      { command: 'intellig.explorer.compareWithRepoVersion', group: '4_compare@3' },
      { command: 'intellig.toggleBlame', group: '5_blame@1' },
      { command: 'intellig.explorer.createPatchFromFile', group: '6_patch@1' },
      { command: 'intellig.patch.apply', group: '6_patch@2' },
    ];
    for (const { command, group } of cases) {
      const entry = inSubmenu('intellig.explorerSubmenu', command);
      assert.ok(entry, `expected ${command} in intellig.explorerSubmenu`);
      assert.strictEqual(
        entry.group,
        group,
        `${command} should live in group ${group}, got ${entry.group ?? '<none>'}`
      );
    }
  });

  // ── Editor submenu placement ────────────────────────────────────────────

  it('adds Rollback / Show History / Apply Patch to the editor submenu', () => {
    const cases: Array<{ command: string; group: string }> = [
      { command: 'intellig.editor.toggleBlame', group: '1_blame@1' },
      { command: 'intellig.editor.showLineHistory', group: '2_history@1' },
      { command: 'intellig.showHistory', group: '2_history@2' },
      { command: 'intellig.revertFile', group: '4_modify@1' },
      { command: 'intellig.patch.apply', group: '6_patch@1' },
    ];
    for (const { command, group } of cases) {
      const entry = inSubmenu('intellig.editorSubmenu', command);
      assert.ok(entry, `expected ${command} in intellig.editorSubmenu`);
      assert.strictEqual(
        entry.group,
        group,
        `${command} should live in group ${group}, got ${entry.group ?? '<none>'}`
      );
    }
  });

  // ── Menu entries only reference declared commands ───────────────────────

  it('every explorer/editor submenu entry references a declared command', () => {
    for (const submenuId of ['intellig.explorerSubmenu', 'intellig.editorSubmenu']) {
      const entries = pkg.contributes.menus[submenuId] ?? [];
      for (const entry of entries) {
        if (entry.command) {
          assert.ok(
            hasCommand(entry.command),
            `submenu ${submenuId} references undeclared command ${entry.command}`
          );
        }
      }
    }
  });
});

/**
 * Phase 0c — KeymapService ↔ package.json coherence guard.
 *
 * `package.json`'s `contributes.keybindings` is the SOURCE OF TRUTH for what
 * the extension actually binds. `KeymapService`'s hardcoded
 * `INTELLIJ_KEYBINDINGS` is a display / reference mirror used by the keymap
 * command surface. Historically the two drifted — the IntelliJ list silently
 * omitted `showShelfList`, `localChanges.openFile`, and `changelist.moveFilesTo`
 * (all present and IntelliJ-gated in package.json), so the reference list
 * under-reported the active preset.
 *
 * This guard pins the relationship in both directions for the IntelliJ
 * preset:
 *
 *   1. Every binding in package.json gated by
 *      `config.intellig.keymapPreset == 'intellij'` MUST appear in
 *      `getIntelliJKeymap()` with a matching `key` (and `mac`, when the
 *      package.json entry declares one).
 *   2. No IntelliJ-gated package.json command may be missing from the
 *      reference list.
 *
 * A future agent that adds an IntelliJ-preset keybinding to package.json (or
 * changes a key) without updating `KeymapService` fails here, in the same
 * unit suite as everything else, rather than shipping a stale reference list.
 *
 * One binding is deliberately outside the gated set: `toolWindow.jumpToHash`
 * is scoped by focus and active tab rather than by preset, so it binds under
 * either keymap. Everything else in `contributes.keybindings` carries the
 * preset gate and is asserted here.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { getIntelliJKeymap } from '../../../src/ui-shell/KeymapService';
import { IKeybinding } from '../../../src/ui-shell/interfaces/IKeymapService';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, 'package.json');

const INTELLIJ_GATE = "keymapPreset == 'intellij'";

interface PackageKeybinding {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

interface PackageJson {
  contributes: {
    keybindings?: PackageKeybinding[];
  };
}

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as PackageJson;
}

function intellijGatedBindings(pj: PackageJson): PackageKeybinding[] {
  return (pj.contributes.keybindings ?? []).filter((kb) => (kb.when ?? '').includes(INTELLIJ_GATE));
}

describe('Phase 0c — KeymapService IntelliJ preset ↔ package.json coherence', () => {
  it('every IntelliJ-gated package.json binding is mirrored in getIntelliJKeymap() with a matching key/mac', () => {
    const pj = readPackageJson();
    const gated = intellijGatedBindings(pj);

    // Sanity: the gate must actually match something, otherwise a renamed
    // gate string would make this guard vacuously pass.
    assert.ok(
      gated.length > 0,
      `No package.json keybindings matched the IntelliJ gate "${INTELLIJ_GATE}" — ` +
        `the gating convention may have changed; update this guard.`
    );

    const reference: IKeybinding[] = getIntelliJKeymap().keybindings;
    const byCommand = new Map<string, IKeybinding>();
    for (const kb of reference) {
      byCommand.set(kb.command, kb);
    }

    const mismatches: string[] = [];
    for (const pkg of gated) {
      const ref = byCommand.get(pkg.command);
      if (!ref) {
        mismatches.push(`${pkg.command}: missing from getIntelliJKeymap() (key ${pkg.key})`);
        continue;
      }
      if (ref.key !== pkg.key) {
        mismatches.push(`${pkg.command}: key "${ref.key}" ≠ package.json "${pkg.key}"`);
      }
      // Only assert mac when package.json declares one; a binding without a
      // mac override inherits `key` on macOS, and the reference list may
      // legitimately omit it.
      if (pkg.mac !== undefined && ref.mac !== pkg.mac) {
        mismatches.push(`${pkg.command}: mac "${ref.mac ?? '-'}" ≠ package.json "${pkg.mac}"`);
      }
    }

    assert.deepStrictEqual(
      mismatches,
      [],
      `KeymapService IntelliJ preset drifted from package.json:\n  ${mismatches.join('\n  ')}`
    );
  });

  it('every IntelliJ-gated package.json command is present in the reference list', () => {
    const pj = readPackageJson();
    const gatedCommands = new Set(intellijGatedBindings(pj).map((kb) => kb.command));
    const referenceCommands = new Set(getIntelliJKeymap().keybindings.map((kb) => kb.command));

    const missing = [...gatedCommands].filter((cmd) => !referenceCommands.has(cmd));
    assert.deepStrictEqual(
      missing,
      [],
      `IntelliJ-gated command(s) absent from getIntelliJKeymap():\n  ${missing.join('\n  ')}`
    );
  });
});

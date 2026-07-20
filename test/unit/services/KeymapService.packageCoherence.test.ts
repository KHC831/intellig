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
  linux?: string;
  win?: string;
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

/**
 * Drop the preset gate and the `useCommitToolWindow` conjunct: the gate is
 * package.json's mechanism for selecting the preset (the reference list IS the
 * IntelliJ preset, so it never restates it), and the tool-window conjunct
 * routes between two implementations of one gesture.
 */
function stripGate(when: string | undefined): string {
  return (when ?? '')
    .split('&&')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => !part.includes('keymapPreset'))
    .filter((part) => !part.includes('useCommitToolWindow'))
    .join(' && ');
}

function normalizeWhen(when: string | undefined): string {
  return stripGate(when)
    .split('&&')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .sort()
    .join(' && ');
}

function intellijGatedBindings(pj: PackageJson): PackageKeybinding[] {
  return (pj.contributes.keybindings ?? []).filter((kb) => (kb.when ?? '').includes(INTELLIJ_GATE));
}

/**
 * Commands the mirror deliberately does not carry. Everything else in
 * contributes.keybindings must be mirrored, INCLUDING bindings scoped by focus
 * rather than by the preset gate — filtering on the gate alone made those
 * structurally invisible, which is how jumpToHash kept a missing when-clause
 * through a guard that reported coherent.
 */
const MIRROR_EXEMPT: ReadonlySet<string> = new Set<string>();

function allPackageBindings(pj: PackageJson): PackageKeybinding[] {
  return (pj.contributes.keybindings ?? []).filter((kb) => !MIRROR_EXEMPT.has(kb.command));
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
      // A binding with no `mac` override inherits `key` on macOS, so the
      // mirror must either omit mac too or repeat `key`. Skipping the check
      // entirely would let the mirror advertise any macOS chord it liked.
      const effectiveMac = pkg.mac ?? pkg.key;
      if ((ref.mac ?? ref.key) !== effectiveMac) {
        mismatches.push(
          `${pkg.command}: mac "${ref.mac ?? '-'}" ≠ package.json effective "${effectiveMac}"`
        );
      }
    }

    assert.deepStrictEqual(
      mismatches,
      [],
      `KeymapService IntelliJ preset drifted from package.json:\n  ${mismatches.join('\n  ')}`
    );
  });

  it('the reference when-clause matches package.json, modulo the preset gate', () => {
    // `when` decides WHERE a binding fires. A mirror that reports
    // `editorTextFocus` for a binding package.json actually scopes with
    // `!inDebugMode && !terminalFocus` misdescribes the preset to the user,
    // which is the shape showShelfList drifted into.
    const pj = readPackageJson();
    const gated = intellijGatedBindings(pj);
    const byCommand = new Map(getIntelliJKeymap().keybindings.map((kb) => [kb.command, kb]));

    const mismatches: string[] = [];
    for (const pkg of gated) {
      const ref = byCommand.get(pkg.command);
      if (!ref) {
        continue; // covered by the presence assertions above
      }
      if (normalizeWhen(pkg.when) !== normalizeWhen(ref.when)) {
        mismatches.push(
          `${pkg.command}: when "${ref.when ?? '-'}" ≠ package.json "${stripGate(pkg.when)}"`
        );
      }
    }

    assert.deepStrictEqual(
      mismatches,
      [],
      `KeymapService when-clauses drifted from package.json:\n  ${mismatches.join('\n  ')}`
    );
  });

  it('mirrors the when-clause of EVERY binding, gated or focus-scoped', () => {
    const pj = readPackageJson();
    const byCommand = new Map(getIntelliJKeymap().keybindings.map((kb) => [kb.command, kb]));

    const mismatches: string[] = [];
    for (const pkg of allPackageBindings(pj)) {
      const ref = byCommand.get(pkg.command);
      if (!ref) {
        mismatches.push(`${pkg.command}: absent from getIntelliJKeymap()`);
        continue;
      }
      if (normalizeWhen(pkg.when) !== normalizeWhen(ref.when)) {
        mismatches.push(
          `${pkg.command}: when "${ref.when ?? '-'}" ≠ package.json "${stripGate(pkg.when)}"`
        );
      }
    }

    assert.deepStrictEqual(
      mismatches,
      [],
      `Mirror drifted from package.json:\n  ${mismatches.join('\n  ')}`
    );
  });

  it('no binding uses a linux/win-specific key the mirror cannot express', () => {
    // IKeybinding carries only `key` + `mac`. Nothing uses `linux`/`win` today;
    // if that changes, the mirror would silently drop the platform override,
    // so fail here rather than let the blind spot open unnoticed.
    const platformSpecific = (readPackageJson().contributes.keybindings ?? []).filter(
      (kb) => 'linux' in kb || 'win' in kb
    );

    assert.deepStrictEqual(
      platformSpecific.map((kb) => kb.command),
      [],
      'IKeybinding must gain linux/win fields before package.json uses them'
    );
  });

  it('duplicate command entries in package.json are not silently collapsed', () => {
    // Both sides index by command, so a second entry for one command would
    // overwrite the first and go uncompared.
    const commands = (readPackageJson().contributes.keybindings ?? []).map((kb) => kb.command);
    const seen = new Set<string>();
    const duplicates = commands.filter((c) => (seen.has(c) ? true : (seen.add(c), false)));

    assert.deepStrictEqual(
      [...new Set(duplicates)],
      [],
      'a duplicated command id would hide one of its bindings from this guard'
    );
  });

  it('the reference list declares no binding package.json does not bind', () => {
    // The reverse direction: an entry that exists only in the mirror is a
    // gesture the keymap surface advertises and the product never honours.
    const pj = readPackageJson();
    const packageCommands = new Set((pj.contributes.keybindings ?? []).map((kb) => kb.command));
    const extra = getIntelliJKeymap()
      .keybindings.map((kb) => kb.command)
      .filter((cmd) => !packageCommands.has(cmd));

    assert.deepStrictEqual(
      extra,
      [],
      `Reference list advertises unbound command(s):\n  ${extra.join('\n  ')}`
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

/**
 * C-1 / regression coverage — package.json / extension.ts coherence.
 *
 * These tests run as pure unit tests (no VS Code host) against the shipped
 * package.json and the TS extension source, so a duplicate command
 * registration or a dead `focusedView` gate is caught in the same suite as
 * everything else rather than surfacing as an activation crash in the hosted
 * smoke run.
 *
 *  - C-1: Every command id declared in `contributes.commands` must be
 *         registered EXACTLY ONCE in production sources. Two registrations
 *         for the same id cause VS Code to throw on activation.
 *  - Every `focusedView == 'intellig.<id>'` appearing in a keybinding's
 *         `when` clause must correspond to a view id actually declared in
 *         `contributes.views.<container>[*].id`.
 *
 * The C-1 test walks command-registration call sites textually rather than
 * loading `activate()` under a VS Code shim. It recognizes both the
 * `registerLoggedCommand(<id>, …)` structured-logging wrapper (the dominant
 * form after the.1 adoption sweep) and the direct
 * `(vscode.|)commands.registerCommand(<id>, …)` API. The same traversal
 * catches both the original bug (two literal registrations) and a future
 * dynamically-computed string id if one ever appears (the filter uses a
 * string-literal regex).
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, 'package.json');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');

interface PackageJson {
  contributes: {
    commands: Array<{ command: string }>;
    keybindings?: Array<{ command: string; when?: string }>;
    views: Record<string, Array<{ id: string; type?: string }>>;
  };
}

function readPackageJson(): PackageJson {
  const raw = fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8');
  return JSON.parse(raw) as PackageJson;
}

/**
 * Walk `src/**\/*.ts` (skipping the test tree) and return the concatenated
 * source. Command registrations live in `extension.ts` AND in dedicated
 * command classes (BranchContextMenuCommands, CommitContextMenuCommands,
 * ExplorerEditorMenu, …), so the duplicate-registration audit has to cover
 * all of them — not just extension.ts.
 */
function readAllProductionSources(): string {
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'test' || entry.name === '__mocks__') {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        sources.push(fs.readFileSync(full, 'utf-8'));
      }
    }
  };
  walk(SRC_DIR);
  return sources.join('\n');
}

describe('R5 C-1 — activation cannot register the same command id twice', () => {
  it('every contributed command id is registered exactly once across production sources', () => {
    const pj = readPackageJson();
    const allSrc = readAllProductionSources();

    // Collect every string-literal argument passed to a command
    // registration call. Two registration mechanisms exist in production:
    //   - `registerLoggedCommand(<id>, …)` — the structured-logging wrapper
    // (src/utils/logger) adopted across the codebase in the.1 sweep;
    //     this is now the dominant form (extension.ts, the context-menu
    //     command classes, …).
    //   - `(vscode.|)commands.registerCommand(<id>, …)` — the direct VS Code
    //     API, still used in a few call sites (e.g. StatusBarService).
    // Both forms ultimately register a command id with VS Code, so a
    // duplicate across EITHER form would crash activation and must be caught.
    // Matches both single and double-quoted literals. Intentionally does NOT
    // match template-literal ids; the convention in the codebase is literal
    // ids. The wrapper's own internal `commands.registerCommand(id, …)` (in
    // logger/correlation.ts) passes the `id` variable — not a literal — so it
    // is never miscounted here.
    const registerCallRegex =
      /(?:commands\.registerCommand|registerLoggedCommand)\(\s*['"]([^'"]+)['"]/g;

    const counts = new Map<string, number>();
    let match: RegExpExecArray | null;
    while ((match = registerCallRegex.exec(allSrc)) !== null) {
      const id = match[1];
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    // Every id that appears at all must appear exactly once. Duplicates crash
    // activation (VS Code throws). The original C-1 bug registered
    // `intellig.toolWindow.jumpToHash` twice.
    const duplicates: Array<[string, number]> = [];
    for (const [id, count] of counts) {
      if (count !== 1) {
        duplicates.push([id, count]);
      }
    }
    assert.deepStrictEqual(
      duplicates,
      [],
      `Duplicate registerCommand call(s) found (would crash activation):\n  ${duplicates
        .map(([id, n]) => `${id} registered ${n}×`)
        .join('\n  ')}`
    );

    // Sanity: every declared command should actually be registered. (If a
    // declared command is registered zero times the palette entry is dead.)
    const declared = new Set(pj.contributes.commands.map((c) => c.command));
    const unregistered: string[] = [];
    for (const id of declared) {
      if (!counts.has(id)) {
        unregistered.push(id);
      }
    }
    assert.deepStrictEqual(
      unregistered,
      [],
      `Declared command(s) never registered in production sources:\n  ${unregistered.join('\n  ')}`
    );
  });
});

describe('keybinding focusedView gates must reference real view ids', () => {
  it("every focusedView == 'intellig.<id>' resolves to a registered view id", () => {
    const pj = readPackageJson();

    const registeredViewIds = new Set<string>();
    for (const container of Object.values(pj.contributes.views)) {
      for (const view of container) {
        registeredViewIds.add(view.id);
      }
    }

    const focusedViewRegex = /focusedView\s*==\s*'(intellig\.[A-Za-z0-9_.]+)'/g;
    const badReferences: Array<{ command: string; viewId: string; when: string }> = [];

    for (const kb of pj.contributes.keybindings ?? []) {
      if (!kb.when) {
        continue;
      }
      focusedViewRegex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = focusedViewRegex.exec(kb.when)) !== null) {
        const viewId = m[1];
        if (!registeredViewIds.has(viewId)) {
          badReferences.push({ command: kb.command, viewId, when: kb.when });
        }
      }
    }

    assert.deepStrictEqual(
      badReferences,
      [],
      `Keybinding(s) reference a view id that is not registered:\n  ${badReferences
        .map((b) => `${b.command} → ${b.viewId}  (when: ${b.when})`)
        .join('\n  ')}`
    );
  });
});

/**
 * Bonus — every `contributes.keybindings[*].command` that targets an
 * `intellig.*` id must ALSO be present in `contributes.commands`. Otherwise
 * the key combo fires but the command never surfaces in the palette (title
 * missing → palette hides it), which is silent half-functionality.
 *
 * Real-world shape that motivated this test: `intellig.showShelfList` was
 * `registerCommand`-ed in `extension.ts` AND keybound in `package.json`, but
 * had no palette entry. It stayed latent until the package.json-coherence
 * audit surfaced it.
 */
describe('R5 — every intellig.* keybinding command has a contributes.commands entry', () => {
  it('no keybinding references an intellig.* command that is missing from contributes.commands', () => {
    const pj = readPackageJson();

    const declared = new Set(pj.contributes.commands.map((c) => c.command));
    const missing: Array<{ command: string; key: string }> = [];

    for (const kb of pj.contributes.keybindings ?? []) {
      if (!kb.command.startsWith('intellig.')) {
        continue;
      }
      if (!declared.has(kb.command)) {
        missing.push({ command: kb.command, key: (kb as { key?: string }).key ?? '?' });
      }
    }

    assert.deepStrictEqual(
      missing,
      [],
      `Keybinding(s) reference an intellig.* command with no contributes.commands entry ` +
        `(the shortcut fires but the command is hidden from the palette):\n  ${missing
          .map((m) => `${m.command} (${m.key})`)
          .join('\n  ')}`
    );
  });
});

/**
 * Unit tests that enforce `package.json` coherence for the IntelliG
 * VS Code extension.
 *
 * These are pure static checks — no VS Code host required. They catch
 * the class of bugs that slipped through review:
 *
 *   - keybinding `when` clause referenced a non-existent view id
 *          (`focusedView == 'intellig.gitToolWindow'`, whose real id is
 *          `intellig.toolWindow`).
 *   - C-1: duplicate `contributes.commands[].command` entries shadowing
 *          each other silently.
 *
 * The invariants below are minimal but load-bearing: any regression that
 * re-introduces an / C-1 class bug will surface immediately at PR
 * time rather than at first keystroke in the Extension Host.
 *
 * Design notes:
 *   - Each `it(...)` collects ALL violations into an array and asserts
 *     `violations.length === 0` with a multi-line message. A single run
 *     therefore surfaces every violation at once, not just the first.
 *   - Resolved via `process.cwd()` (repo root) — ts-node under
 *     `mocha --require ts-node/register` runs the tests from the repo
 *     root per `package.json` `test:unit` script, matching the
 *     convention established by `src/test/unit/keymap.test.ts`.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Loose shapes — we parse `package.json` defensively because the schema
// evolves and we want the test to keep working even when new contrib points
// are added. Unknown keys flow through untouched.
// ---------------------------------------------------------------------------

interface PackageJson {
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{ command: string; title?: string; category?: string }>;
    keybindings?: Array<{ command: string; key: string; mac?: string; when?: string }>;
    views?: Record<string, Array<{ id: string; name?: string }>>;
    menus?: Record<
      string,
      Array<{ command?: string; submenu?: string; when?: string; group?: string }>
    >;
    submenus?: Array<{ id: string; label?: string }>;
  };
}

function loadPackageJson(): PackageJson {
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf-8');
  return JSON.parse(raw) as PackageJson;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract every `focusedView == '<id>'` (or double-quoted) reference from
 * a `when` clause. Returns the raw id strings, possibly duplicated if the
 * clause mentions the same view twice.
 */
function extractFocusedViewRefs(whenClause: string): string[] {
  const out: string[] = [];
  // Match both single- and double-quoted forms; be permissive about
  // surrounding whitespace around `==`.
  const re = /focusedView\s*==\s*(?:'([^']+)'|"([^"]+)")/g;
  for (const m of whenClause.matchAll(re)) {
    out.push(m[1] ?? m[2]);
  }
  return out;
}

/**
 * Render a list of violations as a multi-line error message with a
 * leading count and bullet points, so the failure is legible in test
 * output without truncation.
 */
function describeViolations(label: string, violations: string[]): string {
  return [`${violations.length} ${label} violation(s):`, ...violations.map((v) => `  - ${v}`)].join(
    '\n'
  );
}

/**
 * Collect every distinct `viewItem == <literal>` contextValue referenced by
 * any `when` clause across all `contributes.menus.*`. Permissive about
 * whitespace around `==`; the literal is the bare identifier (no quotes —
 * VS Code `viewItem` comparisons are unquoted).
 */
function collectViewItemLiterals(pkg: PackageJson): Set<string> {
  const out = new Set<string>();
  const re = /viewItem\s*==\s*([A-Za-z0-9._-]+)/g;
  const menus = pkg.contributes?.menus ?? {};
  for (const entries of Object.values(menus)) {
    for (const entry of entries) {
      if (typeof entry.when !== 'string') {
        continue;
      }
      for (const m of entry.when.matchAll(re)) {
        out.add(m[1]);
      }
    }
  }
  return out;
}

/**
 * Concatenate the text of every production `.ts` file under `src/` (the
 * `src/test/` tree is excluded — tests must not satisfy a coherence check).
 */
function readAllSourceText(): string {
  const srcRoot = path.resolve(process.cwd(), 'src');
  const chunks: string[] = [];
  const walk = (dir: string): void => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (full === path.join(srcRoot, 'test')) {
          continue;
        }
        walk(full);
      } else if (dirent.isFile() && full.endsWith('.ts')) {
        chunks.push(fs.readFileSync(full, 'utf-8'));
      }
    }
  };
  walk(srcRoot);
  return chunks.join('\n');
}

/**
 * A contextValue literal is "produced" if it appears verbatim in source, or
 * if a dotted prefix of it appears (covering values built by string template,
 * e.g. `intellig.scm.${kind}.${code}` whose static prefix `intellig.scm.`
 * appears verbatim). Prefixes must retain at least one dot so the bare
 * `intellig.` namespace can never satisfy an arbitrary literal.
 */
function sourceProducesContextValue(sourceText: string, literal: string): boolean {
  if (sourceText.includes(literal)) {
    return true;
  }
  const segments = literal.split('.');
  // Drop the last segment progressively; require the remaining prefix to keep
  // at least one dot (>= 2 segments) so it is more specific than `intellig.`.
  for (let end = segments.length - 1; end >= 2; end--) {
    const prefix = segments.slice(0, end).join('.') + '.';
    if (sourceText.includes(prefix)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('package.json coherence', () => {
  let pkg: PackageJson;
  let declaredViews: Set<string>;
  let declaredCommands: Set<string>;

  before(() => {
    pkg = loadPackageJson();

    declaredViews = new Set<string>();
    const viewsContributes = pkg.contributes?.views ?? {};
    for (const container of Object.values(viewsContributes)) {
      for (const v of container) {
        if (v.id) {
          declaredViews.add(v.id);
        }
      }
    }

    declaredCommands = new Set<string>(
      (pkg.contributes?.commands ?? []).map((c) => c.command).filter((x): x is string => Boolean(x))
    );
  });

  // -------------------------------------------------------------------------
  // Invariant 1: every `focusedView == '<id>'` resolves to a declared view.
  //
  // This is the direct regression guard for -senior: a keybinding
  // targeted `focusedView == 'intellig.gitToolWindow'`, but the real
  // declared view id is `intellig.toolWindow`. The typo silently made the
  // `when` clause false forever, so the keybinding was dead weight.
  // -------------------------------------------------------------------------
  it('every keybinding focusedView reference resolves to a declared view id', () => {
    const kbs = pkg.contributes?.keybindings ?? [];
    const violations: string[] = [];

    for (const kb of kbs) {
      if (!kb.when) {
        continue;
      }
      const refs = extractFocusedViewRefs(kb.when);
      for (const viewId of refs) {
        if (!declaredViews.has(viewId)) {
          violations.push(
            `keybinding "${kb.command}" (${kb.key}) references non-existent view '${viewId}'; ` +
              `declared views are: ${Array.from(declaredViews).sort().join(', ')}`
          );
        }
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      '\n' + describeViolations('dangling-focusedView', violations)
    );
  });

  // -------------------------------------------------------------------------
  // Invariant 2: every menu-entry command is declared in contributes.commands.
  //
  // Prevents ghost menu items that throw "command 'foo' not found" the
  // moment a user right-clicks. Covers every menu section because new
  // menu points get added all the time.
  // -------------------------------------------------------------------------
  it('every menu-entry command is declared in contributes.commands', () => {
    const menus = pkg.contributes?.menus ?? {};
    const violations: string[] = [];

    for (const [section, entries] of Object.entries(menus)) {
      for (const entry of entries ?? []) {
        // Skip submenu entries — they reference a submenu id, not a command.
        if (!entry.command) {
          continue;
        }
        if (!declaredCommands.has(entry.command)) {
          violations.push(
            `menu section '${section}' references undeclared command '${entry.command}'` +
              (entry.when ? ` (when: ${entry.when})` : '') +
              (entry.group ? ` (group: ${entry.group})` : '')
          );
        }
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      '\n' + describeViolations('undeclared-menu-command', violations)
    );
  });

  // -------------------------------------------------------------------------
  // Invariant 3: no duplicate command ids in contributes.commands.
  //
  // Direct regression guard for -senior C-1: the same command id was
  // listed twice in `contributes.commands`. VS Code silently uses the
  // last one, so whichever title/category came first was shadowed with
  // no warning at package time.
  // -------------------------------------------------------------------------
  it('no duplicate command ids in contributes.commands', () => {
    const cmds = pkg.contributes?.commands ?? [];
    const counts = new Map<string, number>();
    for (const c of cmds) {
      counts.set(c.command, (counts.get(c.command) ?? 0) + 1);
    }

    const violations: string[] = [];
    for (const [id, count] of counts.entries()) {
      if (count > 1) {
        violations.push(`duplicate command '${id}' appears ${count} times in contributes.commands`);
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      '\n' + describeViolations('duplicate-command', violations)
    );
  });

  // -------------------------------------------------------------------------
  // Invariant 4: every palette command has a non-empty title.
  //
  // A command without a title renders as a blank line in the command
  // palette, which is jarring and effectively hides the command.
  // -------------------------------------------------------------------------
  it('every contributes.commands entry has a non-empty title', () => {
    const cmds = pkg.contributes?.commands ?? [];
    const violations: string[] = [];

    for (const c of cmds) {
      if (!c.title || c.title.trim().length === 0) {
        violations.push(`command '${c.command}' has no title (or whitespace-only title)`);
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      '\n' + describeViolations('missing-title', violations)
    );
  });

  // -------------------------------------------------------------------------
  // Invariant 5: every keybinding command resolves to a declared command.
  //
  // A keybinding targeting an undeclared command will fire "command not
  // found" at runtime. Catch it statically.
  // -------------------------------------------------------------------------
  it('every keybinding command is declared in contributes.commands', () => {
    const kbs = pkg.contributes?.keybindings ?? [];
    const violations: string[] = [];

    for (const kb of kbs) {
      if (!kb.command) {
        continue;
      }
      if (!declaredCommands.has(kb.command)) {
        violations.push(
          `keybinding (${kb.key}) targets undeclared command '${kb.command}'` +
            (kb.when ? ` (when: ${kb.when})` : '')
        );
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      '\n' + describeViolations('undeclared-keybinding-command', violations)
    );
  });

  // -------------------------------------------------------------------------
  // Invariant 6: every onCommand activation event's command exists.
  //
  // Activating on a command id that was never declared is a noop (the
  // event will never fire), which usually means the extension silently
  // fails to activate on that code path.
  // -------------------------------------------------------------------------
  it('every onCommand activation event targets a declared command', () => {
    const events = pkg.activationEvents ?? [];
    const violations: string[] = [];

    for (const ev of events) {
      if (!ev.startsWith('onCommand:')) {
        continue;
      }
      const cmd = ev.substring('onCommand:'.length);
      if (!declaredCommands.has(cmd)) {
        violations.push(`activation event '${ev}' targets undeclared command '${cmd}'`);
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      '\n' + describeViolations('undeclared-activation-command', violations)
    );
  });

  // -------------------------------------------------------------------------
  // Invariant 7 (stretch): no ASCII "..." in any command title.
  //
  // Revives the -HIGH SR-2 fix: Unicode horizontal ellipsis (…) is the
  // VS Code convention for commands that prompt for input; three ASCII
  // dots are a regression.
  // -------------------------------------------------------------------------
  it('no ASCII "..." in any contributes.commands title (use Unicode "…" instead)', () => {
    const cmds = pkg.contributes?.commands ?? [];
    const violations: string[] = [];

    for (const c of cmds) {
      if (typeof c.title === 'string' && c.title.includes('...')) {
        violations.push(
          `command '${c.command}' title "${c.title}" contains ASCII "..."; ` +
            `use Unicode "…" (U+2026) instead`
        );
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      '\n' + describeViolations('ascii-ellipsis', violations)
    );
  });

  // -------------------------------------------------------------------------
  // Invariant 8: dialog/input-opening commands end with a Unicode ellipsis.
  //
  // VS Code + IntelliJ (git4idea action.Git.CreateNewBranch.text = "New
  // Branch…") suffix "…" on commands that open a dialog/picker before acting.
  // The "New Branch" family all opens the New Branch dialog, so every entry
  // must carry the ellipsis — one of them shipped without it.
  // -------------------------------------------------------------------------
  it('every New Branch dialog-opener title ends with "…"', () => {
    const newBranchOpeners = [
      'intellig.branch.new',
      'intellig.branch.newBranchFrom',
      'intellig.tag.newBranchFrom',
      'intellig.commit.newBranch',
    ];
    const cmds = pkg.contributes?.commands ?? [];
    const violations: string[] = [];

    for (const id of newBranchOpeners) {
      const cmd = cmds.find((c) => c.command === id);
      assert.ok(cmd, `expected command '${id}' to be declared`);
      if (cmd && typeof cmd.title === 'string' && !cmd.title.endsWith('…')) {
        violations.push(
          `command '${id}' title "${cmd.title}" opens the New Branch dialog but lacks "…"`
        );
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      '\n' + describeViolations('missing-ellipsis', violations)
    );
  });

  // -------------------------------------------------------------------------
  // Invariant 9: no command title starts with "Rebase: " or "Blame: ".
  //
  // With `"category": "IntelliG"` the command palette already namespaces
  // commands as "IntelliG: <title>". Inner prefixes like "Rebase: " and
  // "Blame: " are redundant and differ from IntelliJ's self-describing
  // action text.
  // -------------------------------------------------------------------------
  it('no command title starts with "Rebase: " or "Blame: " (redundant palette prefix)', () => {
    const cmds = pkg.contributes?.commands ?? [];
    const violations: string[] = [];
    const redundantPrefixes = ['Rebase: ', 'Blame: '];

    for (const c of cmds) {
      if (typeof c.title === 'string') {
        for (const prefix of redundantPrefixes) {
          if (c.title.startsWith(prefix)) {
            violations.push(
              `command '${c.command}' title "${c.title}" starts with redundant prefix "${prefix}"`
            );
          }
        }
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      '\n' + describeViolations('redundant-palette-prefix', violations)
    );
  });

  // -------------------------------------------------------------------------
  // Invariant 10: every `viewItem == <X>` menu gate names a contextValue that
  // some source file actually produces.
  //
  // VS Code only renders a `view/item/context` entry when a tree node sets a
  // matching `contextValue`. A `when` clause that names a contextValue no
  // source ever assigns is dead UI — the row never appears anywhere. This
  // guard collects every distinct `viewItem == <literal>` across all menus
  // and asserts each literal is produced under `src/`, either verbatim or via
  // a dotted prefix (the SCM provider builds values like
  // `intellig.scm.${kind}.${code}` from the literal prefix `intellig.scm.`).
  // -------------------------------------------------------------------------
  it('every viewItem == <X> menu gate names a contextValue produced under src/', () => {
    const literals = collectViewItemLiterals(pkg);
    assert.ok(literals.size > 0, 'expected at least one viewItem == <X> menu gate');

    const sourceText = readAllSourceText();
    const violations: string[] = [];

    for (const literal of literals) {
      if (!sourceProducesContextValue(sourceText, literal)) {
        violations.push(
          `no source under src/ produces contextValue "${literal}" (menu gate "viewItem == ${literal}" is dead UI)`
        );
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      '\n' + describeViolations('orphaned-viewItem-gate', violations)
    );
  });

  // -------------------------------------------------------------------------
  // Invariant 11: regression guard — no menu entry is gated on the orphaned
  // `intellig.logCommit` contextValue. The live commit menu is the webview
  // graph overlay; no native tree produces this contextValue.
  // -------------------------------------------------------------------------
  it('no menu entry references the orphaned intellig.logCommit contextValue', () => {
    const menus = pkg.contributes?.menus ?? {};
    const violations: string[] = [];

    for (const [menuId, entries] of Object.entries(menus)) {
      for (const entry of entries) {
        if (typeof entry.when === 'string' && entry.when.includes('intellig.logCommit')) {
          violations.push(
            `menu '${menuId}' entry (command '${entry.command ?? '<none>'}') gates on intellig.logCommit`
          );
        }
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      '\n' + describeViolations('logCommit-orphan', violations)
    );
  });
});

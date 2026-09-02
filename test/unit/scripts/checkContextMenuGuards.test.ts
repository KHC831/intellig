/**
 * Companion specs for the five context-menu structural guards.
 *
 * Each guard is proved to (a) pass against the real tree, (b) have TEETH —
 * the bypass it exists to catch makes it exit 1, and (c) honour its exemption
 * marker on the line it belongs to and NOT when parked at the top of a file.
 *
 * (d) failing loudly when a guard stops matching its own owner is covered for
 * every guard that names an owner (or, for check-webview-common-imports,
 * owners), each with a negative control so the assertion cannot pass by the
 * guard rejecting everything. check-context-open-no-quickpick has no owner;
 * its floor is exercised separately.
 *
 * Manual mutation is a one-time check; these run every gate.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const TMP_ROOT = SCRATCH_ROOT;

function guard(name: string, args: string[] = []): { status: number | null; stderr: string } {
  const r = spawnSync('bash', [path.join(process.cwd(), 'scripts', name), ...args], {
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr ?? '' };
}

/** Invoke a guard by ABSOLUTE path from a cwd that is neither the repo root
 * nor a subdirectory of it — the shape a worktree, a nested cwd, or a CI
 * step with a different working directory would produce. */
function guardFromForeignCwd(name: string): { status: number | null; stderr: string } {
  const scriptAbs = path.join(process.cwd(), 'scripts', name);
  const scanRootAbs = path.join(process.cwd(), 'src');
  const r = spawnSync('bash', [scriptAbs, scanRootAbs], {
    encoding: 'utf8',
    cwd: os.tmpdir(),
  });
  return { status: r.status, stderr: r.stderr ?? '' };
}

/**
 * The owner each guard checks itself against, and a body that still carries the
 * form the guard scans for. A fixture that leaves the owner out trips the
 * anti-vacuity arm before reaching the rule under test, so one is seeded unless
 * the fixture supplies its own.
 */
const INTACT_OWNER: Readonly<Record<string, readonly [string, string]>> = {
  'check-popup-placement-shared.sh': [
    'webview-common/placeNearPointer.ts',
    'const w = view.innerWidth;\nconst h = view.innerHeight;\n',
  ],
  'check-context-menu-widget.sh': [
    'webview-common/contextMenu.ts',
    "row.className = 'context-menu-item';\n",
  ],
  'check-ref-name-sort-shared.sh': [
    'utils/refNameSort.ts',
    'export function compareRefNames(a: string, b: string): number {\n  return 0;\n}\n',
  ],
};

/** Run `name` over a throwaway tree containing `files`. */
function overFixture(
  name: string,
  files: Record<string, string>
): { status: number | null; stderr: string } {
  const owner = INTACT_OWNER[name];
  if (owner && !(owner[0] in files)) {
    files = { [owner[0]]: owner[1], ...files };
  }
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'ctx-guard-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    return guard(name, [dir]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-popup-placement-shared guard', () => {
  const NAME = 'check-popup-placement-shared.sh';
  const CLAMP =
    'const maxLeft = window.innerWidth - 220;\nconst maxTop = window.innerHeight - 320;\n' +
    "node.style.left = Math.min(x, maxLeft) + 'px';\n";

  it('passes against the real tree', () => {
    const { status, stderr } = guard(NAME);
    assert.strictEqual(status, 0, stderr);
  });

  it('fails on a hand-rolled viewport clamp', () => {
    const { status, stderr } = overFixture(NAME, { 'popup.ts': CLAMP });
    assert.strictEqual(status, 1);
    assert.match(stderr, /popup\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('honours the marker on the clamp line', () => {
    const { status, stderr } = overFixture(NAME, {
      'popup.ts': `// placement-exempt: measuring only\n${CLAMP}`,
    });
    assert.strictEqual(status, 0, stderr);
  });

  it('is NOT un-fenced by a marker parked at the top of the file', () => {
    // The trap this guard shipped with: a file-scoped exemption silently
    // un-fences every clamp written below it.
    const { status, stderr } = overFixture(NAME, {
      'popup.ts': `// placement-exempt: bogus\nconst unrelated = 1;\n\n${CLAMP}`,
    });
    assert.strictEqual(status, 1);
    assert.match(stderr, /popup\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });
});

describe('check-context-menu-widget guard', () => {
  const NAME = 'check-context-menu-widget.sh';

  it('passes against the real tree', () => {
    const { status, stderr } = guard(NAME);
    assert.strictEqual(status, 0, stderr);
  });

  it('fails on a row built outside the widget', () => {
    const { status, stderr } = overFixture(NAME, {
      'rows.ts': "el.className = 'context-menu-item';\n",
    });
    assert.strictEqual(status, 1);
    assert.match(stderr, /rows\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('fails on the wrapped assignment prettier produces at printWidth 100', () => {
    const { status, stderr } = overFixture(NAME, {
      'rows.ts': "el.className =\n  'context-menu-item context-menu-danger long-enough-to-wrap';\n",
    });
    assert.strictEqual(status, 1);
    assert.match(stderr, /rows\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('honours the marker on the line above', () => {
    const { status, stderr } = overFixture(NAME, {
      'rows.ts': "// context-menu-exempt: fixture builder\nel.className = 'context-menu-item';\n",
    });
    assert.strictEqual(status, 0, stderr);
  });

  it('fails on setAttribute("class", ...)', () => {
    const { status, stderr } = overFixture(NAME, {
      'rows.ts': "row.setAttribute('class', 'context-menu-item');\n",
    });
    assert.strictEqual(status, 1);
    assert.match(stderr, /rows\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('fails on a class key inside the setAttrs() property bag', () => {
    // The realistic bypass, not the exotic one: setAttrs (ctwDom.ts) is used
    // at 30+ sites in src, and commitToolWindow.ts already stamps attributes
    // through it — a `class:` key is the natural next thing someone writes.
    const { status, stderr } = overFixture(NAME, {
      'rows.ts': "setAttrs(row, { class: 'context-menu-item' });\n",
    });
    assert.strictEqual(status, 1);
    assert.match(stderr, /rows\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('fails on a hoisted class constant assigned to className elsewhere', () => {
    const { status, stderr } = overFixture(NAME, {
      'rows.ts':
        "const ROW = 'context-menu-item';\n" +
        'function build(el: HTMLElement): void {\n' +
        '  el.className = ROW;\n' +
        '}\n',
    });
    assert.strictEqual(status, 1, 'a hoisted class constant must not evade the scan');
    assert.match(stderr, /rows\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });
});

describe('check-context-open-no-quickpick guard', () => {
  const NAME = 'check-context-open-no-quickpick.sh';
  const handler = (body: string): string =>
    `switch (action) {\n  case 'contextOpen': {\n${body}\n  }\n}\n`;

  it('passes against the real tree', () => {
    const { status, stderr } = guard(NAME);
    assert.strictEqual(status, 0, stderr);
  });

  it('fails when a contextOpen handler reaches for a QuickPick', () => {
    const { status, stderr } = overFixture(NAME, {
      'a.ts': handler('    await vscode.window.showQuickPick(items);'),
      'b.ts': handler('    post({ type: "showRowContextMenu", items });'),
    });
    assert.strictEqual(status, 1);
    assert.match(stderr, /a\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('does not count a doc-comment mention as a handler', () => {
    // Two real handlers plus a comment-only file must still read as two; a
    // comment satisfying the floor would let the guard pass on a tree with
    // one real handler left.
    const { status, stderr } = overFixture(NAME, {
      'a.ts': handler('    post({ type: "showRowContextMenu", items });'),
      'doc.ts': "/**\n * When `action === 'contextOpen'`, the webview asks the host.\n */\n",
    });
    assert.strictEqual(status, 1, 'a comment must not satisfy the handler floor');
    assert.match(stderr, /scanning almost nothing/, `wrong failure:\n${stderr}`);
  });

  // The reachable failure this gate exists to catch without a false alarm:
  // a file handles contextOpen correctly (posts to the webview) but ALSO
  // owns an unrelated action — "move to changelist" is exactly this shape —
  // whose natural implementation inlines a QuickPick that has nothing to do
  // with the right-click. The guard is scoped per showQuickPick CALL SITE,
  // not per file, so this unrelated call must mark its own line, or the
  // line directly above it, with `// quickpick-exempt: <reason>` —
  // deliberately per-line, since a file-level marker would un-fence every
  // showQuickPick call written below it, including a real contextOpen
  // regression.
  it('fails on a showQuickPick unrelated to contextOpen, in a file that also handles it correctly', () => {
    const { status, stderr } = overFixture(NAME, {
      'a.ts':
        handler('    post({ type: "showRowContextMenu", items });') +
        'async function moveToChangelist(): Promise<void> {\n' +
        '  await vscode.window.showQuickPick(changelistNames);\n' +
        '}\n',
      'b.ts': handler('    post({ type: "showRowContextMenu", items });'),
    });
    assert.strictEqual(status, 1);
    assert.match(stderr, /a\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('honours a per-line marker on the unrelated showQuickPick call', () => {
    const { status, stderr } = overFixture(NAME, {
      'a.ts':
        handler('    post({ type: "showRowContextMenu", items });') +
        'async function moveToChangelist(): Promise<void> {\n' +
        '  // quickpick-exempt: picking a changelist, not answering a right-click\n' +
        '  await vscode.window.showQuickPick(changelistNames);\n' +
        '}\n',
      'b.ts': handler('    post({ type: "showRowContextMenu", items });'),
    });
    assert.strictEqual(status, 0, stderr);
  });

  it('is NOT un-fenced by a marker parked at the top of the file', () => {
    const { status, stderr } = overFixture(NAME, {
      'a.ts':
        '// quickpick-exempt: everything below, allegedly\n' +
        handler('    post({ type: "showRowContextMenu", items });') +
        'async function moveToChangelist(): Promise<void> {\n' +
        '  await vscode.window.showQuickPick(changelistNames);\n' +
        '}\n',
      'b.ts': handler('    post({ type: "showRowContextMenu", items });'),
    });
    assert.strictEqual(status, 1, 'a file-level marker must not un-fence the whole file');
    assert.match(stderr, /a\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });
});

describe('check-webview-common-imports guard', () => {
  const NAME = 'check-webview-common-imports.sh';

  it('passes against the real tree', () => {
    const { status, stderr } = guard(NAME);
    assert.strictEqual(status, 0, stderr);
  });

  // Both fenced modules must EXIST in the fixture (DOM_ONLY is resolved
  // relative to SCAN_ROOT, so a fixture stands in for the real tree
  // completely) and be imported by SOMETHING, or the guard's anti-vacuity
  // arms exit 1 and the assertions below would pass without ever reaching
  // the rule they are about.
  const legal = {
    'webview-common/contextMenu.ts': '/// <reference lib="dom" />\nexport class ContextMenu {}\n',
    'webview-common/placeNearPointer.ts':
      '/// <reference lib="dom" />\nexport function placeNearPointer(): void {}\n',
    'webview/entry.ts':
      "import { ContextMenu } from '../webview-common/contextMenu';\n" +
      "import { placeNearPointer } from '../webview-common/placeNearPointer';\n",
  };

  it('allows both imports from webview code', () => {
    const { status, stderr } = overFixture(NAME, legal);
    assert.strictEqual(status, 0, stderr);
  });

  // The gutted-owner / intact-owner control pair proves DOM_ONLY resolves
  // against the FIXTURE root, not the real src/ tree — otherwise this arm
  // always stats the real files and can never go red.
  it('fails loudly when a DOM_ONLY module is gone (anti-vacuity)', () => {
    // contextMenu.ts omitted; placeNearPointer.ts still present and imported.
    const { status, stderr } = overFixture(NAME, {
      'webview-common/placeNearPointer.ts': legal['webview-common/placeNearPointer.ts'],
      'webview/entry.ts':
        "import { placeNearPointer } from '../webview-common/placeNearPointer';\n",
    });
    assert.strictEqual(status, 1, 'a missing DOM_ONLY module must fail loudly, not pass vacuously');
    assert.match(stderr, /does not exist/, `failed for the wrong reason:\n${stderr}`);
  });

  it('is satisfied by a tree where both DOM_ONLY modules exist and are imported', () => {
    // The negative control: without this, the assertion above would also
    // pass if the guard rejected every fixture for some unrelated reason.
    const { status, stderr } = overFixture(NAME, legal);
    assert.strictEqual(status, 0, stderr);
  });

  it('fails on a host module that sits beside a webview directory', () => {
    // MergeWindowPanel.ts is host code (it imports vscode) living directly in
    // conflicts/merge-window/, whose `webview/` subdirectory is the client. An
    // exemption written for the client that spans `/` covers the host module
    // too, and the failure it hides is "document is not defined" at activation.
    const { status, stderr } = overFixture(NAME, {
      ...legal,
      'conflicts/merge-window/webview/client.ts':
        "import { ContextMenu } from '../../../webview-common/contextMenu';\n",
      'conflicts/merge-window/MergeWindowPanel.ts':
        "import { ContextMenu } from '../../webview-common/contextMenu';\n",
    });
    assert.strictEqual(status, 1, 'the host module beside the client must be rejected');
    assert.match(stderr, /MergeWindowPanel\.ts/, `rejected for the wrong reason:\n${stderr}`);
    assert.doesNotMatch(stderr, /client\.ts/, 'the webview client itself is legitimate');
  });

  for (const quote of ["'", '"']) {
    const style = quote === "'" ? 'single' : 'double';
    it(`fails on a host import written with ${style} quotes`, () => {
      // The gate runs eslint alone, not prettier --check, so a double-quoted
      // import reaches main whenever the pre-commit hook is bypassed.
      const { status, stderr } = overFixture(NAME, {
        ...legal,
        'hostThing.ts': `import { ContextMenu } from ${quote}../webview-common/contextMenu${quote};\n`,
      });
      assert.strictEqual(status, 1, 'the host import must be rejected');
      assert.match(stderr, /hostThing\.ts/, `rejected for the wrong reason:\n${stderr}`);
    });
  }
});

describe('check-ref-name-sort-shared guard', () => {
  const NAME = 'check-ref-name-sort-shared.sh';

  // The floor's own baseline: enough real `.sort(compareRefNames)` sites that
  // a test's OWN fixture file (whatever it seeds beyond this) never has to
  // carry the floor itself. Matches the real tree's floor of 3 exactly, so a
  // test that drops one filler below the floor is a precise, minimal probe.
  const FLOOR_FILLERS: Record<string, string> = {
    'floor-filler-1.ts': 'export const a = names.sort(compareRefNames);\n',
    'floor-filler-2.ts': 'export const b = names.sort(compareRefNames);\n',
    'floor-filler-3.ts': 'export const c = names.sort(compareRefNames);\n',
  };

  function overRefSortFixture(files: Record<string, string>): {
    status: number | null;
    stderr: string;
  } {
    return overFixture(NAME, { ...FLOOR_FILLERS, ...files });
  }

  it('passes against the real tree', () => {
    const { status, stderr } = guard(NAME);
    assert.strictEqual(status, 0, stderr);
  });

  it('fails on a bare sort of ref names in the Branches tree surface', () => {
    const { status, stderr } = overRefSortFixture({
      'branches/tree.ts': 'const remoteNames = Array.from(byRemote.keys()).sort();\n',
    });
    assert.strictEqual(status, 1);
    assert.match(stderr, /tree\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  // A bare sort of ref names is not confined to the Branches tree — it
  // surfaces just as easily in the Git tool window's branch filter, so this
  // pins that second surface too, guarding against a third going unfenced.
  it('fails on a bare sort of ref names in the Git tool window surface', () => {
    const { status, stderr } = overRefSortFixture({
      'git-core/gitToolWindow/provider/loadedGraphQueries.ts': 'const local = [...names].sort();\n',
    });
    assert.strictEqual(status, 1, 'the scan must reach git-core/gitToolWindow too');
    assert.match(stderr, /loadedGraphQueries\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  // The guard scans all of src, not an allow-list of known surfaces — this
  // fixture lives outside both branches/ and git-core/gitToolWindow/ to
  // prove any other surface is caught too.
  it('fails on a bare sort of ref names outside every named surface', () => {
    const { status, stderr } = overRefSortFixture({
      'git-core/gitParser.ts': 'const names = [...set].sort();\n',
    });
    assert.strictEqual(status, 1, 'the scan must not be limited to a fixed directory list');
    assert.match(stderr, /gitParser\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('accepts a sort that passes the shared comparator', () => {
    const { status, stderr } = overRefSortFixture({
      'branches/tree.ts':
        'const remoteNames = Array.from(byRemote.keys()).sort(compareRefNames);\n',
    });
    assert.strictEqual(status, 0, stderr);
  });

  it('ignores a comment that only mentions a bare sort', () => {
    const { status, stderr } = overRefSortFixture({
      'branches/tree.ts': '// A bare .sort() would order these by code unit.\nconst x = 1;\n',
    });
    assert.strictEqual(status, 0, stderr);
  });

  it('honours the marker on the sort line', () => {
    const { status, stderr } = overRefSortFixture({
      'branches/tree.ts':
        '// ref-sort-exempt: fingerprint, order only has to be stable\nconst k = keys.sort();\n',
    });
    assert.strictEqual(status, 0, stderr);
  });

  // The scan reads through the real lexer (scripts/lib/exemptWindow.js),
  // not a "does this line contain a `://`" heuristic — a trailing URL
  // comment or a string literal holding one must not make the scanner treat
  // the whole line as a comment/URL and drop a real bare sort that appears
  // earlier on the same line.
  it('still fails a bare sort that carries a trailing URL comment', () => {
    const { status, stderr } = overRefSortFixture({
      'branches/tree.ts': 'const b = refs.sort(); // see https://example.com/why\n',
    });
    assert.strictEqual(
      status,
      1,
      'a bare sort must not be excused by an unrelated :// later on the line'
    );
    assert.match(stderr, /tree\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  it('still fails a bare sort inside a ternary that also contains a :// literal', () => {
    const { status, stderr } = overRefSortFixture({
      'branches/tree.ts': "const b = uri.startsWith('http://') ? refs.sort() : refs;\n",
    });
    assert.strictEqual(
      status,
      1,
      'a bare sort must not be excused by an unrelated :// earlier on the line'
    );
    assert.match(stderr, /tree\.ts/, `rejected for the wrong reason:\n${stderr}`);
  });

  describe('routed-sites floor (anti-vacuity)', () => {
    // Exempt-marking every real site would pass the bare-sort scan while
    // fencing nothing — this floor requires evidence the comparator is
    // actually used, not just that nothing LOOKS unmarked.
    it('fails when too few sites route through compareRefNames', () => {
      const { status, stderr } = overFixture(NAME, {
        // Only 2 routed sites — one short of the real tree's floor of 3.
        'a.ts': 'export const a = names.sort(compareRefNames);\n',
        'b.ts': 'export const b = names.sort(compareRefNames);\n',
      });
      assert.strictEqual(status, 1, 'too few routed sites must fail loudly');
      assert.match(stderr, /too few|floor/i, `failed for the wrong reason:\n${stderr}`);
    });

    it('is satisfied by the real tree floor count', () => {
      const { status, stderr } = overRefSortFixture({});
      assert.strictEqual(status, 0, stderr);
    });

    // A comment merely NAMING the comparator is not evidence anything routes
    // through it — the floor exists precisely to catch a tree where every
    // real site has been exempt-marked away while comment text alone would
    // otherwise satisfy it.
    it('does not count a comment mention of the comparator toward the floor', () => {
      const { status, stderr } = overFixture(NAME, {
        // Only 2 real routed sites; a third file mentions the comparator
        // three times in comments, never in real code.
        'a.ts': 'export const a = names.sort(compareRefNames);\n',
        'b.ts': 'export const b = names.sort(compareRefNames);\n',
        'c.ts':
          '// See tree.ts: names.sort(compareRefNames)\n' +
          '// See other.ts: names.sort(compareRefNames)\n' +
          '// See third.ts: names.sort(compareRefNames)\n' +
          'export const c = 1;\n',
      });
      assert.strictEqual(
        status,
        1,
        'a comment-only mention must not satisfy the routed-sites floor'
      );
      assert.match(stderr, /too few|floor/i, `failed for the wrong reason:\n${stderr}`);
    });

    // Teeth: when a fixture is BOTH under the floor AND carries a bare sort,
    // the floor reason must win — the floor runs before the bare-sort scan,
    // so a dropped comparator is reported as "too few routed sites", not
    // "ref names sorted by code unit". Proves the ordering, not just the count.
    it('reports the floor failure, not the bare-sort failure, when a routed site loses its comparator', () => {
      const { status, stderr } = overFixture(NAME, {
        'a.ts': 'export const a = names.sort(compareRefNames);\n',
        'b.ts': 'export const b = names.sort(compareRefNames);\n',
        // Was a third routed filler; its comparator was dropped, so the
        // fixture now has only 2 routed sites AND one bare sort.
        'c.ts': 'export const c = names.sort();\n',
      });
      assert.strictEqual(status, 1);
      assert.match(stderr, /too few|floor/i, `must report the floor reason:\n${stderr}`);
      assert.doesNotMatch(
        stderr,
        /sorted by code unit/,
        `must not report the bare-sort reason instead:\n${stderr}`
      );
    });
  });

  // Both scans read source through the shared lexer (scripts/lib/exemptWindow.js),
  // never a second line-prefix comment heuristic — comment text AND string/
  // template-literal payload text are blanked before either the floor count
  // or the bare-sort scan looks for `.sort(...)`.
  describe('comment and string text is not code', () => {
    it('does not let a block comment satisfy the routed-sites floor', () => {
      const { status, stderr } = overFixture(NAME, {
        'tree.ts':
          '/*\n' +
          '  Historically the headers did\n' +
          '    headers.sort(compareRefNames)\n' +
          '  and the children did\n' +
          '    kids.sort(compareRefNames)\n' +
          '  and the filter did\n' +
          '    filter.sort(compareRefNames)\n' +
          '*/\n' +
          '// ref-sort-exempt: fingerprint order, not ref order\n' +
          'const fp = parts.sort();\n',
      });
      assert.strictEqual(status, 1, 'a block comment must not satisfy the floor');
      assert.match(stderr, /too few|floor/i, `failed for the wrong reason:\n${stderr}`);
    });

    it('does not let a string literal satisfy the routed-sites floor', () => {
      const { status, stderr } = overFixture(NAME, {
        'tree.ts':
          'const docs = [\n' +
          "  'headers.sort(compareRefNames) is the rule',\n" +
          "  'kids.sort(compareRefNames) is the rule',\n" +
          "  'filter.sort(compareRefNames) is the rule',\n" +
          '];\n',
      });
      assert.strictEqual(status, 1, 'a string literal must not satisfy the floor');
      assert.match(stderr, /too few|floor/i, `failed for the wrong reason:\n${stderr}`);
    });

    it('does not flag a bare .sort() described in a block comment (false FAIL)', () => {
      const { status, stderr } = overRefSortFixture({
        'tree.ts':
          '/*\n  We used to do refs.sort() right here before the comparator existed.\n*/\n',
      });
      assert.strictEqual(status, 0, stderr);
    });
  });
});

describe('guards resolve their shared lib relative to their own location', () => {
  // check-popup-placement-shared.sh and check-context-menu-widget.sh source
  // scripts/lib/exempt-marker.sh; check-ref-name-sort-shared.sh sources
  // scripts/lib/exemptWindow.js instead. All three resolve their shared lib
  // through SCRIPT_DIR, derived from ${BASH_SOURCE[0]} — never a path
  // relative to the caller's cwd. Run each by ABSOLUTE path from an
  // unrelated cwd (a worktree, a subdirectory, a CI step) to prove that.
  for (const name of [
    'check-ref-name-sort-shared.sh',
    'check-popup-placement-shared.sh',
    'check-context-menu-widget.sh',
  ]) {
    it(`${name} runs from a cwd other than the repo root`, () => {
      const { status, stderr } = guardFromForeignCwd(name);
      assert.strictEqual(status, 0, stderr);
      assert.doesNotMatch(
        stderr,
        /No such file or directory/,
        `failed to locate its own shared library:\n${stderr}`
      );
    });
  }
});

describe('context-menu guards — anti-vacuity arms', () => {
  // Each guard scans for a form its own owner must still use. When a refactor
  // changes that form, the guard stops matching ANYTHING and would otherwise
  // report OK forever. These pin the loud failure instead.
  const CASES: ReadonlyArray<{
    name: string;
    owner: string;
    gutted: string;
    intact: string;
    // Extra files a guard's own floor (if any) needs present so the
    // owner-matching probe isn't ALSO tripped by an unrelated anti-vacuity
    // arm. Empty for guards with no floor.
    extraFiles?: Record<string, string>;
  }> = [
    {
      name: 'check-popup-placement-shared.sh',
      owner: 'webview-common/placeNearPointer.ts',
      gutted: 'export function placeNearPointer(): void {}\n',
      intact:
        'const w = view.innerWidth;\nconst h = view.innerHeight;\n' +
        'export function placeNearPointer(): void {}\n',
    },
    {
      name: 'check-context-menu-widget.sh',
      owner: 'webview-common/contextMenu.ts',
      gutted: 'export class ContextMenu {}\n',
      intact: "row.className = 'context-menu-item';\nexport class ContextMenu {}\n",
    },
    {
      name: 'check-ref-name-sort-shared.sh',
      owner: 'utils/refNameSort.ts',
      gutted: 'export const nothingHere = 1;\n',
      intact: 'export function compareRefNames(a: string, b: string): number {\n  return 0;\n}\n',
      // The routed-sites floor is a SEPARATE anti-vacuity arm from the owner
      // check; feed it enough routed sites so the owner-matching probe below
      // isn't incidentally caught by the floor instead.
      extraFiles: {
        'floor-filler-1.ts': 'export const a = names.sort(compareRefNames);\n',
        'floor-filler-2.ts': 'export const b = names.sort(compareRefNames);\n',
        'floor-filler-3.ts': 'export const c = names.sort(compareRefNames);\n',
      },
    },
  ];

  for (const { name, owner, gutted, intact, extraFiles } of CASES) {
    it(`${name} fails when its owner stops matching`, () => {
      const { status, stderr } = overFixture(name, { [owner]: gutted, ...extraFiles });
      assert.strictEqual(status, 1, `${name} passed over an owner it no longer matches`);
      assert.match(stderr, /owner/i, `failed for the wrong reason:\n${stderr}`);
    });

    it(`${name} is satisfied by an owner that still matches`, () => {
      // The negative control: without this, the assertion above would also pass
      // if the guard rejected every fixture for some unrelated reason.
      const { status, stderr } = overFixture(name, { [owner]: intact, ...extraFiles });
      assert.strictEqual(status, 0, stderr);
    });
  }
});

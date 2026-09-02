/**
 * Companion spec for scripts/check-keybindings-coherence.mjs.
 *
 * Proves the guard (a) passes against the real tree, (b) fails an ungated
 * global binding, (c) accepts a gated binding, (d) accepts an ungated
 * binding whose when-clause scopes it to an intellig view/panel (the
 * structural rule: the next scoped binding is legal, the next global one
 * fails), and (e) fails a keybinding whose command is registered via
 * registerTreeItemCommand (the dead-gesture arg contract), and (f) fails a
 * binding that lands on a core VS Code editor chord without a text-input
 * carve-out — on the platform-specific chord as well as the shared one.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-keybindings-coherence.mjs');
const TMP_ROOT = SCRATCH_ROOT;

interface IFixture {
  keybindings: { command: string; key?: string; mac?: string; when?: string }[];
  src?: Record<string, string>;
}

function runFixture(fixture: IFixture): { status: number | null; stderr: string } {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'kb-coherence-'));
  try {
    const pkgPath = path.join(dir, 'package.json');
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({ contributes: { keybindings: fixture.keybindings } }),
      'utf8'
    );
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    for (const [name, content] of Object.entries(fixture.src ?? {})) {
      fs.writeFileSync(path.join(srcDir, name), content, 'utf8');
    }
    const r = spawnSync('node', [SCRIPT, pkgPath, srcDir], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const GATED_WHEN = "!inDebugMode && config.intellig.keymapPreset == 'intellij'";

describe('check-keybindings-coherence guard', () => {
  it('passes against the real tree', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    assert.strictEqual(
      r.status,
      0,
      `guard should pass on the real tree; stderr:\n${r.stderr ?? ''}`
    );
  });

  it('fails an ungated global binding (has teeth)', () => {
    const { status, stderr } = runFixture({
      keybindings: [{ command: 'intellig.foo.bar', key: 'ctrl+q', when: '!inDebugMode' }],
    });
    assert.strictEqual(status, 1, `ungated global binding must fail; ${stderr}`);
    assert.ok(stderr.includes('intellig.foo.bar'));
  });

  it('accepts a preset-gated binding', () => {
    const { status } = runFixture({
      keybindings: [{ command: 'intellig.foo.bar', key: 'ctrl+q', when: GATED_WHEN }],
    });
    assert.strictEqual(status, 0);
  });

  it('accepts ANY ungated binding scoped to an intellig view/panel (structural rule)', () => {
    const { status } = runFixture({
      keybindings: [
        {
          command: 'intellig.some.futureInViewGesture',
          key: 'ctrl+f',
          when: "activeWebviewPanelId == 'intellig.somePanel'",
        },
      ],
    });
    assert.strictEqual(status, 0, 'a view-scoped binding is legal by construction');
  });

  it('a non-intellig view scope does not satisfy the rule', () => {
    const { status } = runFixture({
      keybindings: [
        {
          command: 'intellig.foo.bar',
          key: 'ctrl+q',
          when: "focusedView == 'someOther.view'",
        },
      ],
    });
    assert.strictEqual(status, 1, 'scoping to a foreign view must not sanction an ungated binding');
  });

  it('fails a core editor chord bound without a text-input carve-out', () => {
    const { status, stderr } = runFixture({
      keybindings: [
        { command: 'intellig.foo.bar', key: 'ctrl+q', mac: 'ctrl+k', when: GATED_WHEN },
      ],
    });
    assert.strictEqual(status, 1, `a core mac chord must fail; ${stderr}`);
    assert.ok(stderr.includes('deleteAllRight'), `failure must name the core command; ${stderr}`);
  });

  it('accepts a core editor chord that yields inside text inputs', () => {
    const { status, stderr } = runFixture({
      keybindings: [
        {
          command: 'intellig.foo.bar',
          key: 'ctrl+q',
          mac: 'ctrl+k',
          when: `${GATED_WHEN} && !textInputFocus`,
        },
      ],
    });
    assert.strictEqual(status, 0, `the carve-out must satisfy the rule; ${stderr}`);
  });

  it('checks the shared `key` on every platform, not just the mac override', () => {
    // No `mac`, so `key` is what mac binds too — ctrl+t is transposeLetters.
    const { status, stderr } = runFixture({
      keybindings: [{ command: 'intellig.foo.bar', key: 'ctrl+t', when: GATED_WHEN }],
    });
    assert.strictEqual(status, 1, `a shared key must be checked per platform; ${stderr}`);
    assert.ok(stderr.includes('transposeLetters'));
  });

  it('exempts a view-scoped binding on a core chord (no editor can have focus)', () => {
    const { status } = runFixture({
      keybindings: [
        {
          command: 'intellig.some.inViewGesture',
          key: 'ctrl+l',
          when: "focusedView == 'intellig.toolWindow'",
        },
      ],
    });
    assert.strictEqual(status, 0, 'our own view having focus rules out an editor keystroke');
  });

  it('fails a keybinding whose command is a registerTreeItemCommand target', () => {
    const { status, stderr } = runFixture({
      keybindings: [{ command: 'intellig.foo.treeOnly', key: 'ctrl+q', when: GATED_WHEN }],
      src: {
        'reg.ts':
          "registerTreeItemCommand(deps, {\n  id: 'intellig.foo.treeOnly',\n  accepts: ['branch'],\n});\n",
      },
    });
    assert.strictEqual(status, 1, `tree-item keybinding must fail; ${stderr}`);
    assert.ok(stderr.includes('registerTreeItemCommand'));
  });
});

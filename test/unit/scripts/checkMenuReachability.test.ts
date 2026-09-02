/**
 * Companion spec for scripts/check-menu-reachability.mjs.
 *
 * Proves the guard (a) passes against the real tree, (b) has teeth: a
 * palette-hidden command whose only in-source occurrence is its own
 * registration (`id: '<cmd>'`) fails, (c) accepts a real sender
 * (`executeCommand` literal) or a menus entry, (d) is prefix-safe (a sender
 * for `...compareWithHead` does not satisfy `...compareWith`), and (e) fails
 * on a stale RATCHET entry that has become reachable.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-menu-reachability.mjs');
const TMP_ROOT = SCRATCH_ROOT;

interface IFixture {
  menus?: Record<string, { command: string; when?: string; group?: string }[]>;
  keybindings?: { command: string; key: string }[];
  src?: Record<string, string>;
}

function runFixture(fixture: IFixture): { status: number | null; stderr: string } {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'menu-reach-'));
  try {
    const pkg = {
      contributes: {
        commands: [],
        menus: fixture.menus ?? {},
        keybindings: fixture.keybindings ?? [],
      },
    };
    const pkgPath = path.join(dir, 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify(pkg), 'utf8');
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

describe('check-menu-reachability guard', () => {
  it('passes against the real tree', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    assert.strictEqual(
      r.status,
      0,
      `guard should pass on the real tree; stderr:\n${r.stderr ?? ''}`
    );
  });

  it('fails when a hidden command has only its registration line (has teeth)', () => {
    const { status, stderr } = runFixture({
      menus: { commandPalette: [{ command: 'intellig.foo.orphan', when: 'false' }] },
      src: { 'reg.ts': "registerBareCommand(ctx, {\n  id: 'intellig.foo.orphan',\n});\n" },
    });
    assert.strictEqual(status, 1, `registration alone must not count as a sender; ${stderr}`);
    assert.ok(stderr.includes('intellig.foo.orphan'));
  });

  it('passes when the hidden command has an executeCommand sender', () => {
    const { status, stderr } = runFixture({
      menus: { commandPalette: [{ command: 'intellig.foo.orphan', when: 'false' }] },
      src: {
        'reg.ts': "registerBareCommand(ctx, {\n  id: 'intellig.foo.orphan',\n});\n",
        'sender.ts': "void vscode.commands.executeCommand('intellig.foo.orphan', arg);\n",
      },
    });
    assert.strictEqual(status, 0, `an executeCommand sender must satisfy the guard; ${stderr}`);
  });

  it('passes when the hidden command has a menus entry elsewhere', () => {
    const { status } = runFixture({
      menus: {
        commandPalette: [{ command: 'intellig.foo.orphan', when: 'false' }],
        'editor/context': [{ command: 'intellig.foo.orphan', group: '1_x' }],
      },
    });
    assert.strictEqual(status, 0, 'a non-palette menus entry must satisfy the guard');
  });

  it('a comment-only mention does not count as a sender', () => {
    const { status } = runFixture({
      menus: { commandPalette: [{ command: 'intellig.foo.orphan', when: 'false' }] },
      src: { 'note.ts': '// delegates to intellig.foo.orphan later\nconst x = 1;\n' },
    });
    assert.strictEqual(status, 1, 'a comment mention must not count');
  });

  it('is prefix-safe: a compareWithHead sender does not satisfy compareWith', () => {
    const { status, stderr } = runFixture({
      menus: { commandPalette: [{ command: 'intellig.foo.compareWith', when: 'false' }] },
      src: {
        'sender.ts': "void vscode.commands.executeCommand('intellig.foo.compareWithHead');\n",
      },
    });
    assert.strictEqual(status, 1, `prefix match must not satisfy the exact id; ${stderr}`);
  });

  it('fails on a stale RATCHET entry that has become reachable', () => {
    const { status, stderr } = runFixture({
      menus: { commandPalette: [{ command: 'intellig.commit.copyHash', when: 'false' }] },
      src: {
        'sender.ts': "void vscode.commands.executeCommand('intellig.commit.copyHash');\n",
      },
    });
    assert.strictEqual(status, 1, `a reachable ratchet entry must fail as stale; ${stderr}`);
    assert.ok(stderr.includes('RATCHET'));
  });
});

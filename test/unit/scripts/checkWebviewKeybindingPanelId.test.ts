/**
 * Companion spec for scripts/check-webview-keybinding-panelid.mjs.
 *
 * Proves the guard (a) passes against the real manifest + source, (b)
 * recognizes a real webview viewType passed via `super(...)`
 * (`intellig.mergeWindow`), and (c) has teeth against the false-NEGATIVE hole
 * the old whole-src-substring heuristic left open: a dead panel id that
 * appears only in a comment, or collides with an unrelated `intellig.*` id
 * (a tree-view id, a context key), must now FAIL — the old logic false-passed
 * both.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-webview-keybinding-panelid.mjs');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes', 'tmp');

function runGuard(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * The OLD detection: a viewType is "real" if `'<id>'` or `"<id>"` appears
 * anywhere in the concatenated src blob (comments included). Reproduced here
 * so each teeth case can assert the old logic PASSED where the new one fails.
 */
function oldLogicWouldPass(id: string, srcBlob: string): boolean {
  return srcBlob.includes(`'${id}'`) || srcBlob.includes(`"${id}"`);
}

/** Write a synthetic package.json + src pair under a fresh temp dir. */
function makeFixture(
  name: string,
  keybindingId: string,
  srcContent: string
): {
  dir: string;
  pkgPath: string;
  srcDir: string;
  srcBlob: string;
} {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `wv-kb-${name}-`));
  const pkg = {
    contributes: {
      keybindings: [
        { command: 'intellig.someAction', when: `activeWebviewPanelId == '${keybindingId}'` },
      ],
    },
  };
  const pkgPath = path.join(dir, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg), 'utf8');
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir);
  fs.writeFileSync(path.join(srcDir, 'code.ts'), srcContent, 'utf8');
  return { dir, pkgPath, srcDir, srcBlob: srcContent };
}

describe('check-webview-keybinding-panelid guard', () => {
  before(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
  });

  it('passes against the real package.json + src', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on the real tree; stderr:\n${stderr}`);
  });

  it('recognizes a real viewType passed via super(...) against the real src (intellig.mergeWindow)', () => {
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'wv-kb-mergewindow-'));
    try {
      const pkg = {
        contributes: {
          keybindings: [
            {
              command: 'intellig.mergeWindow.accept',
              when: "activeWebviewPanelId == 'intellig.mergeWindow'",
            },
          ],
        },
      };
      const pkgPath = path.join(dir, 'package.json');
      fs.writeFileSync(pkgPath, JSON.stringify(pkg), 'utf8');
      // Point at the REAL src so the super('intellig.mergeWindow', …) call
      // in MergeWindowPanel.ts resolves the id as a real webview viewType.
      const { status, stderr } = runGuard([pkgPath, path.join(process.cwd(), 'src')]);
      assert.strictEqual(
        status,
        0,
        `intellig.mergeWindow must resolve as real; stderr:\n${stderr}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a keybinding id appears only in a comment (old logic false-passed)', () => {
    const fx = makeFixture(
      'comment',
      'intellig.deadPanel',
      "// intellig.deadPanel used to be a webview here — 'intellig.deadPanel'\n" +
        "vscode.window.createWebviewPanel('intellig.livePanel', 'Live', column, {});\n"
    );
    try {
      assert.ok(
        oldLogicWouldPass('intellig.deadPanel', fx.srcBlob),
        'sanity: the old substring logic would have passed the comment-only id'
      );
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(status, 1, 'a comment-only panel id must fail the guard');
      assert.ok(/intellig\.deadPanel/.test(stderr), 'should name the dead id');
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('fails when a keybinding id collides with a non-webview intellig.* id (old logic false-passed)', () => {
    const fx = makeFixture(
      'collision',
      'intellig.branchTree',
      // intellig.branchTree is a TREE-VIEW id, not a webview viewType — the
      // exact namespace collision the old whole-src substring false-passed.
      "vscode.window.createTreeView('intellig.branchTree', { treeDataProvider });\n" +
        "vscode.window.createWebviewPanel('intellig.livePanel', 'Live', column, {});\n"
    );
    try {
      assert.ok(
        oldLogicWouldPass('intellig.branchTree', fx.srcBlob),
        'sanity: the old substring logic would have passed the tree-view id'
      );
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(status, 1, 'a non-webview id collision must fail the guard');
      assert.ok(/intellig\.branchTree/.test(stderr), 'should name the colliding id');
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('passes for a viewType registered as a createWebviewPanel literal', () => {
    const fx = makeFixture(
      'literal',
      'intellig.realPanel',
      "vscode.window.createWebviewPanel('intellig.realPanel', 'Real', column, {});\n"
    );
    try {
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(status, 0, `a real webview literal must pass; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  it('passes for a viewType stored in a VIEW_TYPE constant and passed by reference', () => {
    const fx = makeFixture(
      'const',
      'intellig.constPanel',
      "const VIEW_TYPE = 'intellig.constPanel';\n" +
        "class D extends BaseWebviewPanel { constructor(ctx) { super(ctx, VIEW_TYPE, 'C'); } }\n"
    );
    try {
      const { status, stderr } = runGuard([fx.pkgPath, fx.srcDir]);
      assert.strictEqual(status, 0, `a VIEW_TYPE-constant viewType must pass; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});

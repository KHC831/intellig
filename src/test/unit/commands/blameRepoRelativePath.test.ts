/**
 * Unit coverage for the blame-menu git pathspec derivation.
 *
 * `_resolveBlameContext` (the shared resolver behind the `intellig.blame.*`
 * gutter-menu commands) used to derive the file's repo-relative path with a RAW
 * `path.relative(repo.rootUri.fsPath, editor.document.uri.fsPath)`. The two ends
 * sit in DIFFERENT symlink-resolution states: `gitService.getRepository` reports
 * the realpath-canonicalized root (macOS `/var` → `/private/var`, from
 * `git rev-parse --show-toplevel`), while the editor URI keeps the symlinked
 * path. A raw `path.relative` between those yields an ESCAPING `../...` pathspec
 * — git then blames a bogus path. The fix routes through `repoRelativePath`,
 * which canonicalizes both ends first.
 *
 * The scenario is exercised against a REAL on-disk symlink so the
 * `fs.realpathSync.native` canonicalization is genuinely run, not mocked.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerBlameEditorCommands } from '../../../commands/registration/blameEditorCommands';
import type { ICommandContext } from '../../../commands/registration/CommandContext';
import type { IRepository, IBlameLine } from '../../../git-core/interfaces/IGitService';

/** Capture every command handler `registerLoggedCommand` registers, by id. */
function captureHandlers(): {
  handlers: Map<string, (...args: unknown[]) => unknown>;
  restore: () => void;
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const orig = vscode.commands.registerCommand;
  (
    vscode.commands as unknown as {
      registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => { dispose(): void };
    }
  ).registerCommand = (id, cb): { dispose(): void } => {
    handlers.set(id, cb);
    return { dispose: (): void => {} };
  };
  return {
    handlers,
    restore: (): void => {
      (vscode.commands as unknown as { registerCommand: typeof orig }).registerCommand = orig;
    },
  };
}

/** Point `vscode.window.activeTextEditor` at a stub on the given file path. */
function stubActiveEditor(fileFsPath: string): () => void {
  const orig = (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor;
  (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
    document: { uri: vscode.Uri.file(fileFsPath) },
    selection: { active: { line: 0 } },
  };
  return (): void => {
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = orig;
  };
}

const COMMITTED_BLAME: IBlameLine = {
  line: 1,
  commit: 'abc1234def5678',
  author: 'Alice',
  authorEmail: 'alice@example.com',
  date: new Date(0),
  message: 'seed',
};

/**
 * Build an ICommandContext that records the `path` argument blame receives, and
 * a single-repo gitService whose root is the CANONICAL (realpath) repo root.
 */
function makeCtx(repoRootFsPath: string, capture: { path?: string }): ICommandContext {
  const repo = {
    rootUri: vscode.Uri.file(repoRootFsPath),
  } as unknown as IRepository;
  const gitService = {
    getRepository: async (): Promise<IRepository> => repo,
  };
  const blameService = {
    getBlameForLine: async (_repo: IRepository, filePath: string): Promise<IBlameLine> => {
      capture.path = filePath;
      return COMMITTED_BLAME;
    },
  };
  const blameOptionsSource = {
    asBlameOptions: (): Record<string, never> => ({}),
    hideRevision: async (): Promise<void> => {},
  };
  return {
    services: { gitService, blameService, blameOptionsSource },
  } as unknown as ICommandContext;
}

describe('blame-menu git pathspec derivation (symlinked repo root)', () => {
  let tmpBase: string;
  let canonicalRoot: string;
  let symlinkedFile: string;

  beforeEach(() => {
    // A symlinked repo: `link-repo` → `real-repo`. git reports the canonical
    // (real) root; the editor URI keeps the symlinked path. The two only
    // reconcile after realpath canonicalization.
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'blame-symlink-'));
    const realRepo = path.join(tmpBase, 'real-repo');
    fs.mkdirSync(realRepo);
    fs.writeFileSync(path.join(realRepo, 'file.ts'), 'const x = 1;\n');
    const linkRepo = path.join(tmpBase, 'link-repo');
    fs.symlinkSync(realRepo, linkRepo, 'dir');
    canonicalRoot = fs.realpathSync.native(realRepo);
    symlinkedFile = path.join(linkRepo, 'file.ts');
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('passes the clean repo-root-relative path to blame, not an escaping ../ pathspec', async () => {
    const cap = captureHandlers();
    let disposables: vscode.Disposable[] = [];
    const capture: { path?: string } = {};
    try {
      disposables = registerBlameEditorCommands(makeCtx(canonicalRoot, capture));
    } finally {
      cap.restore();
    }

    const handler = cap.handlers.get('intellig.blame.hideRevision');
    if (!handler) {
      assert.fail('handler for intellig.blame.hideRevision must be registered');
      return;
    }

    const restoreEditor = stubActiveEditor(symlinkedFile);
    try {
      await handler();
    } finally {
      restoreEditor();
      disposables.forEach((d) => {
        d.dispose();
      });
    }

    assert.strictEqual(
      capture.path,
      'file.ts',
      `blame must receive the canonical repo-relative path, got: ${String(capture.path)}`
    );
  });
});

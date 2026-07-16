/**
 * Show Line History — picking a revision opens the file's diff at that
 * revision (vs its parent), mirroring IntelliJ's selection-history dialog
 * where every listed revision exposes its block diff. Picking must NOT
 * terminate in a plain info toast.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerBlameEditorCommands } from '../../../src/commands/registration/blameEditorCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
import type {
  IRepository,
  IBlameLine,
  ICommit,
} from '../../../src/git-core/interfaces/IGitService';

const NEW_HASH = 'a'.repeat(40);
const PARENT_HASH = 'b'.repeat(40);

/** Capture every registered command handler, by id. */
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

function makeCommit(hash: string, parents: string[]): ICommit {
  return {
    hash,
    shortHash: hash.substring(0, 8),
    message: 'touch the line',
    author: { name: 'Alice', email: 'alice@example.com' },
    committer: { name: 'Alice', email: 'alice@example.com' },
    parents,
    authorDate: new Date('2024-01-15T12:00:00Z'),
    commitDate: new Date('2024-01-15T12:00:00Z'),
  } as ICommit;
}

describe('Show Line History — picked revision opens its diff', () => {
  it('opens a vscode.diff of the file at parent ↔ picked revision', async () => {
    const cap = captureHandlers();
    let disposables: vscode.Disposable[] = [];

    const repo = { rootUri: vscode.Uri.file('/test/repo') } as unknown as IRepository;
    const gitService = {
      getRepository: async (): Promise<IRepository> => repo,
      getRepositories: (): IRepository[] => [repo],
      getLineHistory: async (): Promise<ICommit[]> => [
        makeCommit(NEW_HASH, [PARENT_HASH]),
        makeCommit(PARENT_HASH, []),
      ],
    };
    const blameService = {
      getBlameForLine: async (): Promise<IBlameLine> => ({
        line: 1,
        commit: NEW_HASH,
        author: 'Alice',
        authorEmail: 'alice@example.com',
        date: new Date('2024-01-15T12:00:00Z'),
        message: 'touch the line',
      }),
    };
    const ctx = {
      services: { gitService, blameService },
    } as unknown as ICommandContext;

    try {
      disposables = registerBlameEditorCommands(ctx);
    } finally {
      cap.restore();
    }

    const handler = cap.handlers.get('intellig.editor.showLineHistory');
    assert.ok(handler, 'intellig.editor.showLineHistory must be registered');

    // Active editor on a repo file, cursor on line 1 (0-indexed 0).
    const winMut = vscode.window as unknown as {
      activeTextEditor: unknown;
      showQuickPick: unknown;
    };
    const origEditor = winMut.activeTextEditor;
    const origQuickPick = winMut.showQuickPick;
    winMut.activeTextEditor = {
      document: { uri: vscode.Uri.file('/test/repo/file.ts') },
      selection: { active: { line: 0 } },
    };
    // Pick the newest revision from the history QuickPick.
    winMut.showQuickPick = async (items: unknown[]): Promise<unknown> => items[0];

    // Capture executeCommand invocations (openRevisionDiff funnels through
    // `vscode.diff`).
    const executed: { command: string; args: unknown[] }[] = [];
    const cmdMut = vscode.commands as unknown as { executeCommand: unknown };
    const origExecute = cmdMut.executeCommand;
    cmdMut.executeCommand = async (command: string, ...args: unknown[]): Promise<void> => {
      executed.push({ command, args });
    };

    try {
      await handler();
    } finally {
      winMut.activeTextEditor = origEditor;
      winMut.showQuickPick = origQuickPick;
      cmdMut.executeCommand = origExecute;
      disposables.forEach((d) => {
        d.dispose();
      });
    }

    const diff = executed.find((e) => e.command === 'vscode.diff');
    assert.ok(diff, `picking a revision must open a diff; executed: ${JSON.stringify(executed)}`);
    // The vscode mock's Uri.parse stores the raw string in `path`, so assert
    // on the raw `intellig-git:<path>?<query>` shape.
    const [left, right, title] = diff.args as [vscode.Uri, vscode.Uri, string];
    const refOf = (u: vscode.Uri): string | null =>
      new URLSearchParams(String(u.path).split('?')[1] ?? '').get('ref');
    assert.ok(String(left.path).startsWith('intellig-git:file.ts?'), String(left.path));
    assert.ok(String(right.path).startsWith('intellig-git:file.ts?'), String(right.path));
    assert.strictEqual(refOf(left), PARENT_HASH, 'left side must be the parent');
    assert.strictEqual(refOf(right), NEW_HASH, 'right side must be the picked revision');
    assert.ok(title.includes('file.ts'), `title must name the file; got "${title}"`);
  });

  it('root commit (no parent) diffs against <hash>~1 (empty-tree side)', async () => {
    const cap = captureHandlers();
    let disposables: vscode.Disposable[] = [];

    const repo = { rootUri: vscode.Uri.file('/test/repo') } as unknown as IRepository;
    const gitService = {
      getRepository: async (): Promise<IRepository> => repo,
      getRepositories: (): IRepository[] => [repo],
      getLineHistory: async (): Promise<ICommit[]> => [makeCommit(PARENT_HASH, [])],
    };
    const blameService = {
      getBlameForLine: async (): Promise<IBlameLine> => ({
        line: 1,
        commit: PARENT_HASH,
        author: 'Alice',
        authorEmail: 'alice@example.com',
        date: new Date('2024-01-15T12:00:00Z'),
        message: 'initial',
      }),
    };
    const ctx = {
      services: { gitService, blameService },
    } as unknown as ICommandContext;

    try {
      disposables = registerBlameEditorCommands(ctx);
    } finally {
      cap.restore();
    }

    const handler = cap.handlers.get('intellig.editor.showLineHistory');
    assert.ok(handler);

    const winMut = vscode.window as unknown as {
      activeTextEditor: unknown;
      showQuickPick: unknown;
    };
    const origEditor = winMut.activeTextEditor;
    const origQuickPick = winMut.showQuickPick;
    winMut.activeTextEditor = {
      document: { uri: vscode.Uri.file('/test/repo/file.ts') },
      selection: { active: { line: 0 } },
    };
    winMut.showQuickPick = async (items: unknown[]): Promise<unknown> => items[0];

    const executed: { command: string; args: unknown[] }[] = [];
    const cmdMut = vscode.commands as unknown as { executeCommand: unknown };
    const origExecute = cmdMut.executeCommand;
    cmdMut.executeCommand = async (command: string, ...args: unknown[]): Promise<void> => {
      executed.push({ command, args });
    };

    try {
      await handler();
    } finally {
      winMut.activeTextEditor = origEditor;
      winMut.showQuickPick = origQuickPick;
      cmdMut.executeCommand = origExecute;
      disposables.forEach((d) => {
        d.dispose();
      });
    }

    const diff = executed.find((e) => e.command === 'vscode.diff');
    assert.ok(diff, 'root commit must still open a diff');
    const [left] = diff.args as [vscode.Uri];
    assert.strictEqual(
      new URLSearchParams(String(left.path).split('?')[1] ?? '').get('ref'),
      `${PARENT_HASH}~1`,
      'left side must be <hash>~1 for a root commit'
    );
  });
});

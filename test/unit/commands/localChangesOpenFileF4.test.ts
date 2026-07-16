/**
 * F4 / Jump to Source from Local Changes must open the row the user last
 * selected in the Commit Tool Window. A keybinding invocation carries no
 * argument and the CTW selection lives in a webview, so the command falls
 * back to the host-tracked last `selectFile` path (IntelliJ's F4 EditSource
 * opens the Changes-tree selection; before this wiring the gesture always
 * dead-ended in "Select a file in Local Changes first.").
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerBlameEditorCommands } from '../../../src/commands/registration/blameEditorCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';

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

describe('F4 — localChanges.openFile falls back to the tracked CTW selection', () => {
  async function invokeWithCtx(
    lastSelectedFileUri: vscode.Uri | undefined
  ): Promise<{ command: string; args: unknown[] }[]> {
    const cap = captureHandlers();
    let disposables: vscode.Disposable[] = [];
    const ctx = {
      services: {},
      commitToolWindow: lastSelectedFileUri ? { lastSelectedFileUri } : undefined,
    } as unknown as ICommandContext;
    try {
      disposables = registerBlameEditorCommands(ctx);
    } finally {
      cap.restore();
    }

    const handler = cap.handlers.get('intellig.localChanges.openFile');
    assert.ok(handler, 'intellig.localChanges.openFile must be registered');

    const executed: { command: string; args: unknown[] }[] = [];
    const cmdMut = vscode.commands as unknown as { executeCommand: unknown };
    const origExecute = cmdMut.executeCommand;
    cmdMut.executeCommand = async (command: string, ...args: unknown[]): Promise<void> => {
      executed.push({ command, args });
    };
    try {
      await handler();
    } finally {
      cmdMut.executeCommand = origExecute;
      disposables.forEach((d) => {
        d.dispose();
      });
    }
    return executed;
  }

  it('no-arg invocation opens the last CTW-selected file', async () => {
    const uri = vscode.Uri.file('/test/repo/src/a.ts');
    const executed = await invokeWithCtx(uri);
    const open = executed.find((e) => e.command === 'vscode.open');
    assert.ok(open, `F4 must open the tracked selection; executed: ${JSON.stringify(executed)}`);
    assert.strictEqual((open.args[0] as vscode.Uri).fsPath, uri.fsPath);
  });

  it('still toasts (no open) when nothing was ever selected', async () => {
    const executed = await invokeWithCtx(undefined);
    assert.ok(
      !executed.some((e) => e.command === 'vscode.open'),
      'without a tracked selection the command must not open anything'
    );
  });
});

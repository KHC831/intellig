/**
 * Drive a BranchContextMenuCommands command the way VS Code does — through
 * its REGISTERED callback — instead of reaching for a private handler.
 * Handlers migrated onto the tree-item spine scope no longer take a raw
 * clicked item (the wrapper resolves repo + target first), so suites that
 * used `invokePrivateHandler(commands, '_handleX', item)` call
 * `driveBranchMenuCommand(commands, 'intellig.branch.x', item)` and exercise
 * the full production path: wrapper contract + body.
 */

import * as vscode from 'vscode';

interface IRegisterable {
  register(context: vscode.ExtensionContext): void;
}

/**
 * Register `instance`'s commands into a private capture map (the global
 * registerCommand is restored before returning) and invoke `commandId` with
 * the given item, exactly as a context-menu click would.
 */
export async function driveBranchMenuCommand(
  instance: unknown,
  commandId: string,
  item?: unknown
): Promise<void> {
  const captured = new Map<string, (...args: unknown[]) => unknown>();
  const commandsApi = vscode.commands as unknown as { registerCommand: unknown };
  const original = commandsApi.registerCommand;
  commandsApi.registerCommand = (id: string, cb: (...args: unknown[]) => unknown) => {
    captured.set(id, cb);
    return { dispose: () => {} };
  };
  try {
    (instance as IRegisterable).register({
      subscriptions: [],
    } as unknown as vscode.ExtensionContext);
  } finally {
    commandsApi.registerCommand = original;
  }
  const handler = captured.get(commandId);
  if (!handler) {
    throw new Error(`driveBranchMenuCommand: '${commandId}' was not registered`);
  }
  await handler(item);
}

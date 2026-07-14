/**
 * Spec for src/utils/contextKeys.ts — the typed setContext seam.
 *
 * setContextKey is the single place the extension publishes VS Code context
 * keys. These specs pin: it forwards (key, value) to executeCommand for both a
 * string and a boolean key, and it resolves (never throws) when the underlying
 * command rejects — the centralized guard every call site used to repeat.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import { CONTEXT_KEYS, setContextKey } from '../../../src/utils/contextKeys';

interface SetContextCall {
  command: string;
  args: unknown[];
}

function captureExecuteCommand(opts: { reject?: unknown } = {}): {
  calls: SetContextCall[];
  restore: () => void;
} {
  const calls: SetContextCall[] = [];
  const original = vscode.commands.executeCommand;
  (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = async (
    command: string,
    ...args: unknown[]
  ): Promise<unknown> => {
    calls.push({ command, args });
    if ('reject' in opts) {
      throw opts.reject;
    }
    return undefined;
  };
  return {
    calls,
    restore: () => {
      (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = original;
    },
  };
}

describe('setContextKey', () => {
  it('forwards a string-valued key to executeCommand as (setContext, key, value)', async () => {
    const cap = captureExecuteCommand();
    try {
      await setContextKey(CONTEXT_KEYS.toolWindowActiveTab, 'log');
      assert.deepStrictEqual(cap.calls, [
        { command: 'setContext', args: ['intellig.toolWindow.activeTab', 'log'] },
      ]);
    } finally {
      cap.restore();
    }
  });

  it('forwards a boolean-valued key to executeCommand as (setContext, key, value)', async () => {
    const cap = captureExecuteCommand();
    try {
      await setContextKey(CONTEXT_KEYS.branchSearchActive, true);
      assert.deepStrictEqual(cap.calls, [
        { command: 'setContext', args: ['intellig.branchSearchActive', true] },
      ]);
    } finally {
      cap.restore();
    }
  });

  it('resolves without throwing when executeCommand rejects', async () => {
    const cap = captureExecuteCommand({ reject: new Error('commands API unavailable') });
    try {
      await assert.doesNotReject(setContextKey(CONTEXT_KEYS.conflictsActive, false));
    } finally {
      cap.restore();
    }
  });
});

/**
 * Structured push/update notifications with deep-links (Workstream C, Item 8).
 *
 * Covers the pure builders (`buildPushNotification`, `buildUpdateNotification`,
 * `focusTabDeepLink`) and `NotificationService.showStructuredResult`'s routing
 * of a selected deep-link to `vscode.commands.executeCommand`.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { __resetOutputChannelForTest } from '../../../src/utils/outputChannel';
import {
  NotificationService,
  buildPushNotification,
  buildUpdateNotification,
  focusTabDeepLink,
} from '../../../src/ui-shell/NotificationService';

describe('Structured notification builders (#C8)', () => {
  describe('focusTabDeepLink', () => {
    it('builds a focusTab deep-link for a tab', () => {
      const link = focusTabDeepLink('Show Log', 'log');
      assert.strictEqual(link.label, 'Show Log');
      assert.strictEqual(link.commandId, 'intellig.toolWindow.focusTab');
      assert.deepStrictEqual(link.commandArgs, ['log']);
    });
  });

  describe('buildPushNotification', () => {
    it('info severity + Show Log deep-link on success', () => {
      const n = buildPushNotification(true, 'Pushed main → origin');
      assert.strictEqual(n.severity, 'info');
      assert.strictEqual(n.message, 'Pushed main → origin');
      assert.deepStrictEqual(n.deepLinks?.[0], focusTabDeepLink('Show Log', 'log'));
    });
    it('error severity on failure', () => {
      const n = buildPushNotification(false, 'Push rejected (non-fast-forward)');
      assert.strictEqual(n.severity, 'error');
    });
  });

  describe('buildUpdateNotification', () => {
    it('info + Show Update Info deep-link when all clean', () => {
      const n = buildUpdateNotification(true, 'Updated 1 repository; 3 commit(s) pulled.');
      assert.strictEqual(n.severity, 'info');
      assert.deepStrictEqual(n.deepLinks?.[0], focusTabDeepLink('Show Update Info', 'updateInfo'));
    });
    it('warning severity when not all clean', () => {
      const n = buildUpdateNotification(false, 'Update finished with 1 conflict(s).');
      assert.strictEqual(n.severity, 'warning');
    });
  });
});

describe('NotificationService.showStructuredResult (#C8)', () => {
  beforeEach(() => {
    __resetOutputChannelForTest();
  });

  function stubWindow(returns: string | undefined): {
    restore: () => void;
    seen: { info: number; warning: number; error: number };
  } {
    const w = vscode.window as unknown as Record<string, unknown>;
    const orig = {
      info: w.showInformationMessage,
      warning: w.showWarningMessage,
      error: w.showErrorMessage,
    };
    const seen = { info: 0, warning: 0, error: 0 };
    w.showInformationMessage = async () => {
      seen.info += 1;
      return returns;
    };
    w.showWarningMessage = async () => {
      seen.warning += 1;
      return returns;
    };
    w.showErrorMessage = async () => {
      seen.error += 1;
      return returns;
    };
    return {
      seen,
      restore: () => {
        w.showInformationMessage = orig.info;
        w.showWarningMessage = orig.warning;
        w.showErrorMessage = orig.error;
      },
    };
  }

  function stubCommands(): { calls: Array<{ id: string; args: unknown[] }>; restore: () => void } {
    const c = vscode.commands as unknown as Record<string, unknown>;
    const orig = c.executeCommand;
    const calls: Array<{ id: string; args: unknown[] }> = [];
    c.executeCommand = async (id: string, ...args: unknown[]) => {
      calls.push({ id, args });
      return undefined;
    };
    return { calls, restore: () => (c.executeCommand = orig) };
  }

  it('routes the selected deep-link to executeCommand', async () => {
    const win = stubWindow('Show Update Info');
    const cmd = stubCommands();
    try {
      const svc = new NotificationService();
      const result = await svc.showStructuredResult(
        buildUpdateNotification(true, 'Updated 1 repository; 2 commit(s) pulled.')
      );
      assert.strictEqual(result, 'Show Update Info');
      assert.strictEqual(win.seen.info, 1, 'info toast for an all-clean update');
      assert.strictEqual(cmd.calls.length, 1);
      assert.strictEqual(cmd.calls[0].id, 'intellig.toolWindow.focusTab');
      assert.deepStrictEqual(cmd.calls[0].args, ['updateInfo']);
    } finally {
      cmd.restore();
      win.restore();
    }
  });

  it('uses a warning toast for a non-clean update and runs no command when dismissed', async () => {
    const win = stubWindow(undefined);
    const cmd = stubCommands();
    try {
      const svc = new NotificationService();
      const result = await svc.showStructuredResult(
        buildUpdateNotification(false, 'Update finished with 1 conflict(s).')
      );
      assert.strictEqual(result, undefined);
      assert.strictEqual(win.seen.warning, 1, 'warning toast for a non-clean update');
      assert.strictEqual(cmd.calls.length, 0, 'dismissed toast runs no command');
    } finally {
      cmd.restore();
      win.restore();
    }
  });

  it('uses an error toast for a failed push', async () => {
    const win = stubWindow(undefined);
    const cmd = stubCommands();
    try {
      const svc = new NotificationService();
      await svc.showStructuredResult(buildPushNotification(false, 'Push rejected'));
      assert.strictEqual(win.seen.error, 1);
    } finally {
      cmd.restore();
      win.restore();
    }
  });
});

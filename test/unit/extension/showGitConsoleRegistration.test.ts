/**
 * `intellig.showGitConsole` must exist whenever the palette shows it: the
 * command registers unconditionally and resolves its services at invocation
 * time, so a services-init failure yields the OutputChannel fallback instead
 * of a raw "command not found".
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerShowGitConsoleCommand } from '../../../src/registration/registerViews';
import type { IViewRegistrationContext } from '../../../src/registration/ViewRegistrationContext';

type Handler = (...args: unknown[]) => unknown;

function captureRegistrations(): {
  ids: string[];
  handlers: Map<string, Handler>;
  restore(): void;
} {
  const ids: string[] = [];
  const handlers = new Map<string, Handler>();
  const commands = vscode.commands as unknown as {
    registerCommand: (id: string, cb: Handler) => { dispose(): void };
  };
  const original = commands.registerCommand;
  commands.registerCommand = (id: string, cb: Handler): { dispose(): void } => {
    ids.push(id);
    handlers.set(id, cb);
    return { dispose: (): void => {} };
  };
  return {
    ids,
    handlers,
    restore: (): void => {
      commands.registerCommand = original;
    },
  };
}

function makeCtx(over: {
  services?: unknown;
  provider?: unknown;
}): IViewRegistrationContext & { subscriptions: unknown[] } {
  const subscriptions: unknown[] = [];
  return {
    context: { subscriptions } as unknown,
    services: over.services,
    gitToolWindowProvider: over.provider,
    subscriptions,
  } as unknown as IViewRegistrationContext & { subscriptions: unknown[] };
}

describe('intellig.showGitConsole registration', () => {
  it('registers even when services are unavailable, routing to the tool window Console tab', async () => {
    const reg = captureRegistrations();
    try {
      const focused: string[] = [];
      const provider = {
        revealLogHost: async (): Promise<void> => {
          focused.push('reveal');
        },
        focusTab: async (tab: string): Promise<void> => {
          focused.push(tab);
        },
      };
      const ctx = makeCtx({ services: undefined, provider });
      registerShowGitConsoleCommand(ctx);
      assert.ok(reg.ids.includes('intellig.showGitConsole'), 'registered without services');
      await reg.handlers.get('intellig.showGitConsole')?.();
      assert.deepStrictEqual(focused, ['reveal', 'console']);
    } finally {
      reg.restore();
    }
  });

  it('resolves the console service at invocation time (fallback when no provider)', async () => {
    const reg = captureRegistrations();
    try {
      let shown = 0;
      const ctx = makeCtx({ services: undefined, provider: undefined });
      registerShowGitConsoleCommand(ctx);
      // Services arrive AFTER registration — the handler must still see them.
      (ctx as unknown as { services: unknown }).services = {
        consoleService: {
          showConsole: (): void => {
            shown += 1;
          },
        },
      };
      await reg.handlers.get('intellig.showGitConsole')?.();
      assert.strictEqual(shown, 1, 'late-arriving consoleService is used as the fallback');
    } finally {
      reg.restore();
    }
  });

  it('degrades to a no-op (no throw) with neither provider nor services', async () => {
    const reg = captureRegistrations();
    try {
      const ctx = makeCtx({ services: undefined, provider: undefined });
      registerShowGitConsoleCommand(ctx);
      await reg.handlers.get('intellig.showGitConsole')?.();
    } finally {
      reg.restore();
    }
  });
});

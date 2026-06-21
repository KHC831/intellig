/**
 * Tests for the invocation/error logging that `registerLoggedCommand`
 * emits around every command handler.
 *
 * Background: before this layer was added, command handlers that swallowed
 * failures (returned a failure shape from a Promise instead of throwing)
 * left no trace in the IntelliG OutputChannel. The user's example was
 * "Rebase Current onto This" with a dirty working tree — no toast, no log,
 * the click looked unreceived.
 *
 * `registerLoggedCommand` now emits:
 *   - debug "command invoked"   on every call
 *   - debug "command resolved"  on success (sync or async)
 *   - warn  "command handler rejected" on Promise rejection
 *   - warn  "command handler threw synchronously" on sync throw
 *
 * All four records run inside the correlation frame so they pick up
 * `commandId` and `correlationId` automatically.
 */

import '../../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';

import {
  __resetLoggerForTest,
  initLogger,
  registerLoggedCommand,
} from '../../../../src/utils/logger';
import { __resetCorrelationStoreForTest } from '../../../../src/utils/logger/correlation';
import {
  __resetOutputChannelForTest,
  getOutputChannel,
  initOutputChannel,
} from '../../../../src/utils/outputChannel';

/** Minimal ExtensionContext stub — only `subscriptions` is exercised. */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return { subscriptions } as unknown as vscode.ExtensionContext;
}

/** Reset all module-level singletons between tests. */
function resetAll(): void {
  __resetLoggerForTest();
  __resetOutputChannelForTest();
  __resetCorrelationStoreForTest();
}

/**
 * Wire a fresh activation sequence (matches `extension.ts` ordering).
 *
 * Bumps `intellig.log.level` to `debug` BEFORE `initLogger` runs so the
 * resolver picks up the value on its first `refresh()` call. Default is
 * `info` and would filter out the invocation/resolved records.
 *
 * The production read path is `getConfiguration('intellig').get('log.level')`,
 * so we set the value through the same scope rather than the
 * `intellig.log` sub-section.
 */
async function freshActivation(): Promise<void> {
  resetAll();
  await vscode.workspace
    .getConfiguration('intellig')
    .update('log.level', 'debug', vscode.ConfigurationTarget.Global);
  const ctx = makeFakeContext();
  initOutputChannel(ctx);
  initLogger(ctx);
}

/**
 * Drop the `intellig.log.level=debug` override so subsequent tests in the
 * suite (and other suites) start from the schema default.
 */
async function clearLogLevelOverride(): Promise<void> {
  await vscode.workspace
    .getConfiguration('intellig')
    .update('log.level', undefined, vscode.ConfigurationTarget.Global);
}

/**
 * Read every line the OutputChannel sink wrote since the last reset.
 * The mock from `test/mocks/vscode.ts` exposes `_lines` on the
 * channel; the production sink writes one record per `appendLine`.
 */
function getCapturedLines(): string[] {
  return (getOutputChannel() as unknown as { _lines: string[] })._lines;
}

/**
 * Patch `vscode.commands.registerCommand` to capture the wrapper
 * callback (the mock doesn't retain callbacks by default). Mirrors the
 * pattern in `test/property/loggerCorrelation.property.test.ts`.
 */
function patchRegisterCommand(): {
  registered: Map<string, (...args: unknown[]) => unknown>;
  restore: () => void;
} {
  const registered = new Map<string, (...args: unknown[]) => unknown>();
  const original = vscode.commands.registerCommand;
  (
    vscode.commands as unknown as {
      registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => { dispose: () => void };
    }
  ).registerCommand = (id, cb) => {
    registered.set(id, cb);
    return {
      dispose: (): void => {
        registered.delete(id);
      },
    };
  };
  return {
    registered,
    restore: (): void => {
      (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = original;
    },
  };
}

describe('registerLoggedCommand — invocation and rejection logging', () => {
  beforeEach(() => {
    resetAll();
  });

  afterEach(async () => {
    resetAll();
    await clearLogLevelOverride();
  });

  it('emits a "command invoked" record for every command call', async () => {
    await freshActivation();
    const patch = patchRegisterCommand();
    try {
      registerLoggedCommand('intellig.test.invoke', () => 'ok');

      const callback = patch.registered.get('intellig.test.invoke');
      assert.ok(callback, 'wrapper callback must be registered');
      callback();

      const lines = getCapturedLines();
      const invokedLine = lines.find((l) => l.includes('command invoked'));
      assert.ok(
        invokedLine,
        `expected a "command invoked" line in OutputChannel, got: ${JSON.stringify(lines, null, 2)}`
      );
      assert.ok(
        invokedLine?.includes('intellig.test.invoke'),
        `"command invoked" line should reference the commandId, got: "${invokedLine}"`
      );
    } finally {
      patch.restore();
    }
  });

  it('emits a "command resolved" record on successful sync return', async () => {
    await freshActivation();
    const patch = patchRegisterCommand();
    try {
      registerLoggedCommand('intellig.test.syncOk', () => 42);

      const callback = patch.registered.get('intellig.test.syncOk');
      assert.ok(callback);
      const result = callback();

      assert.strictEqual(result, 42, 'wrapper must preserve the handler return value');

      const lines = getCapturedLines();
      assert.ok(
        lines.some((l) => l.includes('command resolved')),
        `expected a "command resolved" line, got: ${JSON.stringify(lines)}`
      );
    } finally {
      patch.restore();
    }
  });

  it('emits a "command resolved" record on successful async resolve', async () => {
    await freshActivation();
    const patch = patchRegisterCommand();
    try {
      registerLoggedCommand('intellig.test.asyncOk', () => Promise.resolve('done'));

      const callback = patch.registered.get('intellig.test.asyncOk');
      assert.ok(callback);
      const result = await (callback() as Promise<string>);

      assert.strictEqual(result, 'done');

      const lines = getCapturedLines();
      assert.ok(
        lines.some((l) => l.includes('command resolved')),
        `expected a "command resolved" line for async success, got: ${JSON.stringify(lines)}`
      );
    } finally {
      patch.restore();
    }
  });

  it('emits a warn "command handler rejected" record when the handler rejects', async () => {
    await freshActivation();
    const patch = patchRegisterCommand();
    try {
      registerLoggedCommand('intellig.test.asyncFail', () =>
        Promise.reject(new Error('boom from handler'))
      );

      const callback = patch.registered.get('intellig.test.asyncFail');
      assert.ok(callback);

      await assert.rejects(
        callback() as Promise<unknown>,
        /boom from handler/,
        'wrapper must re-throw — VS Code surfaces command rejections itself'
      );

      const lines = getCapturedLines();
      const rejectionLine = lines.find((l) => l.includes('command handler rejected'));
      assert.ok(
        rejectionLine,
        `expected a "command handler rejected" line in OutputChannel, got: ${JSON.stringify(lines, null, 2)}`
      );
      assert.ok(
        rejectionLine?.includes('boom from handler'),
        `rejection line should include the error message, got: "${rejectionLine}"`
      );
      assert.ok(
        rejectionLine?.includes('intellig.test.asyncFail'),
        `rejection line should reference the commandId, got: "${rejectionLine}"`
      );
    } finally {
      patch.restore();
    }
  });

  it('emits a warn "command handler threw synchronously" record when the handler throws', async () => {
    await freshActivation();
    const patch = patchRegisterCommand();
    try {
      registerLoggedCommand('intellig.test.syncFail', () => {
        throw new Error('sync boom');
      });

      const callback = patch.registered.get('intellig.test.syncFail');
      assert.ok(callback);

      assert.throws(() => callback(), /sync boom/);

      const lines = getCapturedLines();
      const throwLine = lines.find((l) => l.includes('command handler threw synchronously'));
      assert.ok(
        throwLine,
        `expected a "command handler threw synchronously" line, got: ${JSON.stringify(lines, null, 2)}`
      );
      assert.ok(
        throwLine?.includes('sync boom'),
        `synchronous-throw line should include the error message, got: "${throwLine}"`
      );
    } finally {
      patch.restore();
    }
  });

  it('preserves the handler return value verbatim (regression: wrapper must not swallow values)', async () => {
    await freshActivation();
    const patch = patchRegisterCommand();
    try {
      const sentinel = { keepMe: true };
      registerLoggedCommand('intellig.test.sentinel', () => sentinel);

      const callback = patch.registered.get('intellig.test.sentinel');
      assert.ok(callback);
      assert.strictEqual(callback(), sentinel);
    } finally {
      patch.restore();
    }
  });
});

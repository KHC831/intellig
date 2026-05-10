/**
 * Property tests for the Resolve Conflicts dialog message router.
 *
 * Invariant: For any valid incoming message payload, exactly one handler runs
 * — no double-dispatch, no missed handler. Each message type must map to a
 * single observable side effect.
 *
 * Design spec: `.agent/designs/cluster-C-tool-windows.md` §5.4 (message
 * protocol).
 */

/*
 * Stub factories synthesise IGitService / IMergeView / IConflictResolutionService
 * implementations whose member signatures return `Promise<T>`; no-await stub
 * bodies are intentional here.
 */

import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';
import { ResolveConflictsDialog } from '../../services/ResolveConflictsDialog';
import type { IConflictOpContext } from '../../services/interfaces/IConflictResolutionService';
import type { IMergeView } from '../../services/interfaces/IMergeView';
import type { IGitService, IRepository } from '../../services/interfaces/IGitService';
import type { IConflictResolutionService } from '../../services/interfaces/IConflictResolutionService';

/**
 * Make a context, repo, and dependencies for the property runner. Each fuzz
 * iteration rebuilds the dialog so assertions start from a clean slate.
 */
function makeDialog(messages: {
  count: (key: string) => number;
  record: (key: string) => void;
}): ResolveConflictsDialog {
  const ctx = {
    subscriptions: [],
    extensionUri: vscode.Uri.file('/tmp/ext'),
  } as unknown as vscode.ExtensionContext;

  const repo: IRepository = {
    rootUri: vscode.Uri.file('/tmp/repo'),
    state: 'idle',
    remotes: [],
    submodules: [],
  } as unknown as IRepository;

  const conflictService = {
    acceptCurrent: async () => {
      messages.record('acceptCurrent');
      return { success: true };
    },
    acceptIncoming: async () => {
      messages.record('acceptIncoming');
      return { success: true };
    },
  } as unknown as IConflictResolutionService;

  const mergeView = {
    show: async () => {
      messages.record('mergeView.show');
    },
    onDidResolve: new vscode.EventEmitter<string>().event,
  } as unknown as IMergeView;

  const gitService = {
    gitCli: {
      exec: async (args: string[]) => {
        messages.record('gitCli.exec:' + args[0]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    cherryPickAbort: async () => {
      messages.record('cherryPickAbort');
    },
    cherryPickContinue: async () => {
      messages.record('cherryPickContinue');
      return { success: true };
    },
    revertAbort: async () => {
      messages.record('revertAbort');
    },
    revertContinue: async () => {
      messages.record('revertContinue');
      return { success: true };
    },
  } as unknown as IGitService;

  const opCtx: IConflictOpContext = {
    operation: 'merge',
    canAbort: true,
    canContinue: true,
  };

  return new ResolveConflictsDialog(
    ctx,
    repo,
    [{ path: 'a.ts', resolved: true }], // pre-resolved so `continue` is allowed
    opCtx,
    conflictService,
    mergeView,
    gitService
  );
}

/**
 * Tracks invocation counts per named "key" (one key per service method).
 */
function makeTracker(): {
  count: (key: string) => number;
  record: (key: string) => void;
  total: () => number;
  reset: () => void;
} {
  const counts = new Map<string, number>();
  return {
    count: (key: string) => counts.get(key) ?? 0,
    record: (key: string) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    total: () => {
      let s = 0;
      for (const v of counts.values()) {
        s += v;
      }
      return s;
    },
    reset: () => counts.clear(),
  };
}

/**
 * fast-check arbitrary covering every valid webview→host message shape.
 */
const messageArb = fc.oneof(
  fc.record({ type: fc.constant('acceptYours'), path: fc.string({ minLength: 1 }) }),
  fc.record({ type: fc.constant('acceptTheirs'), path: fc.string({ minLength: 1 }) }),
  fc.record({ type: fc.constant('openMergeView'), path: fc.string({ minLength: 1 }) }),
  fc.record({ type: fc.constant('abort') }),
  fc.record({ type: fc.constant('continue') })
);

describe('property: ResolveConflictsDialog router — exactly one dispatch per valid message', () => {
  it('exactly one observable handler fires per valid message', async () => {
    await fc.assert(
      fc.asyncProperty(messageArb, async (message) => {
        const tracker = makeTracker();
        const dialog = makeDialog(tracker);
        try {
          tracker.reset();
          await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage(
            message
          );

          // Exactly one handler runs per valid message.
          const n = tracker.total();
          assert.strictEqual(
            n,
            1,
            `exactly one dispatch expected for type=${message.type}, got ${n}`
          );
        } finally {
          dialog.dispose();
        }
      }),
      { numRuns: 100 }
    );
  });

  it('malformed/unknown messages are silently dropped (no dispatch)', async () => {
    const tracker = makeTracker();
    const dialog = makeDialog(tracker);
    try {
      await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage(null);
      await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({});
      await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
        type: 'unknownOp',
      });
      await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage(
        'string-not-object'
      );

      assert.strictEqual(tracker.total(), 0, 'unknown/malformed messages must not dispatch');
    } finally {
      dialog.dispose();
    }
  });
});

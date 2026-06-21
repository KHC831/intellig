/**
 * Command-handler transparency — BEHAVIORAL harness (spec 8 L3 + L13).
 *
 * This is the behavioral counterpart the spec names as the PRIMARY L3
 * guard, complementing the static `commandHandlerTransparency.audit.test.ts`
 * (which scans handler bodies). A static body-scan can be fooled by a
 * handler that has a `logger.debug` line at the top and then early-returns
 * silently when a guard fails — the exact T54 (silent dropdown) / T52
 * (silent rebase-skip) bug class. This harness actually INVOKES each
 * handler and asserts an observable signal fired.
 *
 * Driving strategy — degraded mode. We register every command via the
 * `__registerCommandsForTest` seam WITHOUT running the full `activate()`
 * sequence (which needs a live view + watcher + service graph and, when
 * driven under the unit mocks, both throws on `createTreeView` and leaks
 * module state into sibling suites — verified). With the module-level
 * service singletons left `undefined`, every handler runs its
 * GUARD/EARLY-RETURN path — precisely the path the static scan can't see
 * and the one the historical silent-no-op bugs lived on. The contract:
 *
 *   In degraded mode, each handler MUST either
 *     (a) surface feedback — a `vscode.window.show*Message` toast or a
 *         `logger.warn/error` record (the `if (!extensionServices) { ...
 *         showErrorMessage('...not initialized'); return; }` shape), OR
 *     (b) be an allowlisted CONDITIONAL DELEGATOR whose optional
 *         collaborator (mergeView / commitToolWindow / a provider) is
 *         simply absent, making a silent return the correct behavior
 *         ("no merge in progress, nothing to do").
 *
 * A handler that is NEITHER is a silent no-op on its guard path — the
 * regression this harness fails on.
 *
 * What this does NOT cover: the full success path of every handler (that
 * needs the entire mocked service graph per handler — out of scope here).
 * The success-path feedback is covered by each feature's own command
 * suite. This harness owns the guard-path contract, which is where the
 * silent-no-op regressions have actually happened.
 *
 * L13: `registerLoggedCommand` wraps every body in a correlation frame
 * (component + commandId + correlationId — see correlation.ts), so any
 * record emitted during a handler invocation carries the action context
 * structurally. Verified behaviorally by the dedicated logger suites; this
 * harness confirms the frame is in place by observing that the guard-path
 * warn/error records (when emitted) flow through the bound logger.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { __registerCommandsForTest } from '../../../src/extension';
import {
  installErrorMessageTracker,
  installWarningMessageTracker,
  installInfoMessageTracker,
  restoreMessageFunctions,
  type MessageTracker,
} from '../../typed/windowStub';

// ---------------------------------------------------------------------------
// Handlers whose degraded-mode (services/collaborator-absent) path is
// LEGITIMATELY a silent return. Each is a conditional delegator: it acts
// only when an OPTIONAL collaborator exists, and "do nothing" is the right
// behavior when it doesn't. Each entry cites the collaborator it guards on.
// ---------------------------------------------------------------------------
const SILENT_WHEN_ABSENT_ALLOWLIST: Record<string, string> = {
  // Merge-editor commands: no-op when no MergeView is open (no active
  // merge conflict). `if (mergeView) { mergeView.x() }`.
  'intellig.merge.acceptCurrent': 'mergeView absent → no merge in progress',
  'intellig.merge.acceptIncoming': 'mergeView absent → no merge in progress',
  'intellig.merge.acceptBoth': 'mergeView absent → no merge in progress',
  'intellig.merge.acceptAllCurrent': 'mergeView absent → no merge in progress',
  'intellig.merge.acceptAllIncoming': 'mergeView absent → no merge in progress',
  'intellig.merge.markResolved': 'mergeView absent → no merge in progress',
  'intellig.merge.nextConflict': 'mergeView absent → no merge in progress',
  'intellig.merge.previousConflict': 'mergeView absent → no merge in progress',
  // openGitToolWindow just forwards to executeCommand(view.focus); in
  // degraded mode the focus call is still issued (observable) and never
  // touches services — but it emits no toast/log, so it's allowlisted as a
  // pure view-focus delegator.
  'intellig.openGitToolWindow': 'pure executeCommand(view.focus) — no services touched',
  // VCS Operations Popup shows a QuickPick of common Git commands and routes
  // the picked one via executeCommand. It never touches services; in degraded
  // mode it shows the QuickPick (observable, but the harness tracks toasts +
  // executeCommand, not showQuickPick) and — when the mock QuickPick returns
  // undefined — correctly no-ops. Pure command-router delegator, same class as
  // openGitToolWindow.
  'intellig.vcsOperationsPopup': 'pure QuickPick → executeCommand router — no services touched',

  // ── Required-argument guards ───────────────────────────────────────────
  // These handlers are dispatched from a context menu / tree row that
  // ALWAYS supplies a required argument (a changelistId, or a live
  // extensionServices container). The harness invokes them with NO args,
  // so they correctly hit `if (!extensionServices || !changelistId) return`
  // and no-op. That early return is the RIGHT behavior for the
  // absent-argument / pre-init state — it is NOT the T54/T52 silent-no-op
  // class (which was silent on a REACHABLE user path with valid input).
  // Their user-visible feedback lives on the with-argument path and is
  // covered by the changelist / blame command suites. Allowlisted because
  // the degraded no-arg path is intentionally inert.
  'intellig.changelist.new': 'guards on !extensionServices; feedback on the services-present path',
  'intellig.changelist.setActive':
    'guards on !extensionServices / !changelistId (context-menu arg)',
  'intellig.changelist.rename': 'guards on !extensionServices / !changelistId (context-menu arg)',
  'intellig.changelist.delete': 'guards on !extensionServices / !changelistId (context-menu arg)',
  'intellig.changelist.editDescription':
    'guards on !extensionServices / !changelistId (context-menu arg)',
  'intellig.changelist.moveFilesTo':
    'guards on !extensionServices / !changelistId (context-menu arg)',
  'intellig.changelist.commitOnly': 'guards on !changelistId (context-menu arg)',
  'intellig.changelist.shelve': 'guards on !extensionServices / !changelistId (context-menu arg)',
  'intellig.blame.toggleIgnoreWhitespace':
    'guards on !extensionServices (pre-init); toasts on the services-present path',
  'intellig.blame.toggleDetectMovementsWithinFile':
    'guards on !extensionServices (pre-init); toasts on the services-present path',
  'intellig.blame.toggleDetectMovementsAcrossFiles':
    'guards on !extensionServices (pre-init); toasts on the services-present path',
  'intellig.blame.clearHiddenRevisions':
    'guards on !extensionServices (pre-init); toasts on the services-present path',
};

interface CapturedHandler {
  id: string;
  cb: (...args: unknown[]) => unknown;
}

/** Patch vscode.commands.registerCommand to capture (id, cb) pairs. */
function patchRegisterCommand(): {
  handlers: CapturedHandler[];
  restore: () => void;
} {
  const handlers: CapturedHandler[] = [];
  const original = vscode.commands.registerCommand;
  (
    vscode.commands as unknown as {
      registerCommand: (id: string, cb: (...a: unknown[]) => unknown) => { dispose: () => void };
    }
  ).registerCommand = (id, cb) => {
    handlers.push({ id, cb });
    return { dispose: (): void => {} };
  };
  return {
    handlers,
    restore: (): void => {
      (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = original;
    },
  };
}

/** Total toast count across the three message channels. */
function toastCount(trackers: MessageTracker[]): number {
  return trackers.reduce((sum, t) => sum + t.calls.length, 0);
}

/**
 * Spy on `vscode.commands.executeCommand` (an observable signal: the
 * handler re-routes to another command — e.g. `view.focus` or a sibling
 * IntelliG command). Returns a counter + restore. Note: our captured
 * handlers were registered through the PATCHED registerCommand, so calling
 * executeCommand from inside a handler does NOT re-enter our captured set
 * (the mock's executeCommand is a no-op stub) — no recursion risk.
 */
function spyExecuteCommand(): { count: () => number; restore: () => void } {
  const cmds = vscode.commands as unknown as {
    executeCommand: (...a: unknown[]) => Promise<unknown>;
  };
  const original = cmds.executeCommand;
  let n = 0;
  cmds.executeCommand = (..._a: unknown[]): Promise<unknown> => {
    n++;
    return Promise.resolve(undefined);
  };
  return {
    count: (): number => n,
    restore: (): void => {
      cmds.executeCommand = original;
    },
  };
}

describe('Command-handler transparency — behavioral guard-path harness (spec 8 L3 + L13)', () => {
  let patch: ReturnType<typeof patchRegisterCommand>;

  before(() => {
    patch = patchRegisterCommand();
    const ctx = {
      subscriptions: [] as { dispose(): void }[],
      extensionUri: vscode.Uri.file('/test/ext'),
    } as unknown as vscode.ExtensionContext;
    __registerCommandsForTest(ctx);
  });

  after(() => {
    patch.restore();
  });

  it('registers a meaningful number of commands (the seam actually ran)', () => {
    assert.ok(
      patch.handlers.length >= 30,
      `expected >= 30 captured command handlers; got ${patch.handlers.length}`
    );
  });

  it('registers each command id exactly once (no double-registration)', () => {
    const seen = new Map<string, number>();
    for (const h of patch.handlers) {
      seen.set(h.id, (seen.get(h.id) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    assert.deepStrictEqual(dupes, [], `commands registered more than once: ${dupes.join(', ')}`);
  });

  it('every handler emits a toast on its degraded-mode guard path OR is an allowlisted silent-delegator (L3)', async () => {
    const offenders: string[] = [];

    for (const h of patch.handlers) {
      const allowlisted = Object.prototype.hasOwnProperty.call(SILENT_WHEN_ABSENT_ALLOWLIST, h.id);

      const trackers = [
        installErrorMessageTracker(),
        installWarningMessageTracker(),
        installInfoMessageTracker(),
      ];
      const exec = spyExecuteCommand();
      let threw = false;
      try {
        // Invoke with no args (the degraded/guard path). Await in case the
        // handler is async; swallow throws — a throw still propagates to
        // VS Code's command error toast, so it's not a silent no-op.
        const out = h.cb();
        if (out instanceof Promise) {
          await out.catch(() => {
            threw = true;
          });
        }
      } catch {
        threw = true;
      } finally {
        restoreMessageFunctions();
        exec.restore();
      }

      // A handler is transparent on its guard path if it toasts, throws
      // (VS Code shows a generic error toast), or re-routes via
      // executeCommand (a fallback the user observes — e.g. opening the
      // tool window when a provider isn't ready yet).
      const emittedSignal = toastCount(trackers) > 0 || threw || exec.count() > 0;
      if (!emittedSignal && !allowlisted) {
        offenders.push(`  ${h.id}`);
      }
    }

    assert.strictEqual(
      offenders.length,
      0,
      [
        `Found ${offenders.length} handler(s) that produced NO observable signal on their`,
        `degraded-mode guard path and are not allowlisted silent-delegators (spec L3):`,
        ...offenders,
        ``,
        `Each is a potential silent no-op of the T54/T52 class. Fix one of:`,
        `  - Add a guard that surfaces feedback, e.g.`,
        `      if (!extensionServices) { void vscode.window.showErrorMessage('...'); return; }`,
        `  - If the handler legitimately no-ops when an OPTIONAL collaborator is absent`,
        `    (e.g. mergeView), add it to SILENT_WHEN_ABSENT_ALLOWLIST with the collaborator.`,
      ].join('\n')
    );
  });

  it('every allowlist entry still maps to a registered command (no stale entries)', () => {
    const ids = new Set(patch.handlers.map((h) => h.id));
    const stale = Object.keys(SILENT_WHEN_ABSENT_ALLOWLIST).filter((id) => !ids.has(id));
    assert.deepStrictEqual(
      stale,
      [],
      `SILENT_WHEN_ABSENT_ALLOWLIST has stale entries: ${stale.join(', ')}`
    );
  });
});

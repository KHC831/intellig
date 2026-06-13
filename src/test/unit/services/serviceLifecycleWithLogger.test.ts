/**
 * Service-lifecycle Logger waypoints (§6.3, §6.4 not
 * covered elsewhere).
 *
 * Pins the Logger waypoints required for
 * the long-lived services that the §6.1 GitService test does
 * not cover. The §6.5 ConfigurationService change-key waypoint is
 * already covered by `configurationServiceChangeKeys.property.test.ts`,
 * and the §6.6 extension activate/deactivate path is covered by
 * `src/test/ext-host/suite/09.logger-activation.test.ts`.
 *
 * Specifically asserted here:
 *
 *   §6.3 — BlameService, ChangelistService, ShelfService,
 *          AutoFetchService, ConflictResolutionService, PatchService
 *          each emit one info-level Log_Record on construction and
 *          one info-level Log_Record on `dispose()`.
 *
 *   §6.4 — BranchTreeProvider emits one debug-level Log_Record on
 *          each `refresh()` trigger. (The complementary warn-level
 *          waypoint on `getChildren()` failure paths through the
 *          existing `BranchTreeProvider.test.ts` tree-construction
 *          tests; this file does not duplicate it.)
 *
 * ### Approach
 *
 * Each test:
 *   1. Resets the Logger and OutputChannel singletons so prior tests
 *      cannot leak captured lines.
 *   2. Sets `intellig.log.level = 'trace'` BEFORE `initLogger(ctx)` so
 *      every level (info, debug) is admitted by the
 *      `OutputChannelSink`.
 *   3. Wires the production sinks against the stubbed `IntelliG`
 *      channel from `src/test/mocks/vscode.ts`.
 *   4. Constructs the service under test with a minimal mock
 *      collaborator, then disposes it. The mock channel's `_lines`
 *      array captures each rendered block.
 *   5. Parses the captured blocks with `parseRecord` (the inverse of
 *      `formatRecord` exported from `src/utils/logger/render.ts`)
 *      and asserts level, component, and message.
 *
 * Capture pattern is the same as `sanitizerFallback.test.ts` and the
 * other logger unit tests under `src/test/unit/utils/logger/`.
 *
 * ### What is intentionally NOT asserted
 *
 * - The exact `context` payload shape on construction/dispose records
 *   (e.g. `ownsGitCli` for BlameService/ShelfService,
 *   `cacheEntries`/`watchers` for BlameService dispose, etc.). The
 *   §6.3 contract pins the *level* and *fact of emission*; the context
 *   keys are an implementation detail of each service. Asserting them
 *   here would over-couple this test to the §9.x integration sweep.
 * - The §6.4 refresh-failure warn waypoint: `BranchTreeProvider.test.ts`
 *   already exercises the failing-getChildren path through the
 *   tree-construction surface; duplicating it here would add no signal.
 *
 */

import '../../setup';

import * as assert from 'assert';
import * as vscode from 'vscode';

import { AutoFetchService } from '../../../sync/AutoFetchService';
import { BlameService } from '../../../blame/BlameService';
import { BranchTreeProvider } from '../../../branches/BranchTreeProvider';
import { ChangelistService } from '../../../changelists/ChangelistService';
import { ConflictResolutionService } from '../../../conflicts/ConflictResolutionService';
import { PatchService } from '../../../patches/PatchService';
import { ShelfService } from '../../../shelf/ShelfService';
import { __resetLoggerForTest, initLogger } from '../../../utils/logger';
import { parseRecord } from '../../../utils/logger/render';
import {
  __resetOutputChannelForTest,
  getOutputChannel,
  initOutputChannel,
} from '../../../utils/outputChannel';
import { attachedRepo, createMockGitService } from '../../mocks/mockGitService';
import {
  ConfigurationTarget,
  resetMockConfiguration,
  setMockConfigValue,
} from '../../mocks/vscode';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Minimal `ExtensionContext` stub used by `initOutputChannel` and
 * `initLogger`. Only `subscriptions` is exercised.
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return { subscriptions } as unknown as vscode.ExtensionContext;
}

/**
 * Snapshot the lines appended to the cached `IntelliG` OutputChannel.
 * The mock from `src/test/mocks/vscode.ts` exposes `_lines` on every
 * channel instance; the production `OutputChannelSink` writes through
 * `outputChannel.appendLine`, so each rendered block lands as one
 * entry.
 */
function captureLines(): string[] {
  return [...(getOutputChannel() as unknown as { _lines: string[] })._lines];
}

/**
 * Reassemble a single record's rendered block from the captured-lines
 * array. The mock stores each `appendLine` argument as its own entry,
 * so a record with N continuation lines spans `N+1` adjacent entries.
 * Walk forward from `headerIndex` accumulating lines until we hit a
 * line that does not start with the two-space continuation indent —
 * that line is the next record's header (or the end of the stream).
 */
function reassembleBlock(lines: readonly string[], headerIndex: number): string {
  const collected: string[] = [lines[headerIndex]];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith('  ')) {
      collected.push(lines[i]);
    } else {
      break;
    }
  }
  return collected.join('\n');
}

/**
 * Find the index in `lines` of the FIRST header line whose component
 * + message both match the supplied predicates. Returns -1 when no
 * matching record was emitted.
 *
 * We match on substring rather than parsing every line because most
 * lines in the captured array are non-header (continuation) lines
 * that would fail `parseRecord`. The "[…] LEVEL component: message"
 * shape is unambiguous so a substring scan plus the subsequent
 * `parseRecord(reassembleBlock(...))` round-trip catches every
 * regression that matters.
 */
function findRecord(lines: readonly string[], componentName: string, message: string): number {
  const needle = `${componentName}: ${message}`;
  for (let i = 0; i < lines.length; i++) {
    // Header lines have the shape `[ts] LEVEL  component: message`.
    // We test for the `component: message` suffix and a leading `[`
    // to skip continuation lines that happen to mention the
    // component inside a `ctx=` JSON blob.
    if (lines[i].startsWith('[') && lines[i].includes(needle)) {
      return i;
    }
  }
  return -1;
}

/**
 * End-to-end reset routine. Order matters: drop the Logger first so
 * sinks detach before the channel reset wipes the mock's `_lines`
 * buffer; clear the mock workspace configuration last.
 */
function fullReset(): void {
  __resetLoggerForTest();
  __resetOutputChannelForTest();
  resetMockConfiguration();
}

/**
 * Set the log threshold to `'trace'` BEFORE `initLogger` runs so the
 * resolver picks the value up on its initial refresh and admits every
 * level.
 */
function pinTraceLevel(): void {
  setMockConfigValue('intellig', 'log.level', 'trace', ConfigurationTarget.Global);
}

/**
 * Wire the production OutputChannel + Logger sinks against the mock
 * channel. Returns the `ExtensionContext` stub (the caller never needs
 * it but tests sometimes assert against `subscriptions`).
 */
function initLoggerWiring(): vscode.ExtensionContext {
  const ctx = makeFakeContext();
  initOutputChannel(ctx);
  initLogger(ctx);
  return ctx;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('service lifecycle Logger waypoints', () => {
  beforeEach(() => {
    fullReset();
    pinTraceLevel();
    initLoggerWiring();
  });

  afterEach(() => {
    fullReset();
  });

  describe('info on construction and dispose', () => {
    it('BlameService emits info on construction and on dispose()', () => {
      const baseline = captureLines().length;
      const gitService = createMockGitService(attachedRepo());
      const svc = new BlameService(undefined, gitService);

      const afterCtor = captureLines();
      const ctorIdx = findRecord(afterCtor, 'BlameService', 'BlameService constructed');
      assert.notStrictEqual(
        ctorIdx,
        -1,
        `expected BlameService constructor to emit an info-level record; ` +
          `captured lines: ${JSON.stringify(afterCtor.slice(baseline))}`
      );
      const ctorRecord = parseRecord(reassembleBlock(afterCtor, ctorIdx));
      assert.strictEqual(
        ctorRecord.level,
        'info',
        `expected info level for BlameService construction record; got ${ctorRecord.level}`
      );
      assert.strictEqual(ctorRecord.component, 'BlameService');

      // Dispose and assert the matching disposing record.
      const beforeDispose = captureLines().length;
      svc.dispose();
      const afterDispose = captureLines();
      const disposeIdx = findRecord(
        afterDispose.slice(beforeDispose),
        'BlameService',
        'BlameService disposing'
      );
      assert.notStrictEqual(
        disposeIdx,
        -1,
        `expected BlameService.dispose() to emit an info-level record; ` +
          `lines emitted during dispose: ${JSON.stringify(afterDispose.slice(beforeDispose))}`
      );
      const disposeRecord = parseRecord(
        reassembleBlock(afterDispose.slice(beforeDispose), disposeIdx)
      );
      assert.strictEqual(disposeRecord.level, 'info');
      assert.strictEqual(disposeRecord.component, 'BlameService');
    });

    it('ChangelistService emits info on construction and on dispose()', () => {
      const gitService = createMockGitService(attachedRepo());
      const beforeCtor = captureLines().length;
      const svc = new ChangelistService(gitService);

      const afterCtor = captureLines();
      const ctorIdx = findRecord(
        afterCtor.slice(beforeCtor),
        'ChangelistService',
        'ChangelistService constructed'
      );
      assert.notStrictEqual(
        ctorIdx,
        -1,
        `expected ChangelistService constructor to emit an info-level record; ` +
          `captured lines: ${JSON.stringify(afterCtor.slice(beforeCtor))}`
      );
      const ctorRecord = parseRecord(reassembleBlock(afterCtor.slice(beforeCtor), ctorIdx));
      assert.strictEqual(ctorRecord.level, 'info');
      assert.strictEqual(ctorRecord.component, 'ChangelistService');

      const beforeDispose = captureLines().length;
      svc.dispose();
      const afterDispose = captureLines().slice(beforeDispose);
      const disposeIdx = findRecord(
        afterDispose,
        'ChangelistService',
        'ChangelistService disposing'
      );
      assert.notStrictEqual(
        disposeIdx,
        -1,
        `expected ChangelistService.dispose() to emit an info-level record; ` +
          `lines emitted during dispose: ${JSON.stringify(afterDispose)}`
      );
      const disposeRecord = parseRecord(reassembleBlock(afterDispose, disposeIdx));
      assert.strictEqual(disposeRecord.level, 'info');
      assert.strictEqual(disposeRecord.component, 'ChangelistService');
    });

    it('ShelfService emits info on construction and on dispose()', () => {
      const gitService = createMockGitService(attachedRepo());
      const beforeCtor = captureLines().length;
      const svc = new ShelfService(undefined, gitService);

      const afterCtor = captureLines().slice(beforeCtor);
      const ctorIdx = findRecord(afterCtor, 'ShelfService', 'ShelfService constructed');
      assert.notStrictEqual(
        ctorIdx,
        -1,
        `expected ShelfService constructor to emit an info-level record; ` +
          `captured lines: ${JSON.stringify(afterCtor)}`
      );
      const ctorRecord = parseRecord(reassembleBlock(afterCtor, ctorIdx));
      assert.strictEqual(ctorRecord.level, 'info');
      assert.strictEqual(ctorRecord.component, 'ShelfService');

      const beforeDispose = captureLines().length;
      svc.dispose();
      const afterDispose = captureLines().slice(beforeDispose);
      const disposeIdx = findRecord(afterDispose, 'ShelfService', 'ShelfService disposing');
      assert.notStrictEqual(
        disposeIdx,
        -1,
        `expected ShelfService.dispose() to emit an info-level record; ` +
          `lines emitted during dispose: ${JSON.stringify(afterDispose)}`
      );
      const disposeRecord = parseRecord(reassembleBlock(afterDispose, disposeIdx));
      assert.strictEqual(disposeRecord.level, 'info');
      assert.strictEqual(disposeRecord.component, 'ShelfService');
    });

    it('AutoFetchService emits info on construction and on dispose()', () => {
      const gitService = createMockGitService(attachedRepo());
      const beforeCtor = captureLines().length;
      // skipWorkspaceListeners keeps the constructor from registering
      // a real `vscode.workspace.onDidChangeConfiguration` listener
      // that survives across tests.
      const svc = new AutoFetchService(gitService, {
        readEnabled: () => false,
        readIntervalSec: () => 60,
        skipWorkspaceListeners: true,
      });

      const afterCtor = captureLines().slice(beforeCtor);
      const ctorIdx = findRecord(afterCtor, 'AutoFetchService', 'AutoFetchService constructed');
      assert.notStrictEqual(
        ctorIdx,
        -1,
        `expected AutoFetchService constructor to emit an info-level record; ` +
          `captured lines: ${JSON.stringify(afterCtor)}`
      );
      const ctorRecord = parseRecord(reassembleBlock(afterCtor, ctorIdx));
      assert.strictEqual(ctorRecord.level, 'info');
      assert.strictEqual(ctorRecord.component, 'AutoFetchService');

      const beforeDispose = captureLines().length;
      svc.dispose();
      const afterDispose = captureLines().slice(beforeDispose);
      const disposeIdx = findRecord(afterDispose, 'AutoFetchService', 'AutoFetchService disposing');
      assert.notStrictEqual(
        disposeIdx,
        -1,
        `expected AutoFetchService.dispose() to emit an info-level record; ` +
          `lines emitted during dispose: ${JSON.stringify(afterDispose)}`
      );
      const disposeRecord = parseRecord(reassembleBlock(afterDispose, disposeIdx));
      assert.strictEqual(disposeRecord.level, 'info');
      assert.strictEqual(disposeRecord.component, 'AutoFetchService');
    });

    it('ConflictResolutionService emits info on construction and on dispose()', () => {
      const gitService = createMockGitService(attachedRepo());
      const beforeCtor = captureLines().length;
      const svc = new ConflictResolutionService(gitService);

      const afterCtor = captureLines().slice(beforeCtor);
      const ctorIdx = findRecord(
        afterCtor,
        'ConflictResolutionService',
        'ConflictResolutionService constructed'
      );
      assert.notStrictEqual(
        ctorIdx,
        -1,
        `expected ConflictResolutionService constructor to emit an info-level record; ` +
          `captured lines: ${JSON.stringify(afterCtor)}`
      );
      const ctorRecord = parseRecord(reassembleBlock(afterCtor, ctorIdx));
      assert.strictEqual(ctorRecord.level, 'info');
      assert.strictEqual(ctorRecord.component, 'ConflictResolutionService');

      const beforeDispose = captureLines().length;
      svc.dispose();
      const afterDispose = captureLines().slice(beforeDispose);
      const disposeIdx = findRecord(
        afterDispose,
        'ConflictResolutionService',
        'ConflictResolutionService disposing'
      );
      assert.notStrictEqual(
        disposeIdx,
        -1,
        `expected ConflictResolutionService.dispose() to emit an info-level record; ` +
          `lines emitted during dispose: ${JSON.stringify(afterDispose)}`
      );
      const disposeRecord = parseRecord(reassembleBlock(afterDispose, disposeIdx));
      assert.strictEqual(disposeRecord.level, 'info');
      assert.strictEqual(disposeRecord.component, 'ConflictResolutionService');
    });

    it('PatchService emits info on construction and on dispose()', () => {
      const gitService = createMockGitService(attachedRepo());
      const beforeCtor = captureLines().length;
      const svc = new PatchService(gitService);

      const afterCtor = captureLines().slice(beforeCtor);
      const ctorIdx = findRecord(afterCtor, 'PatchService', 'PatchService constructed');
      assert.notStrictEqual(
        ctorIdx,
        -1,
        `expected PatchService constructor to emit an info-level record; ` +
          `captured lines: ${JSON.stringify(afterCtor)}`
      );
      const ctorRecord = parseRecord(reassembleBlock(afterCtor, ctorIdx));
      assert.strictEqual(ctorRecord.level, 'info');
      assert.strictEqual(ctorRecord.component, 'PatchService');

      const beforeDispose = captureLines().length;
      svc.dispose();
      const afterDispose = captureLines().slice(beforeDispose);
      const disposeIdx = findRecord(afterDispose, 'PatchService', 'PatchService disposing');
      assert.notStrictEqual(
        disposeIdx,
        -1,
        `expected PatchService.dispose() to emit an info-level record; ` +
          `lines emitted during dispose: ${JSON.stringify(afterDispose)}`
      );
      const disposeRecord = parseRecord(reassembleBlock(afterDispose, disposeIdx));
      assert.strictEqual(disposeRecord.level, 'info');
      assert.strictEqual(disposeRecord.component, 'PatchService');
    });
  });

  describe('BranchTreeProvider refresh waypoint', () => {
    it('BranchTreeProvider.refresh() emits a debug-level record', () => {
      const gitService = createMockGitService(attachedRepo());
      const provider = new BranchTreeProvider(gitService);

      try {
        // Refresh must always emit, regardless of repo state. Capture
        // lines BEFORE the call so we can scope the assertion to the
        // single invocation (BranchTreeProvider.constructor itself
        // kicks off an async `_initializeRepository()` that may also
        // call refresh once initial repository load resolves; we
        // explicitly drive an extra refresh here so the test is
        // deterministic regardless of the async initialize ordering).
        const before = captureLines().length;
        provider.refresh();

        const afterLines = captureLines().slice(before);
        const idx = findRecord(afterLines, 'BranchTreeProvider', 'refresh triggered');
        assert.notStrictEqual(
          idx,
          -1,
          `expected BranchTreeProvider.refresh() to emit a debug-level record; ` +
            `captured lines: ${JSON.stringify(afterLines)}`
        );
        const record = parseRecord(reassembleBlock(afterLines, idx));
        assert.strictEqual(
          record.level,
          'debug',
          `expected debug level for refresh waypoint; got ${record.level}`
        );
        assert.strictEqual(record.component, 'BranchTreeProvider');
        assert.strictEqual(record.message, 'refresh triggered');
      } finally {
        provider.dispose();
      }
    });

    it('BranchTreeProvider.refresh() emits one record per call (no spurious double-emission)', () => {
      const gitService = createMockGitService(attachedRepo());
      const provider = new BranchTreeProvider(gitService);

      try {
        const before = captureLines().length;
        provider.refresh();
        provider.refresh();
        provider.refresh();
        const after = captureLines().slice(before);

        // Count refresh-trigger headers among the emitted lines.
        // Continuation lines (`  ctx=…`) cannot match the header
        // shape because they do not start with `[`.
        let refreshCount = 0;
        for (const line of after) {
          if (line.startsWith('[') && line.includes('BranchTreeProvider: refresh triggered')) {
            refreshCount += 1;
          }
        }
        assert.strictEqual(
          refreshCount,
          3,
          `expected exactly 3 refresh records (one per call); got ${refreshCount}. ` +
            `lines: ${JSON.stringify(after)}`
        );
      } finally {
        provider.dispose();
      }
    });
  });
});

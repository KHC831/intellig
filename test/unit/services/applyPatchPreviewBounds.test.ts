/**
 * Bounds on the Apply Patch preview's per-file dry run.
 *
 * One `git apply --3way --check` per distinct path, run serially and
 * unbounded, turns a 400-file patch into 400 sequential spawns holding the
 * dialog busy with no progress and no escape. The loader mirrors the
 * multi-commit changed-files loader: a four-wide fan-out, a staleness
 * generation so a newer Preview supersedes the one the user left, and an
 * explicit cap with an honest notice.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ApplyPatchDialog } from '../../../src/patches/ApplyPatchDialog';
import {
  PREVIEW_CHECK_CONCURRENCY,
  PREVIEW_FILE_CAP,
} from '../../../src/patches/applyPatchSettings';
import type { IPatchService } from '../../../src/patches/interfaces/IPatchService';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

function makeRepo(): IRepository {
  return { rootUri: vscode.Uri.file('/tmp/repo') } as IRepository;
}

function makeCtx(): vscode.ExtensionContext {
  const store: Record<string, unknown> = {};
  return {
    subscriptions: [],
    workspaceState: {
      get: (k: string) => store[k],
      update: async (k: string, v: unknown) => {
        store[k] = v;
      },
      keys: () => Object.keys(store),
    },
    extensionUri: vscode.Uri.file('/tmp/ext'),
  } as unknown as vscode.ExtensionContext;
}

const stubAmOps = {
  isAmSessionActive: async () => false,
  continueAmSession: async () => ({ success: true, appliedFiles: [] }),
  skipAmCommit: async () => ({ success: true, appliedFiles: [] }),
  abortAmSession: async () => ({ success: true, appliedFiles: [] }),
};

/** A patch touching `n` distinct paths. */
function patchWith(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) {
    out +=
      `diff --git a/f${i}.txt b/f${i}.txt\n` +
      `--- a/f${i}.txt\n+++ b/f${i}.txt\n` +
      `@@ -1 +1 @@\n-a\n+b\n`;
  }
  return out;
}

describe('Apply Patch preview — bounded, cancellable, capped', () => {
  let ctx: vscode.ExtensionContext;
  let dialog: ApplyPatchDialog | undefined;

  beforeEach(() => {
    ctx = makeCtx();
    (vscode.env.clipboard as unknown as { readText: () => Promise<string> }).readText = async () =>
      patchWith(40);
  });

  afterEach(() => {
    dialog?.dispose();
    dialog = undefined;
  });

  it('never runs more than the concurrency bound of checks at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const stubSvc = {
      applyPatch: async (_r: IRepository, o: { check?: boolean }) => {
        if (o.check) {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 1));
          inFlight--;
        }
        return { success: true, appliedFiles: [] };
      },
      createPatchFromLocalChanges: async () => '',
      ...stubAmOps,
      dispose: (): void => {},
    } as unknown as IPatchService;

    dialog = new ApplyPatchDialog(ctx, { repo: makeRepo(), patchService: stubSvc });
    await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
      type: 'preview',
      useClipboard: true,
    });

    assert.ok(peak > 1, `the checks must overlap, saw peak ${peak}`);
    assert.ok(
      peak <= PREVIEW_CHECK_CONCURRENCY,
      `at most ${PREVIEW_CHECK_CONCURRENCY} in flight, saw ${peak}`
    );
  });

  it('caps the number of files it checks', async () => {
    (vscode.env.clipboard as unknown as { readText: () => Promise<string> }).readText = async () =>
      patchWith(PREVIEW_FILE_CAP + 25);
    let checks = 0;
    const stubSvc = {
      applyPatch: async (_r: IRepository, o: { check?: boolean }) => {
        if (o.check) {
          checks++;
        }
        return { success: true, appliedFiles: [] };
      },
      createPatchFromLocalChanges: async () => '',
      ...stubAmOps,
      dispose: (): void => {},
    } as unknown as IPatchService;

    dialog = new ApplyPatchDialog(ctx, { repo: makeRepo(), patchService: stubSvc });
    await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
      type: 'preview',
      useClipboard: true,
    });

    assert.strictEqual(checks, PREVIEW_FILE_CAP, 'the cap bounds the spawns');
  });

  it('a superseded preview is observed stale and posts no verdicts', async () => {
    // Instrument the guard directly: asserting on spawn COUNTS cannot tell
    // "the guard fired" from "the mutex dropped the second request".
    const stubSvc = {
      applyPatch: async (_r: IRepository, o: { check?: boolean }) => {
        if (o.check) {
          await new Promise((r) => setTimeout(r, 2));
        }
        return { success: true, appliedFiles: [] };
      },
      createPatchFromLocalChanges: async () => '',
      ...stubAmOps,
      dispose: (): void => {},
    } as unknown as IPatchService;

    dialog = new ApplyPatchDialog(ctx, { repo: makeRepo(), patchService: stubSvc });
    const internals = dialog as unknown as {
      _onMessage: (m: unknown) => Promise<void>;
      _previewGuard: { bump: () => number; isCurrent: (g: number) => boolean };
      postMessage: (m: unknown) => Promise<void>;
    };

    let staleObservations = 0;
    const realIsCurrent = internals._previewGuard.isCurrent.bind(internals._previewGuard);
    internals._previewGuard.isCurrent = (g: number): boolean => {
      const cur = realIsCurrent(g);
      if (!cur) {
        staleObservations++;
      }
      return cur;
    };

    const previewPosts: number[] = [];
    internals.postMessage = async (m: unknown): Promise<void> => {
      if ((m as { type?: string }).type === 'preview') {
        previewPosts.push(1);
      }
    };

    const send = internals._onMessage.bind(dialog);
    await Promise.all([
      send({ type: 'preview', useClipboard: true }),
      send({ type: 'preview', useClipboard: true }),
    ]);
    // Let the coalesced re-run finish.
    await new Promise((r) => setTimeout(r, 250));

    assert.ok(staleObservations > 0, 'the superseded run must actually observe itself stale');
    assert.strictEqual(
      previewPosts.length,
      1,
      'exactly one preview result reaches the pane — the superseded run posts none'
    );
  });

  it('reports the cap honestly, and does not conflate cancellation with capping', async () => {
    (vscode.env.clipboard as unknown as { readText: () => Promise<string> }).readText = async () =>
      patchWith(PREVIEW_FILE_CAP + 25);
    let checks = 0;
    const stubSvc = {
      applyPatch: async (_r: IRepository, o: { check?: boolean }) => {
        if (o.check) {
          checks++;
          await new Promise((r) => setTimeout(r, 2));
        }
        return { success: true, appliedFiles: [] };
      },
      createPatchFromLocalChanges: async () => '',
      ...stubAmOps,
      dispose: (): void => {},
    } as unknown as IPatchService;

    dialog = new ApplyPatchDialog(ctx, { repo: makeRepo(), patchService: stubSvc });
    const internals = dialog as unknown as {
      _onMessage: (m: unknown) => Promise<void>;
      postMessage: (m: unknown) => Promise<void>;
    };
    let reported: { checkedFiles?: number; totalFiles?: number } | undefined;
    internals.postMessage = async (m: unknown): Promise<void> => {
      if ((m as { type?: string }).type === 'preview') {
        reported = m as { checkedFiles?: number; totalFiles?: number };
      }
    };
    await internals._onMessage({ type: 'preview', useClipboard: true });

    assert.strictEqual(reported?.checkedFiles, PREVIEW_FILE_CAP, 'checked is the cap, exactly');
    assert.strictEqual(reported?.totalFiles, PREVIEW_FILE_CAP + 25, 'total is what the patch has');
    assert.strictEqual(checks, PREVIEW_FILE_CAP);
  });
});

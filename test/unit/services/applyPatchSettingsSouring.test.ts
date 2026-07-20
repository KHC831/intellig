/**
 * Apply-Patch settings must not persist a value the apply path will refuse.
 *
 * The dialog remembered the form BEFORE validating it, so a repo-escaping
 * baseDir landed in workspace state and was re-seeded on every later open —
 * only PatchService.applyPatch rejected it, once per attempt. Validation now
 * runs first, and the loader drops a soured baseDir per the module's own
 * one-bad-field-drops-itself policy.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  validateApplyPatchSettings,
  applyPatchSettingsSlot,
} from '../../../src/patches/applyPatchSettings';
import { ApplyPatchDialog } from '../../../src/patches/ApplyPatchDialog';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

const REPO_ROOT = '/tmp/repo';

describe('validateApplyPatchSettings — baseDir souring', () => {
  it('drops a baseDir that escapes the repo root', () => {
    const out = validateApplyPatchSettings({ baseDir: '../outside', stripLevel: 2 }, REPO_ROOT);
    assert.strictEqual(out?.baseDir, undefined, 'an escaping baseDir must not survive load');
    assert.strictEqual(out?.stripLevel, 2, 'the other fields still load');
  });

  it('drops an absolute baseDir pointing outside the repo', () => {
    const out = validateApplyPatchSettings({ baseDir: '/etc' }, REPO_ROOT);
    assert.strictEqual(out?.baseDir, undefined);
  });

  it('keeps a baseDir inside the repo', () => {
    const out = validateApplyPatchSettings({ baseDir: 'sub/dir' }, REPO_ROOT);
    assert.strictEqual(out?.baseDir, 'sub/dir');
  });

  it('keeps a baseDir when no repo root is supplied', () => {
    const out = validateApplyPatchSettings({ baseDir: '../outside' });
    assert.strictEqual(out?.baseDir, '../outside');
  });

  it('the slot validator carries the repo root', () => {
    const slot = applyPatchSettingsSlot(REPO_ROOT);
    assert.strictEqual(slot.validate({ baseDir: '../outside' })?.baseDir, undefined);
  });
});

describe('ApplyPatchDialog — settings persist only after validation', () => {
  function makeRepo(): IRepository {
    return { rootUri: vscode.Uri.file(REPO_ROOT) } as IRepository;
  }

  function makeCtx(store: Record<string, unknown>): vscode.ExtensionContext {
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

  const stubSvc = {
    applyPatch: async () => ({ success: true, appliedFiles: [] }),
    createPatchFromLocalChanges: async () => '',
    isAmSessionActive: async () => false,
    continueAmSession: async () => ({ success: true, appliedFiles: [] }),
    skipAmCommit: async () => ({ success: true, appliedFiles: [] }),
    abortAmSession: async () => ({ success: true, appliedFiles: [] }),
    dispose: (): void => {},
  };

  it('does not remember a form the apply path would refuse', async () => {
    const store: Record<string, unknown> = {};
    const dialog = new ApplyPatchDialog(makeCtx(store), {
      repo: makeRepo(),
      patchService: stubSvc as never,
      initialPatchPath: '/tmp/x.patch',
    });
    try {
      await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
        type: 'apply',
        patchPath: '/tmp/x.patch',
        stripLevel: Number.NaN,
        baseDir: 'sub',
      });
      const persisted = JSON.stringify(store);
      assert.ok(
        !persisted.includes('"baseDir":"sub"'),
        `an invalid form must not reach workspace state; got ${persisted}`
      );
    } finally {
      dialog.dispose();
    }
  });

  it('does not remember a repo-escaping baseDir', async () => {
    const store: Record<string, unknown> = {};
    const dialog = new ApplyPatchDialog(makeCtx(store), {
      repo: makeRepo(),
      patchService: stubSvc as never,
      initialPatchPath: '/tmp/x.patch',
    });
    try {
      await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
        type: 'apply',
        patchPath: '/tmp/x.patch',
        stripLevel: 1,
        baseDir: '../outside',
      });
      const persisted = JSON.stringify(store);
      assert.ok(
        !persisted.includes('outside'),
        `an escaping baseDir must not reach workspace state; got ${persisted}`
      );
    } finally {
      dialog.dispose();
    }
  });
});

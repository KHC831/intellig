/**
 * Unit coverage for the `intellig.changelist.*` command handlers
 * (registration/changelistCommands.ts). These were previously exercised only
 * by the Tier-2 e2e lane, leaving their guard / cancel / error branches
 * uncovered in the unit run (the lowest branch coverage in the repo).
 *
 * The handlers are closures registered through `registerLoggedCommand` →
 * `vscode.commands.registerCommand`. We capture them by wrapping that mock,
 * then invoke each one directly to drive the repo-resolution, missing-arg,
 * not-found, cancel, success, and error-toast paths.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerChangelistCommands } from '../../../src/commands/registration/changelistCommands';
import { ChangelistService } from '../../../src/services';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

type Handler = (...args: unknown[]) => unknown;

const REPO = { rootUri: { fsPath: '/repo', scheme: 'file' } } as unknown as IRepository;

interface Recorder {
  errors: string[];
  infos: string[];
  warns: string[];
}

interface ChangelistStub {
  id: string;
  name: string;
  description?: string;
  files: { path: string }[];
}

function makeContext(over?: {
  repos?: IRepository[];
  changelists?: ChangelistStub[];
  serviceOverrides?: Record<string, unknown>;
}): {
  ctx: ICommandContext;
  calls: Record<string, unknown[][]>;
} {
  const calls: Record<string, unknown[][]> = {};
  const rec = (name: string, ...args: unknown[]): void => {
    (calls[name] ??= []).push(args);
  };
  const changelists = over?.changelists ?? [];

  // A ChangelistService-shaped stub. The prototype is swapped so the
  // `service instanceof ChangelistService` guard in editDescription passes
  // without standing up the real service + its dependencies.
  const changelistService = {
    getChangelists: () => changelists,
    createChangelist: (...a: unknown[]) => rec('createChangelist', ...a),
    setActiveChangelist: async (...a: unknown[]) => rec('setActiveChangelist', ...a),
    renameChangelist: (...a: unknown[]) => rec('renameChangelist', ...a),
    deleteChangelist: (...a: unknown[]) => rec('deleteChangelist', ...a),
    setDescription: (...a: unknown[]) => rec('setDescription', ...a),
    moveToChangelist: (...a: unknown[]) => rec('moveToChangelist', ...a),
    ...over?.serviceOverrides,
  };
  Object.setPrototypeOf(changelistService, ChangelistService.prototype);

  const shelfService = {
    shelve: async (...a: unknown[]) => {
      rec('shelve', ...a);
      return { partialCleanupFailures: undefined as string[] | undefined };
    },
    ...over?.serviceOverrides,
  };

  const ctx = {
    services: {
      gitService: { getRepositories: () => over?.repos ?? [REPO] },
      changelistService,
      shelfService,
    },
    context: {
      workspaceState: { get: <T>(_k: string, d?: T) => d },
    },
  } as unknown as ICommandContext;

  return { ctx, calls };
}

describe('changelist commands — handler branch coverage', () => {
  const handlers = new Map<string, Handler>();
  const originalRegister = vscode.commands.registerCommand;
  // Snapshot window methods we stub so each test starts clean.
  const win = vscode.window as unknown as Record<string, unknown>;
  const winSnapshot: Record<string, unknown> = {};
  const rec: Recorder = { errors: [], infos: [], warns: [] };

  function register(ctx: ICommandContext): void {
    handlers.clear();
    registerChangelistCommands(ctx);
  }
  const invoke = (id: string, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve(handlers.get(id)!(...args));

  beforeEach(() => {
    rec.errors = [];
    rec.infos = [];
    rec.warns = [];
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = (
      id: string,
      cb: Handler
    ): { dispose: () => void } => {
      handlers.set(id, cb);
      return { dispose: () => {} };
    };
    for (const k of [
      'showErrorMessage',
      'showInformationMessage',
      'showWarningMessage',
      'showInputBox',
      'showQuickPick',
    ]) {
      winSnapshot[k] = win[k];
    }
    win.showErrorMessage = async (m: string): Promise<undefined> => {
      rec.errors.push(m);
      return undefined;
    };
    win.showInformationMessage = async (m: string): Promise<undefined> => {
      rec.infos.push(m);
      return undefined;
    };
    win.showWarningMessage = async (m: string): Promise<undefined> => {
      rec.warns.push(m);
      return undefined;
    };
  });

  afterEach(() => {
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = originalRegister;
    for (const k of Object.keys(winSnapshot)) {
      win[k] = winSnapshot[k];
    }
  });

  // ── new ────────────────────────────────────────────────────────────────────

  it('new: errors when no repository resolves', async () => {
    const { ctx, calls } = makeContext({ repos: [] });
    register(ctx);
    win.showInputBox = async (): Promise<string | undefined> => 'should-not-be-asked';
    await invoke('intellig.changelist.new');
    assert.deepStrictEqual(rec.errors, ['No Git repository found']);
    assert.ok(!calls.createChangelist, 'no create when no repo');
  });

  it('new: cancels silently when the name input is empty', async () => {
    const { ctx, calls } = makeContext();
    register(ctx);
    win.showInputBox = async (): Promise<string | undefined> => undefined;
    await invoke('intellig.changelist.new');
    assert.ok(!calls.createChangelist, 'no create on cancel');
    assert.deepStrictEqual(rec.errors, []);
  });

  it('new: creates the changelist with a trimmed name', async () => {
    const { ctx, calls } = makeContext();
    register(ctx);
    win.showInputBox = async (): Promise<string | undefined> => '  Feature X  ';
    await invoke('intellig.changelist.new');
    assert.deepStrictEqual(calls.createChangelist, [[REPO, 'Feature X']]);
  });

  it('new: surfaces a service error as a toast', async () => {
    const { ctx } = makeContext({
      serviceOverrides: {
        createChangelist: () => {
          throw new Error('boom');
        },
      },
    });
    register(ctx);
    win.showInputBox = async (): Promise<string | undefined> => 'X';
    await invoke('intellig.changelist.new');
    assert.strictEqual(rec.errors.length, 1);
    assert.ok(rec.errors[0].startsWith('Failed to create changelist:'));
  });

  // ── setActive / delete (id-guarded, no input) ───────────────────────────────

  it('setActive: prompts with a changelist picker when the id is missing (palette invocation)', async () => {
    const { ctx, calls } = makeContext({
      changelists: [
        { id: 'cl-1', name: 'Default', files: [] },
        { id: 'cl-2', name: 'Feature', files: [{ path: 'a.ts' }] },
      ],
    });
    register(ctx);
    win.showQuickPick = async (items: Array<{ id: string; label: string }>) =>
      items.find((i) => i.label === 'Feature');
    await invoke('intellig.changelist.setActive', undefined);
    assert.deepStrictEqual(calls.setActiveChangelist, [[REPO, 'cl-2']]);
  });

  it('setActive: a cancelled picker is a silent no-op', async () => {
    const { ctx, calls } = makeContext({
      changelists: [{ id: 'cl-1', name: 'Default', files: [] }],
    });
    register(ctx);
    win.showQuickPick = async () => undefined;
    await invoke('intellig.changelist.setActive', undefined);
    assert.ok(!calls.setActiveChangelist);
    assert.deepStrictEqual(rec.errors, []);
  });

  it('setActive: informs when there are no changelists to pick from', async () => {
    const { ctx, calls } = makeContext({ changelists: [] });
    register(ctx);
    await invoke('intellig.changelist.setActive', undefined);
    assert.ok(!calls.setActiveChangelist);
    assert.deepStrictEqual(rec.infos, ['No changelists found.']);
  });

  it('setActive: calls the service and toasts on failure', async () => {
    const { ctx } = makeContext({
      serviceOverrides: {
        setActiveChangelist: async () => {
          throw new Error('nope');
        },
      },
    });
    register(ctx);
    await invoke('intellig.changelist.setActive', 'cl-1');
    assert.strictEqual(rec.errors.length, 1);
    assert.ok(rec.errors[0].startsWith('Failed to set active changelist:'));
  });

  it('setActive: succeeds for a valid id', async () => {
    const { ctx, calls } = makeContext();
    register(ctx);
    await invoke('intellig.changelist.setActive', 'cl-1');
    assert.deepStrictEqual(calls.setActiveChangelist, [[REPO, 'cl-1']]);
    assert.deepStrictEqual(rec.errors, []);
  });

  it('delete: removes the changelist by id', async () => {
    const { ctx, calls } = makeContext();
    register(ctx);
    await invoke('intellig.changelist.delete', 'cl-1');
    assert.deepStrictEqual(calls.deleteChangelist, [[REPO, 'cl-1']]);
  });

  // ── rename ──────────────────────────────────────────────────────────────────

  it('rename: no-ops when the id is not found', async () => {
    const { ctx, calls } = makeContext({ changelists: [] });
    register(ctx);
    await invoke('intellig.changelist.rename', 'missing');
    assert.ok(!calls.renameChangelist);
  });

  it('rename: no-ops when the new name equals the current name', async () => {
    const { ctx, calls } = makeContext({
      changelists: [{ id: 'cl-1', name: 'Same', files: [] }],
    });
    register(ctx);
    win.showInputBox = async (): Promise<string | undefined> => 'Same';
    await invoke('intellig.changelist.rename', 'cl-1');
    assert.ok(!calls.renameChangelist, 'unchanged name does not rename');
  });

  it('rename: renames with the trimmed new name', async () => {
    const { ctx, calls } = makeContext({
      changelists: [{ id: 'cl-1', name: 'Old', files: [] }],
    });
    register(ctx);
    win.showInputBox = async (): Promise<string | undefined> => '  New  ';
    await invoke('intellig.changelist.rename', 'cl-1');
    assert.deepStrictEqual(calls.renameChangelist, [[REPO, 'cl-1', 'New']]);
  });

  // ── editDescription (instanceof-guarded) ────────────────────────────────────

  it('editDescription: cancels when the input box is dismissed', async () => {
    const { ctx, calls } = makeContext({
      changelists: [{ id: 'cl-1', name: 'CL', description: 'old', files: [] }],
    });
    register(ctx);
    win.showInputBox = async (): Promise<string | undefined> => undefined;
    await invoke('intellig.changelist.editDescription', 'cl-1');
    assert.ok(!calls.setDescription);
  });

  it('editDescription: persists a new (even empty) description', async () => {
    const { ctx, calls } = makeContext({
      changelists: [{ id: 'cl-1', name: 'CL', description: 'old', files: [] }],
    });
    register(ctx);
    win.showInputBox = async (): Promise<string | undefined> => '';
    await invoke('intellig.changelist.editDescription', 'cl-1');
    assert.deepStrictEqual(calls.setDescription, [[REPO, 'cl-1', '']]);
  });

  // ── moveFilesTo ─────────────────────────────────────────────────────────────

  it('moveFilesTo: prompts with a file picker when no files are supplied (palette invocation)', async () => {
    const { ctx, calls } = makeContext({
      changelists: [
        { id: 'cl-1', name: 'Default', files: [{ path: 'a.ts' }, { path: 'b.ts' }] },
        { id: 'cl-2', name: 'Feature', files: [] },
      ],
    });
    register(ctx);
    let pickCall = 0;
    win.showQuickPick = async (items: Array<{ path?: string; id?: string; label: string }>) => {
      pickCall += 1;
      if (pickCall === 1) {
        // multi-select file picker: choose a.ts only
        return items.filter((i) => i.label === 'a.ts');
      }
      return items.find((i) => i.label === 'Feature');
    };
    await invoke('intellig.changelist.moveFilesTo', undefined);
    assert.deepStrictEqual(calls.moveToChangelist, [[REPO, ['a.ts'], 'cl-2']]);
  });

  it('moveFilesTo: informs when there are no changed files to move', async () => {
    const { ctx, calls } = makeContext({
      changelists: [{ id: 'cl-1', name: 'Default', files: [] }],
    });
    register(ctx);
    await invoke('intellig.changelist.moveFilesTo', undefined);
    assert.ok(!calls.moveToChangelist);
    assert.deepStrictEqual(rec.infos, ['No changed files to move.']);
  });

  it('moveFilesTo: cancels when no target is picked', async () => {
    const { ctx, calls } = makeContext({
      changelists: [{ id: 'cl-1', name: 'CL', files: [] }],
    });
    register(ctx);
    win.showQuickPick = async (): Promise<unknown> => undefined;
    await invoke('intellig.changelist.moveFilesTo', ['a.ts']);
    assert.ok(!calls.moveToChangelist);
  });

  it('moveFilesTo: moves the files into the picked changelist', async () => {
    const { ctx, calls } = makeContext({
      changelists: [{ id: 'cl-1', name: 'CL', files: [] }],
    });
    register(ctx);
    win.showQuickPick = async (): Promise<unknown> => ({ label: 'CL', id: 'cl-1' });
    await invoke('intellig.changelist.moveFilesTo', ['a.ts', 'b.ts']);
    assert.deepStrictEqual(calls.moveToChangelist, [[REPO, ['a.ts', 'b.ts'], 'cl-1']]);
  });

  // ── commitOnly (guard branches; deep commit path stays in e2e) ──────────────

  it('commitOnly: prompts with a changelist picker when the id is missing (palette invocation)', async () => {
    const { ctx } = makeContext({
      changelists: [{ id: 'cl-1', name: 'Default', files: [] }],
    });
    register(ctx);
    win.showQuickPick = async (items: Array<{ id: string }>) => items[0];
    await invoke('intellig.changelist.commitOnly', undefined);
    // Picked changelist has no files -> the empty-changelist info fires,
    // proving the picker fed the id through instead of a silent return.
    assert.deepStrictEqual(rec.infos, ["Changelist 'Default' has no changes to commit."]);
  });

  it('commitOnly: errors when no repository resolves', async () => {
    const { ctx } = makeContext({ repos: [] });
    register(ctx);
    await invoke('intellig.changelist.commitOnly', 'cl-1');
    assert.deepStrictEqual(rec.errors, ['No Git repository found']);
  });

  it('commitOnly: informs when the changelist has no files', async () => {
    const { ctx } = makeContext({
      changelists: [{ id: 'cl-1', name: 'Empty', files: [] }],
    });
    register(ctx);
    await invoke('intellig.changelist.commitOnly', 'cl-1');
    assert.strictEqual(rec.infos.length, 1);
    assert.ok(rec.infos[0].includes("Changelist 'Empty' has no changes"));
  });

  it('commitOnly: cancels when the commit message is empty', async () => {
    const { ctx } = makeContext({
      changelists: [{ id: 'cl-1', name: 'CL', files: [{ path: 'a.ts' }] }],
    });
    register(ctx);
    win.showInputBox = async (): Promise<string | undefined> => '   ';
    await invoke('intellig.changelist.commitOnly', 'cl-1');
    assert.deepStrictEqual(rec.errors, []);
    assert.deepStrictEqual(rec.infos, []);
  });

  // ── shelve ──────────────────────────────────────────────────────────────────

  it('shelve: shelves the changelist files and reports success', async () => {
    const { ctx, calls } = makeContext({
      changelists: [{ id: 'cl-1', name: 'CL', files: [{ path: 'a.ts' }, { path: 'b.ts' }] }],
    });
    register(ctx);
    await invoke('intellig.changelist.shelve', 'cl-1');
    assert.strictEqual(calls.shelve?.length, 1);
    assert.strictEqual(rec.infos.length, 1);
    assert.ok(rec.infos[0].includes("Shelved 2 file(s) from 'CL'"));
  });

  it('shelve: warns when some files could not be removed from the working tree', async () => {
    const { ctx } = makeContext({
      changelists: [{ id: 'cl-1', name: 'CL', files: [{ path: 'a.ts' }] }],
      serviceOverrides: {
        shelve: async () => ({ partialCleanupFailures: ['a.ts'] }),
      },
    });
    register(ctx);
    await invoke('intellig.changelist.shelve', 'cl-1');
    assert.strictEqual(rec.warns.length, 1);
    assert.ok(rec.warns[0].includes('could not be removed'));
  });

  it('shelve: surfaces a shelve failure as an error toast', async () => {
    const { ctx } = makeContext({
      changelists: [{ id: 'cl-1', name: 'CL', files: [{ path: 'a.ts' }] }],
      serviceOverrides: {
        shelve: async () => {
          throw new Error('disk full');
        },
      },
    });
    register(ctx);
    await invoke('intellig.changelist.shelve', 'cl-1');
    assert.strictEqual(rec.errors.length, 1);
    assert.ok(rec.errors[0].startsWith('Failed to shelve changelist:'));
  });
});

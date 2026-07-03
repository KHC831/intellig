/**
 * The `intellig.merge.*` palette commands act on the lazily-created MergeView
 * singleton. When it has never been opened (the user is mid-conflict in the
 * native editor and runs "Accept Current" from the palette), each command
 * must SAY so instead of silently doing nothing.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerRebaseConflictCommands } from '../../../src/commands/registration/rebaseConflictCommands';
import type { ICommandContext } from '../../../src/commands/registration/CommandContext';

type Handler = (...args: unknown[]) => unknown;

const MERGE_VIEW_COMMANDS = [
  'intellig.merge.acceptCurrent',
  'intellig.merge.acceptIncoming',
  'intellig.merge.acceptBoth',
  'intellig.merge.acceptAllCurrent',
  'intellig.merge.acceptAllIncoming',
  'intellig.merge.nextConflict',
  'intellig.merge.previousConflict',
  'intellig.merge.markResolved',
];

describe('merge.* commands without an open Merge View', () => {
  const handlers = new Map<string, Handler>();
  const originalRegister = vscode.commands.registerCommand;
  const win = vscode.window as unknown as Record<string, unknown>;
  const originalInfo = win.showInformationMessage;
  let infos: string[];

  beforeEach(() => {
    infos = [];
    handlers.clear();
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = (
      id: string,
      cb: Handler
    ): { dispose: () => void } => {
      handlers.set(id, cb);
      return { dispose: () => {} };
    };
    win.showInformationMessage = async (m: string): Promise<undefined> => {
      infos.push(m);
      return undefined;
    };
    // ctx.mergeView is undefined — never opened this session.
    registerRebaseConflictCommands({
      services: undefined,
      mergeView: undefined,
    } as unknown as ICommandContext);
  });

  afterEach(() => {
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = originalRegister;
    win.showInformationMessage = originalInfo;
  });

  for (const id of MERGE_VIEW_COMMANDS) {
    it(`${id} tells the user no merge view is open`, async () => {
      await Promise.resolve(handlers.get(id)!());
      assert.strictEqual(infos.length, 1, `expected exactly one toast, got: ${infos.join(' | ')}`);
      assert.ok(
        /merge view/i.test(infos[0]),
        `toast should mention the merge view; got: "${infos[0]}"`
      );
    });
  }
});

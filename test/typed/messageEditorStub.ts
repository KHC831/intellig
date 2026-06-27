/**
 * Shared test harness for the tempfile-backed multi-line message editor used by
 * `CommitContextMenuCommands._promptForMessageInEditor` (squash combine + reword
 * edit). Installs stubs at the `vscode.workspace` / `vscode.window` boundary that
 * drive the flow:
 *
 *   - `openTextDocument` records the seed content and returns a fake doc with a
 *     stable URI.
 *   - `showTextDocument` is a no-op.
 *   - `onDidSaveTextDocument` / `onDidCloseTextDocument` capture the listeners;
 *     tests fire them via the returned `simulate*` functions to drive
 *     save / cancel branches.
 *   - `commands.executeCommand` is no-op-stubbed for the editor close.
 *
 * Returns a tracker so the test can:
 *   - read the seed via `tracker.lastSeed`
 *   - simulate save with `tracker.simulateSave('message')`
 *   - simulate close-without-save with `tracker.simulateClose()`
 *
 * The handler awaits a Promise that resolves when one of these fires. Tests
 * should call exactly one of the simulate* functions per invocation.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { Uri } from '../mocks/vscode';
import { writableWindow, writableWorkspace, writableCommands } from './windowStub';

export interface MessageEditorTracker {
  lastSeed: string | undefined;
  lastLanguage: string | undefined;
  openCalls: number;
  showCalls: number;
  simulateSave: (text: string) => void;
  simulateClose: () => void;
}

export function installMessageEditorStubs(): MessageEditorTracker {
  const tracker: MessageEditorTracker = {
    lastSeed: undefined,
    lastLanguage: undefined,
    openCalls: 0,
    showCalls: 0,
    simulateSave: () => {
      throw new Error('save listener not installed yet');
    },
    simulateClose: () => {
      throw new Error('close listener not installed yet');
    },
  };

  let docUri: vscode.Uri | undefined;
  let savedText: string | undefined;
  // The handler opens via Uri.file(tmpPath); intercept both the object-literal
  // (with `content`) shape AND the `Uri.file` shape so either implementation
  // strategy is testable here.
  const ws = writableWorkspace();
  ws.openTextDocument = ((
    options: unknown
  ): Promise<{
    uri: vscode.Uri;
    getText: () => string;
    languageId: string;
    isUntitled: boolean;
  }> => {
    tracker.openCalls++;
    if (typeof options === 'string') {
      // path string
      docUri = Uri.file(options);
      savedText = '';
    } else if (
      options !== null &&
      typeof options === 'object' &&
      'fsPath' in (options as Record<string, unknown>)
    ) {
      // Uri — the handler pre-writes the seed to disk; recover it via fs so
      // `tracker.lastSeed` reflects what the user would see on first frame.
      docUri = options as vscode.Uri;
      try {
        savedText = fs.readFileSync((options as vscode.Uri).fsPath, 'utf8');
      } catch {
        savedText = '';
      }
      tracker.lastSeed = savedText;
    } else if (options !== null && typeof options === 'object') {
      const obj = options as { content?: string; language?: string };
      tracker.lastSeed = obj.content;
      tracker.lastLanguage = obj.language;
      docUri = Uri.parse(`untitled:message-editor-test-${Date.now()}`);
      savedText = obj.content ?? '';
    }
    return Promise.resolve({
      uri: docUri ?? Uri.parse('untitled:message-editor-test-default'),
      getText: () => savedText ?? '',
      languageId: tracker.lastLanguage ?? 'plaintext',
      isUntitled: true,
    });
  }) as typeof ws.openTextDocument;

  const w = writableWindow();
  w.showTextDocument = ((document: unknown): Promise<{ document: unknown }> => {
    tracker.showCalls++;
    return Promise.resolve({ document });
  }) as typeof w.showTextDocument;

  let saveListener: ((doc: { uri: vscode.Uri; getText: () => string }) => void) | undefined;
  let closeListener: ((doc: { uri: vscode.Uri }) => void) | undefined;

  ws.onDidSaveTextDocument = ((
    listener: (doc: { uri: vscode.Uri; getText: () => string }) => void
  ): { dispose: () => void } => {
    saveListener = listener;
    return {
      dispose: () => {
        saveListener = undefined;
      },
    };
  }) as typeof ws.onDidSaveTextDocument;

  ws.onDidCloseTextDocument = ((
    listener: (doc: { uri: vscode.Uri }) => void
  ): {
    dispose: () => void;
  } => {
    closeListener = listener;
    return {
      dispose: () => {
        closeListener = undefined;
      },
    };
  }) as typeof ws.onDidCloseTextDocument;

  // Stub commands.executeCommand to swallow the closeActiveEditor call.
  const realCommands = writableCommands();
  realCommands.executeCommand = (_name: string): Promise<unknown> => Promise.resolve(undefined);

  tracker.simulateSave = (text: string): void => {
    if (!saveListener || !docUri) {
      throw new Error('save listener / doc uri not initialised');
    }
    savedText = text;
    saveListener({ uri: docUri, getText: () => text });
  };
  tracker.simulateClose = (): void => {
    if (!closeListener || !docUri) {
      throw new Error('close listener / doc uri not initialised');
    }
    closeListener({ uri: docUri });
  };

  return tracker;
}

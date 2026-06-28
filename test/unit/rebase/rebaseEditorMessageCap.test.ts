/**
 * Regression test for the rebase commit-message length cap.
 *
 * `_handleUpdateMessage` must truncate messages that exceed
 * MAX_REBASE_MESSAGE_LENGTH before storing them. Defense-in-depth: the webview
 * is untrusted input; an unbounded message would be written verbatim to the
 * git rebase todo file. The cap is 64 KiB — well above any practical
 * commit-message length but prevents pathological abuse.
 */

import '../../setup';
import * as assert from 'assert';
import { RebaseEditor, MAX_REBASE_MESSAGE_LENGTH } from '../../../src/rebase/RebaseEditor';
import type {
  IRebaseService,
  IRebaseSession,
} from '../../../src/git-core/interfaces/IRebaseService';
import { Uri } from '../../mocks/vscode';

// ─── Minimal stubs ───────────────────────────────────────────────────────────

function makeSession(hash = 'abc1234'): IRebaseSession {
  return {
    onto: 'main',
    originalBranch: 'feature',
    currentStep: 0,
    status: 'planning',
    commits: [
      {
        hash,
        message: 'Original message',
        action: 'pick',
        newMessage: undefined,
      },
    ],
  } as unknown as IRebaseSession;
}

function makeEditor(session: IRebaseSession): {
  editor: RebaseEditor;
  simulateUpdateMessage: (hash: string, newMessage: string) => void;
} {
  const rebaseService: IRebaseService = {
    startInteractiveRebase: async () => session,
    executeRebase: async () => ({ status: 'success' }),
    abortRebase: async () => {},
    continueRebase: async () => ({ status: 'success' }),
  } as unknown as IRebaseService;

  const extensionUri = Uri.file('/test/extension');
  const editor = new RebaseEditor(extensionUri, rebaseService);

  // Inject session directly (bypasses the webview open path)
  (editor as unknown as { _session: IRebaseSession })._session = session;

  const simulateUpdateMessage = (hash: string, newMessage: string): void => {
    (
      editor as unknown as { _handleUpdateMessage(h: string, m: string): void }
    )._handleUpdateMessage(hash, newMessage);
  };

  return { editor, simulateUpdateMessage };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RebaseEditor._handleUpdateMessage — commit message length cap', () => {
  it('stores a short message unchanged', () => {
    const session = makeSession();
    const { simulateUpdateMessage } = makeEditor(session);
    simulateUpdateMessage('abc1234', 'Fix typo in docs');
    assert.strictEqual(session.commits[0].newMessage, 'Fix typo in docs');
  });

  it('stores a message that is exactly MAX_REBASE_MESSAGE_LENGTH characters unchanged', () => {
    const session = makeSession();
    const { simulateUpdateMessage } = makeEditor(session);
    const exact = 'a'.repeat(MAX_REBASE_MESSAGE_LENGTH);
    simulateUpdateMessage('abc1234', exact);
    assert.strictEqual(session.commits[0].newMessage?.length, MAX_REBASE_MESSAGE_LENGTH);
  });

  it('truncates a message that exceeds MAX_REBASE_MESSAGE_LENGTH', () => {
    const session = makeSession();
    const { simulateUpdateMessage } = makeEditor(session);
    const oversized = 'x'.repeat(MAX_REBASE_MESSAGE_LENGTH + 1000);
    simulateUpdateMessage('abc1234', oversized);
    assert.strictEqual(
      session.commits[0].newMessage?.length,
      MAX_REBASE_MESSAGE_LENGTH,
      'message must be capped at MAX_REBASE_MESSAGE_LENGTH'
    );
    assert.strictEqual(
      session.commits[0].newMessage,
      'x'.repeat(MAX_REBASE_MESSAGE_LENGTH),
      'capped message must be the first MAX_REBASE_MESSAGE_LENGTH chars'
    );
  });

  it('does nothing when the commit hash is not found in the session', () => {
    const session = makeSession();
    const original = session.commits[0].newMessage;
    const { simulateUpdateMessage } = makeEditor(session);
    simulateUpdateMessage('unknownhash', 'Should not be set');
    assert.strictEqual(
      session.commits[0].newMessage,
      original,
      'unmatched hash must leave session unchanged'
    );
  });
});

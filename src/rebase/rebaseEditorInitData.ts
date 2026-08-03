/**
 * Static init data for the interactive Rebase Editor webview: the action
 * dropdown entries and the reword/squash message-box placeholders.
 */

import type { RebaseAction } from '../git-core/interfaces/IRebaseService';
import type { IRebaseEditorInit } from './rebaseEditor.protocol';

/** The six todo actions, with git's own one-line descriptions. */
export const REBASE_EDITOR_ACTIONS: IRebaseEditorInit['actions'] = [
  { value: 'pick', label: 'pick', description: 'use commit' },
  { value: 'reword', label: 'reword', description: 'use commit, but edit the commit message' },
  { value: 'edit', label: 'edit', description: 'use commit, but stop for amending' },
  {
    value: 'squash',
    label: 'squash',
    description: 'meld into the commit above (keeps both messages)',
  },
  {
    value: 'fixup',
    label: 'fixup',
    description: "meld into the commit above, discard this commit's message",
  },
  { value: 'drop', label: 'drop', description: 'remove commit' },
];

/**
 * reword and squash both collect the message IN-UI (git4idea parity — we never
 * punt to an external editor). The rebase runs with GIT_EDITOR suppressed, so a
 * blank value does NOT open an editor: a blank reword keeps the commit's
 * original message; a blank squash takes git's auto-combined message. The
 * placeholders state that explicitly. Keyed by action so both the initial build
 * and the in-place action switch read the same string (no drift).
 */
export const REBASE_EDITOR_MESSAGE_PLACEHOLDERS: Partial<Record<RebaseAction, string>> = {
  reword: 'New commit message (leave blank to keep the original)',
  squash: 'Combined commit message (leave blank to auto-combine the messages)',
};

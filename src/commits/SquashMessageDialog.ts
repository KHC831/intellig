/**
 * Squash Message Dialog.
 *
 * Squash-specific preset of {@link CommitMessageDialog}: a multi-line modal for
 * editing the combined commit message during a squash. The dialog behaviour
 * (textarea, Esc cancels, Cmd/Ctrl+Enter submits, blank = cancel) lives in the
 * base; this subclass only supplies the squash heading / labels and the
 * `commitCount` in them.
 *
 * Production caller: {@link CommitContextMenuCommands._handleSquashCommits}.
 */

import * as vscode from 'vscode';
import { CommitMessageDialog } from './CommitMessageDialog';

const VIEW_TYPE = 'intellig.squashMessageDialog';
const TITLE = 'Squash Commits';

export class SquashMessageDialog extends CommitMessageDialog {
  constructor(
    context: vscode.ExtensionContext,
    options: { seedMessage: string; commitCount: number }
  ) {
    super(context, {
      seedMessage: options.seedMessage,
      viewType: VIEW_TYPE,
      title: TITLE,
      heading: `Squash ${options.commitCount} commits`,
      submitLabel: options.commitCount > 0 ? `Squash ${options.commitCount} commits` : 'Squash',
      submitVerb: 'squash',
    });
  }
}

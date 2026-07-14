/**
 * Wire protocol for the Commit dialog (standalone panel, raw dispatch typed in
 * place). NO runtime vscode import (the field-bag import is type-only). Frozen
 * wire; the dialog re-renders its HTML rather than posting, so outbound is
 * `never`.
 *
 * Inbound reuses the panel's existing `ICommitDialogWebviewMessage` field bag
 * via `Omit`, split into a discriminated union so `assertNever` can gate it.
 */
import type { ICommitDialogWebviewMessage } from './CommitDialog';

type Fields = Omit<ICommitDialogWebviewMessage, 'type'>;

export type CommitDialogInbound =
  | ({ type: 'commit' } & Fields)
  | ({ type: 'cancel' } & Fields)
  | ({ type: 'selectFile' } & Fields)
  | ({ type: 'toggleFile' } & Fields)
  | ({ type: 'toggleAmend' } & Fields)
  | ({ type: 'toggleSignOff' } & Fields)
  | ({ type: 'updateMessage' } & Fields)
  | ({ type: 'stageFile' } & Fields)
  | ({ type: 'unstageFile' } & Fields)
  | ({ type: 'refresh' } & Fields)
  | ({ type: 'stageHunk' } & Fields)
  | ({ type: 'unstageHunk' } & Fields)
  | ({ type: 'revertHunk' } & Fields)
  | ({ type: 'toggleLine' } & Fields)
  | ({ type: 'stageSelectedLines' } & Fields)
  | ({ type: 'togglePartialStagingMode' } & Fields)
  | ({ type: 'selectAllLinesInHunk' } & Fields)
  | ({ type: 'deselectAllLinesInHunk' } & Fields)
  | ({ type: 'authorChange' } & Fields)
  | ({ type: 'toggleNoVerify' } & Fields)
  | ({ type: 'openRecentMessages' } & Fields)
  | ({ type: 'openGearMenu' } & Fields);

export type CommitDialogOutbound = never;

export const COMMIT_DIALOG_INBOUND_TYPES = [
  'commit',
  'cancel',
  'selectFile',
  'toggleFile',
  'toggleAmend',
  'toggleSignOff',
  'updateMessage',
  'stageFile',
  'unstageFile',
  'refresh',
  'stageHunk',
  'unstageHunk',
  'revertHunk',
  'toggleLine',
  'stageSelectedLines',
  'togglePartialStagingMode',
  'selectAllLinesInHunk',
  'deselectAllLinesInHunk',
  'authorChange',
  'toggleNoVerify',
  'openRecentMessages',
  'openGearMenu',
] as const;

export function asCommitDialogInbound(message: unknown): CommitDialogInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (COMMIT_DIALOG_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as CommitDialogInbound)
    : undefined;
}

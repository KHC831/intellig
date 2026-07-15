/**
 * Wire protocol for the Commit dialog (standalone panel, raw dispatch typed in
 * place). Fully vscode-free so the bundled webview entry
 * (`src/commits/webview/commitDialog.ts`) imports it under `tsconfig.webview.json`.
 * The dialog re-renders its HTML rather than posting to the webview, so outbound
 * is `never`; the entry reads its initial state from the `data-init` island as
 * an {@link ICommitDialogInit}.
 *
 * Inbound is the webview→host message field bag ({@link ICommitDialogWebviewMessage})
 * split into a discriminated union so `assertNever` can gate it.
 */
import type { AssertInboundArrayTie, InboundArrayTie } from '../utils/protocolTie';

/** webview→host message field bag (all payloads optional per message type). */
export interface ICommitDialogWebviewMessage {
  type: string;
  message?: string;
  amend?: boolean;
  signOff?: boolean;
  path?: string;
  hunkIndex?: number;
  lineNumber?: number;
  /** 'add' | 'delete' — disambiguates which number-space lineNumber belongs to. */
  lineType?: string;
  /** Author override payload from the `authorChange` message. */
  author?: string;
}

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

/** Compile tie: COMMIT_DIALOG_INBOUND_TYPES and CommitDialogInbound agree both ways (check:typed-messages Rule D). */
const _commitDialogInboundTie: AssertInboundArrayTie<
  InboundArrayTie<CommitDialogInbound, typeof COMMIT_DIALOG_INBOUND_TYPES>
> = true;
void _commitDialogInboundTie;

// ── Init island payload (host→webview initial state) ──────────────────────────
// The host serializes an ICommitDialogInit into the body's `data-init` island;
// the bundled entry reads it on boot. Every dynamic value reaches the DOM via
// .value / .textContent / element props — never markup. Per-file/per-line display
// values (name/dir, status colour, line classes, checkboxes) are precomputed
// host-side so the entry just maps data → DOM.

/** A staged/unstaged file row. */
export interface ICommitDialogFileItem {
  path: string;
  fileName: string;
  fileDir: string;
  statusChar: string;
  statusColor: string;
  selected: boolean;
  isSelected: boolean;
  staged: boolean;
}

/** The selection descriptor a selectable diff line carries (partial staging). */
export interface ICommitDialogSelectableLine {
  hunkIndex: number;
  lineNumber: number;
  lineType: 'add' | 'delete';
}

/** A single rendered diff line. */
export interface ICommitDialogDiffLine {
  lineClass: string;
  prefix: string;
  oldNum: string;
  newNum: string;
  content: string;
  selectable: ICommitDialogSelectableLine | null;
  checkbox: string | null;
}

/** A rendered diff hunk with its per-hunk controls state. */
export interface ICommitDialogDiffHunk {
  header: string;
  hunkIndex: number;
  isStaged: boolean;
  hasSelectedLines: boolean;
  selectedCount: number;
  lines: ICommitDialogDiffLine[];
}

/** The selected file's diff preview. */
export interface ICommitDialogDiffView {
  fileName: string;
  partialStagingMode: boolean;
  binary: boolean;
  empty: boolean;
  hunks: ICommitDialogDiffHunk[];
}

/** The full host-side commit-dialog state the entry builds the DOM from. */
export interface ICommitDialogInit {
  message: string;
  author: string;
  authorError: string | undefined;
  noVerify: boolean;
  hasRecent: boolean;
  recentBtnTitle: string;
  stagedFiles: ICommitDialogFileItem[];
  unstagedFiles: ICommitDialogFileItem[];
  diff: ICommitDialogDiffView | null;
  amendMode: boolean;
  signOffMode: boolean;
  selectedCount: number;
  commitLabel: string;
}

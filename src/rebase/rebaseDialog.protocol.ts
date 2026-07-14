/**
 * Wire protocol for the Rebase dialog. NO vscode import. Frozen wire; the
 * dialog posts nothing back.
 */

/** One option checkbox row baked into the init island. */
export interface IRebaseOptionCheckbox {
  id: string;
  flag: string;
  title: string;
  desc: string;
  checked: boolean;
}

/** Initial state the host bakes into the body island; the entry reads it on boot. */
export interface IRebaseDialogInit {
  currentBranch: string;
  branchChoices: string[];
  onto: string;
  interactiveDefault: boolean;
  rootDisablesOnto: boolean;
  optionCheckboxes: IRebaseOptionCheckbox[];
}

export type RebaseDialogInbound =
  | {
      type: 'rebase';
      onto?: string;
      /** Optional `--onto <newbase>` target; '' / absent means rebase onto upstream. */
      newBase?: string;
      interactive?: boolean;
      rebaseMerges?: boolean;
      keepEmpty?: boolean;
      updateRefs?: boolean;
      autosquash?: boolean;
      root?: boolean;
    }
  | { type: 'cancel' };

export type RebaseDialogOutbound = never;

export const REBASE_DIALOG_INBOUND_TYPES = ['rebase', 'cancel'] as const;

export function asRebaseDialogInbound(message: unknown): RebaseDialogInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (REBASE_DIALOG_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as RebaseDialogInbound)
    : undefined;
}

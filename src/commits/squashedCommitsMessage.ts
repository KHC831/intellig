// Ported from intellij-community plugins/git4idea/backend/src/rebase/GitSquashedCommitsMessage.kt
// Copyright 2000-2024 JetBrains s.r.o. and contributors. Apache 2.0 license.

/**
 * Message-combination rules for squashed commits, ported from git4idea's
 * GitSquashedCommitsMessage (plugins/git4idea/backend/src/rebase/
 * GitSquashedCommitsMessage.kt) so every squash surface combines messages the
 * way the reference does: join with a blank-line separator, collapse duplicate
 * messages, and trim `fixup!`/`squash!`/`amend!` marker subjects when the
 * commit they target is part of the combination.
 */

/** Separator between combined messages: one blank line between blocks. */
const REBASE_SQUASH_SEPARATOR = '\n\n\n';

const AUTOSQUASH_SUBJECT_REGEX = /^(fixup|squash|amend)! (.+)/;

/** First line of a commit message. */
function getSubject(message: string): string {
  const newline = message.indexOf('\n');
  return newline === -1 ? message : message.slice(0, newline);
}

/** Whether the message's subject is a `fixup!`/`squash!`/`amend!` marker. */
function isAutosquashCommitMessage(message: string): boolean {
  return AUTOSQUASH_SUBJECT_REGEX.test(getSubject(message));
}

/** The message with its subject line removed (empty if there is no body). */
function removeSubject(message: string): string {
  const newline = message.indexOf('\n');
  return newline === -1 ? '' : message.slice(newline + 1).trim();
}

/**
 * Drop an autosquash marker subject (`fixup! …`/`squash! …`/`amend! …`),
 * keeping the body; a non-autosquash message passes through unchanged.
 */
export function trimAutosquashSubject(message: string): string {
  return isAutosquashCommitMessage(message) ? removeSubject(message) : message;
}

/** Combine two messages the way a rebase squash does. */
export function squashMessages(message1: string, message2: string): string {
  return message1 + REBASE_SQUASH_SEPARATOR + message2;
}

/**
 * Whether the autosquash marker in `message` targets one of `subjects` — only
 * then is trimming the marker safe (the target's own message carries the
 * subject the marker points at).
 */
function canAutosquash(message: string, subjects: ReadonlySet<string>): boolean {
  const match = AUTOSQUASH_SUBJECT_REGEX.exec(getSubject(message));
  return match !== null && subjects.has(match[2]);
}

/**
 * Combine commit messages for a squash seed: duplicates collapse (first
 * occurrence wins), and autosquash messages whose target commit is present
 * contribute only their body (dropped entirely when that leaves nothing).
 */
/**
 * Combined message for folding one autosquash (`squash!`) commit into its
 * target, the way git4idea's GitRebaseTodoModelConverter.amendCommitMessage
 * does: the created commit's marker subject is trimmed and what remains is
 * appended to the target's message; nothing left to add returns `undefined`
 * (the target keeps its own message).
 */
export function combineAutosquashMessages(
  targetMessage: string,
  createdMessage: string
): string | undefined {
  const trimmed = trimAutosquashSubject(createdMessage);
  if (trimmed.trim().length === 0) {
    return undefined;
  }
  return squashMessages(targetMessage, trimmed);
}

export function prettySquash(messages: readonly string[]): string {
  const distinctSubjects = new Set<string>();
  for (const message of messages) {
    if (!isAutosquashCommitMessage(message)) {
      distinctSubjects.add(getSubject(message));
    }
  }

  const combined = new Set<string>();
  for (const message of messages) {
    if (canAutosquash(message, distinctSubjects)) {
      const trimmed = trimAutosquashSubject(message);
      if (trimmed.trim().length > 0) {
        combined.add(trimmed);
      }
    } else {
      combined.add(message);
    }
  }
  return [...combined].join(REBASE_SQUASH_SEPARATOR);
}

/**
 * Detection and parsing of fixup!/squash! commit subject prefixes.
 *
 * In IntelliJ's VCS log (GitLinkToCommitResolver.kt) commits whose subject
 * starts with "fixup! ", "squash!", or "amend!" are rendered with a clickable
 * link that jumps to the target commit — the one whose subject matches the
 * text after the prefix.  This module provides the pure parsing logic so the
 * HTML builder can stay free of string-matching details.
 *
 * IntelliJ reference:
 *   plugins/git4idea/backend/src/log/GitLinkToCommitResolver.kt
 *   private val prefixes = listOf("fixup!", "squash!", "amend!")
 *   private val regex = "^(${prefixes.joinToString("|")}) (.*)$".toRegex()
 *
 * We implement fixup! and squash! only (the task scope); amend! is a
 * future extension point.
 */

export interface IFixupSquashParsed {
  prefix: 'fixup!' | 'squash!';
  target: string;
}

// Matches "fixup! <target>" or "squash! <target>" (case-sensitive, leading
// exact match).  The capture groups mirror IntelliJ's regex groups.
const FIXUP_SQUASH_RE = /^(fixup!|squash!) (.+)$/;

/**
 * Parse a commit subject line for a fixup!/squash! prefix.
 *
 * @returns `{ prefix, target }` when the subject starts with "fixup! " or
 *          "squash! " (lowercase, exact), `undefined` otherwise.
 *
 * @example
 *   parseFixupSquashSubject('fixup! Add tests')
 *   // → { prefix: 'fixup!', target: 'Add tests' }
 *
 *   parseFixupSquashSubject('Normal commit')
 *   // → undefined
 */
export function parseFixupSquashSubject(subject: string): IFixupSquashParsed | undefined {
  const match = FIXUP_SQUASH_RE.exec(subject);
  if (!match) {
    return undefined;
  }
  return {
    prefix: match[1] as 'fixup!' | 'squash!',
    target: match[2],
  };
}

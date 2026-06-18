/**
 * Author name-format helper.
 *
 * IntelliJ's annotation gutter lets the user choose how an author identity is
 * rendered via the "Names" submenu (see
 * `com.intellij.openapi.vcs.actions.ShortNameType` /
 * `com.intellij.openapi.vcs.actions.ShowShortenNames`): the full name, just the
 * first or last name, initials, or the email address. This module mirrors that
 * `ShortNameType.shorten` logic for our split author/email blame data.
 *
 * Unlike IntelliJ — which receives a single string that may embed
 * `<email>` — our `IBlameLine` already carries `author` and `authorEmail`
 * separately, so the email branch reads `authorEmail` directly and only falls
 * back to scanning the name when no email is supplied.
 *
 * Pure-function boundary (no VS Code APIs, no side effects) so it can be
 * unit-tested without the extension host.
 *
 * IntelliJ reference:
 *   platform/vcs-impl/.../actions/ShortNameType.kt (INITIALS / LASTNAME /
 *     FIRSTNAME / NONE=full / EMAIL + the `shorten` transform)
 *   platform/vcs-impl/.../actions/ShowShortenNames.java (the Names submenu)
 */

/**
 * How an author identity is displayed in blame annotations. Mirrors
 * IntelliJ's {@code ShortNameType} (NONE is spelled `full` here).
 */
export type AuthorNameFormat = 'full' | 'firstname' | 'lastname' | 'initials' | 'email';

/** Default format when the setting is unset or invalid. */
export const DEFAULT_AUTHOR_NAME_FORMAT: AuthorNameFormat = 'full';

const VALID_FORMATS: ReadonlySet<string> = new Set<AuthorNameFormat>([
  'full',
  'firstname',
  'lastname',
  'initials',
  'email',
]);

/** Coerce an arbitrary config string to a valid {@link AuthorNameFormat}. */
export function normalizeAuthorNameFormat(value: string | undefined): AuthorNameFormat {
  return value && VALID_FORMATS.has(value)
    ? (value as AuthorNameFormat)
    : DEFAULT_AUTHOR_NAME_FORMAT;
}

/** Collapse internal whitespace runs to a single space and trim the ends. */
function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/** A crude "looks like an email" matcher for name-embedded fallbacks. */
const EMBEDDED_EMAIL = /\S+@\S+/;

/**
 * Render an author identity per the selected {@link AuthorNameFormat}.
 *
 * @param author - The author display name (e.g. `"John Smith"`).
 * @param email - The author email, if known. Used for the `email` format.
 * @param format - The desired rendering.
 * @returns The formatted author string (possibly empty for empty input).
 */
export function formatAuthorName(
  author: string,
  email: string | undefined,
  format: AuthorNameFormat
): string {
  const name = collapseWhitespace(author ?? '');

  if (format === 'email') {
    const explicit = (email ?? '').trim();
    if (explicit) {
      return explicit;
    }
    const embedded = name.match(EMBEDDED_EMAIL);
    return embedded ? embedded[0] : name;
  }

  if (!name) {
    return '';
  }
  if (format === 'full') {
    return name;
  }

  const parts = name.split(' ').filter((p) => p.length > 0);
  if (parts.length === 0) {
    return name;
  }

  switch (format) {
    case 'firstname':
      return parts[0];
    case 'lastname':
      return parts[parts.length - 1];
    case 'initials':
      return parts.map((p) => p.charAt(0).toUpperCase()).join('');
    default:
      return name;
  }
}

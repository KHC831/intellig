/**
 * Escape arbitrary text for safe interpolation into a MarkdownString body.
 *
 * Backslash-escapes every CommonMark ASCII punctuation character so that
 * attacker-controlled values (commit author, email, message — all sourced
 * verbatim from `git`) render as literal text and can never form markdown
 * constructs. The critical case is link syntax (`[label](destination)`):
 * on a *trusted* MarkdownString a `command:` destination is a live,
 * one-click command link, so unescaped metadata is a command-injection
 * sink. Escaping the bracket/paren punctuation neutralises it; the angle
 * brackets are escaped too so neither HTML nor autolinks can form.
 *
 * The escaped set is exactly CommonMark's backslash-escapable ASCII
 * punctuation, so the output round-trips to the original text in any
 * compliant renderer (a reader sees the literal characters, not `\`).
 */

// CommonMark: any ASCII punctuation may be backslash-escaped.
const MARKDOWN_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\]/g;

export function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_PUNCTUATION, (ch) => `\\${ch}`);
}

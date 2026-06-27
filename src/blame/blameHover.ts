import * as vscode from 'vscode';
import { IBlameLine } from '../git-core/interfaces/IGitService';
import { escapeMarkdown } from '../utils/escapeMarkdown';

/**
 * The only commands the blame hover ever links to. `isTrusted` is scoped to
 * exactly this set so that a `command:` link injected through unescaped
 * commit metadata cannot invoke anything else (see `buildBlameHover`).
 */
export const BLAME_HOVER_COMMANDS: readonly string[] = [
  'intellig.editor.revealCommitInGraph',
  'intellig.editor.copyCommitHash',
];

export interface IBlameHoverOptions {
  /** When set, the short hash links into the hosting provider's web UI. */
  providerLink?: string | undefined;
  /** Gutter hover: append a "Previous Revision" link when a parent exists. */
  showPreviousRevision?: boolean;
  /** Inline hover: append an "Open on Host" link when `providerLink` is set. */
  showOpenOnHost?: boolean;
}

/**
 * Encode a hash as a `command:` query payload. VS Code spreads a JSON-array
 * query into the command's positional arguments, so the hash is wrapped in a
 * single-element array — matching the working `LineStatusHoverProvider`
 * (`...?[uri, line]`) pattern. The command handlers read the hash as their
 * first positional argument.
 */
function commandArg(hash: string): string {
  return encodeURIComponent(JSON.stringify([hash]));
}

/**
 * Build the shared blame-hover MarkdownString used by both the gutter and
 * inline blame providers.
 *
 * Security model — the hover bears `command:` action links, so it must be a
 * *trusted* MarkdownString, but its body interpolates attacker-controllable
 * `git blame` metadata (author, email, message). Three defenses, mirroring
 * the safe `LineStatusHoverProvider` pattern, keep that from becoming a
 * command-injection sink:
 *   1. `isTrusted` is scoped to `BLAME_HOVER_COMMANDS` only — an injected
 *      `command:` link to any other command is inert.
 *   2. `supportHtml` is left off, so raw HTML in metadata can't render.
 *   3. Every dynamic field is run through `escapeMarkdown`, so injected
 *      link/markup syntax renders as literal text.
 *
 * The short hash sits inside a code span (literal) and the hex commit is
 * host-validated, so neither needs escaping; the date is derived from a
 * `Date` and is not attacker-controlled.
 */
export function buildBlameHover(
  blameLine: IBlameLine,
  opts: IBlameHoverOptions
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = { enabledCommands: [...BLAME_HOVER_COMMANDS] };
  // supportHtml intentionally left false — metadata must never render as HTML.

  // `providerLink` is built from the remote URL (attacker-deliverable via a
  // cloned repo's `.git/config`); interpolated raw into a `[…](link)` target it
  // could inject markup into the TRUSTED hover. Only use it when it's a
  // well-formed http(s) URL with no link-breaking chars — otherwise drop to the
  // no-link form.
  const safeProviderLink =
    opts.providerLink && isSafeProviderLink(opts.providerLink) ? opts.providerLink : undefined;

  const shortHash = blameLine.commit.substring(0, 7);
  const dateStr = blameLine.date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  if (safeProviderLink) {
    md.appendMarkdown(`**Commit:** [\`${shortHash}\`](${safeProviderLink})\n\n`);
  } else {
    md.appendMarkdown(`**Commit:** \`${shortHash}\`\n\n`);
  }

  md.appendMarkdown(`**Author:** ${escapeMarkdown(blameLine.author)}`);
  if (blameLine.authorEmail) {
    md.appendMarkdown(` <${escapeMarkdown(blameLine.authorEmail)}>`);
  }
  md.appendMarkdown(`\n\n`);
  md.appendMarkdown(`**Date:** ${dateStr}\n\n`);
  md.appendMarkdown(`---\n\n`);
  md.appendMarkdown(`${escapeMarkdown(blameLine.message)}\n\n`);

  md.appendMarkdown(`---\n\n`);
  const actions = [
    // Click a commit → reveal + highlight it in the Git tool-window graph
    // (scroll-to-commit), not a quick-pick dropdown.
    `[View Commit](command:intellig.editor.revealCommitInGraph?${commandArg(blameLine.commit)})`,
    `[Copy Hash](command:intellig.editor.copyCommitHash?${commandArg(blameLine.commit)})`,
  ];
  if (opts.showPreviousRevision && blameLine.previousCommit) {
    actions.push(
      `[Previous Revision](command:intellig.editor.revealCommitInGraph?${commandArg(blameLine.previousCommit)})`
    );
  }
  if (opts.showOpenOnHost && safeProviderLink) {
    actions.push(`[Open on Host](${safeProviderLink})`);
  }
  md.appendMarkdown(actions.join(' | '));

  return md;
}

/**
 * A provider link is safe to interpolate into a markdown `[…](link)` target only
 * when it's a well-formed `http(s)` URL with no characters that could break out
 * of the link target — `)`, `]`, or whitespace.
 */
function isSafeProviderLink(url: string): boolean {
  if (!/^https?:\/\//i.test(url) || /[)\]\s]/.test(url)) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

import * as vscode from 'vscode';
import { IBlameLine } from '../git-core/interfaces/IGitService';
import { escapeMarkdown } from '../utils/escapeMarkdown';

/**
 * The only commands the blame hover ever links to. `isTrusted` is scoped to
 * exactly this set so that a `command:` link injected through unescaped
 * commit metadata cannot invoke anything else (see `buildBlameHover`).
 */
export const BLAME_HOVER_COMMANDS: readonly string[] = [
  'intellig.editor.showCommit',
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

/** Encode a hash as a single-arg `command:` query payload. */
function commandArg(hash: string): string {
  return encodeURIComponent(JSON.stringify(hash));
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

  const shortHash = blameLine.commit.substring(0, 7);
  const dateStr = blameLine.date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  if (opts.providerLink) {
    md.appendMarkdown(`**Commit:** [\`${shortHash}\`](${opts.providerLink})\n\n`);
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
    `[View Commit](command:intellig.editor.showCommit?${commandArg(blameLine.commit)})`,
    `[Copy Hash](command:intellig.editor.copyCommitHash?${commandArg(blameLine.commit)})`,
  ];
  if (opts.showPreviousRevision && blameLine.previousCommit) {
    actions.push(
      `[Previous Revision](command:intellig.editor.showCommit?${commandArg(blameLine.previousCommit)})`
    );
  }
  if (opts.showOpenOnHost && opts.providerLink) {
    actions.push(`[Open on Host](${opts.providerLink})`);
  }
  md.appendMarkdown(actions.join(' | '));

  return md;
}

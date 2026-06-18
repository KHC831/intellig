import { IDiff } from '../git-core/interfaces/IGitService';

/**
 * Render a diff as IntelliJ-style plain text for an untitled `diff`-language
 * document: the given title lines, a `File:`/`Status:` block, a separator, then
 * each hunk's header followed by its `+`/`-`/space-prefixed lines.
 *
 * Shared by the shelf and stash diff viewers, which differ only in their title
 * lines (shelf shows name + created timestamp; stash shows the `Stash@{n}`
 * label).
 *
 * @param headerLines - Title lines shown above the file metadata. Each is
 *   emitted on its own line.
 * @param diff - The diff whose path, status, and hunks are rendered.
 * @returns The full document text.
 */
export function renderDiffAsText(headerLines: string[], diff: IDiff): string {
  let content = headerLines.map((line) => `${line}\n`).join('');
  content += `File: ${diff.path}\n`;
  content += `Status: ${diff.status}\n`;
  content += '─'.repeat(60) + '\n\n';

  for (const hunk of diff.hunks) {
    content += `${hunk.header}\n`;
    for (const line of hunk.lines) {
      const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';
      content += `${prefix}${line.content}\n`;
    }
    content += '\n';
  }

  return content;
}

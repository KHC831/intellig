/**
 * The single unified-diff builder for IntelliG.
 *
 * git's diff writer C-style-quotes a path with special bytes and tab-delimits
 * the `---`/`+++` names for a path with spaces, and emits
 * `\ No newline at end of file` after a side whose content lacks a trailing
 * newline. Any patch we hand back to `git apply` MUST reproduce all three or
 * `git apply` rejects it ("patch does not apply") or silently rewrites the
 * file's trailing newline.
 *
 * StagingOps and ShelfService each used to hand-roll this; the shelf copy had
 * NO path escaping and neither emitted the no-newline marker. Centralising the
 * escaping (from StagingOps) and the marker handling here closes that class for
 * every per-hunk / per-line stage, unstage, revert, and partial-shelve caller.
 */

import { IHunk } from './interfaces/IGitService';

/**
 * Quote a prefixed patch path the way git's own diff writer does.
 *
 * git C-style double-quotes the name (wrapping the `a/`|`b/` prefix INSIDE the
 * quotes, with `\t \n \" \\ \NNN` escapes) when it contains a double quote,
 * backslash, control byte, DEL, or non-ASCII byte; otherwise it emits the name
 * bare. The escapes are byte-wise over the UTF-8 encoding, matching git's
 * `quote_c_style` (e.g. `é` → `\303\251`).
 *
 * @param name - The prefixed name token, e.g. `a/<path>` or `b/<path>`.
 * @returns The bare name, or its C-style quoted form when quoting is required.
 */
export function escapePatchPath(name: string): string {
  const bytes = Buffer.from(name, 'utf8');
  const needsQuoting = bytes.some(
    (byte) => byte < 0x20 || byte === 0x22 || byte === 0x5c || byte >= 0x7f
  );
  if (!needsQuoting) {
    return name;
  }

  let out = '"';
  for (const byte of bytes) {
    switch (byte) {
      case 0x07:
        out += '\\a';
        break;
      case 0x08:
        out += '\\b';
        break;
      case 0x09:
        out += '\\t';
        break;
      case 0x0a:
        out += '\\n';
        break;
      case 0x0b:
        out += '\\v';
        break;
      case 0x0c:
        out += '\\f';
        break;
      case 0x0d:
        out += '\\r';
        break;
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += '\\\\';
        break;
      default:
        if (byte < 0x20 || byte >= 0x7f) {
          out += '\\' + byte.toString(8).padStart(3, '0');
        } else {
          out += String.fromCharCode(byte);
        }
    }
  }
  return out + '"';
}

/**
 * Build the `diff --git` / `---` / `+++` header lines for a single-file patch,
 * quoting the path exactly as git would (see {@link escapePatchPath}).
 *
 * `git apply` parses the path off the `---`/`+++` lines treating a TAB as a
 * field delimiter and a NEWLINE as a line delimiter, so a raw `a/<path>` on a
 * name carrying a tab/newline (or other special byte) makes git stage the
 * WRONG file or reject the patch. When the path is unquoted but contains a
 * space, git tab-delimits the `---`/`+++` name so its parser still finds the
 * end of the filename — mirror that too.
 *
 * @param path - The file path (no `a/`|`b/` prefix).
 * @returns The three header lines, in order.
 */
export function buildPatchHeader(path: string): string[] {
  const a = escapePatchPath(`a/${path}`);
  const b = escapePatchPath(`b/${path}`);
  const quoted = a.startsWith('"');
  const tail = !quoted && path.includes(' ') ? '\t' : '';
  return [`diff --git ${a} ${b}`, `--- ${a}${tail}`, `+++ ${b}${tail}`];
}

/** The literal git emits for a side whose content lacks a trailing newline. */
export const NO_NEWLINE_MARKER = '\\ No newline at end of file';

/**
 * Serialize one hunk's body (the `+`/`-`/` ` lines) into an array of patch
 * lines, emitting {@link NO_NEWLINE_MARKER} after any line flagged
 * `noNewline`. Shared by the whole-hunk and per-line patch builders so the
 * marker is never dropped on round-trip.
 */
export function serializeHunkLines(hunk: IHunk): string[] {
  const out: string[] = [];
  for (const line of hunk.lines) {
    switch (line.type) {
      case 'add':
        out.push(`+${line.content}`);
        break;
      case 'delete':
        out.push(`-${line.content}`);
        break;
      case 'context':
        out.push(` ${line.content}`);
        break;
    }
    if (line.noNewline) {
      out.push(NO_NEWLINE_MARKER);
    }
  }
  return out;
}

/**
 * Build a complete single-hunk patch (header + hunk header + body), ready for
 * `git apply`. The hunk's own `header` line is used verbatim.
 */
export function buildHunkPatch(path: string, hunk: IHunk): string {
  const lines = [...buildPatchHeader(path), hunk.header, ...serializeHunkLines(hunk)];
  return lines.join('\n') + '\n';
}

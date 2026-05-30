/**
 * `render.ts` — `formatRecord` and `parseRecord` for the IntelliG Logger.
 *
 * `formatRecord(record)` is the production-side renderer used by the
 * OutputChannel sink (task 2.1) to turn an already-sanitized
 * `LogRecord` into the multi-line block defined by Requirement 3.2 and
 * design.md → "OutputChannel sink rendering grammar":
 *
 * ```text
 * [<timestamp>] <LEVEL> <component>: <message>
 * [  ctx=<json>]
 * [  cid=<correlationId>]
 * [  err=<error.message>]
 * [  <error.stack-line-1>]
 * [  <error.stack-line-2>]
 * [  ...]
 * ```
 *
 * The sink appends the returned string with `outputChannel.appendLine`,
 * which supplies the trailing line-terminator; `formatRecord` therefore
 * returns the block *without* a trailing newline. Continuation lines
 * are joined with `'\n'` so the whole record renders as one block in
 * the channel.
 *
 * `parseRecord(s)` is the inverse (test-only): given a rendered block
 * it reconstructs a `LogRecord`. The pair is specified to round-trip
 * via sanitization (Requirement 14.1): for any record `R`,
 * `sanitize(parseRecord(formatRecord(R))) === sanitize(R)`. The parser
 * is strict — malformed input throws. It is intentionally exported
 * from the same module as `formatRecord` so the two stay in lockstep.
 *
 * ### Field rendering details
 *
 * - `<timestamp>`: emitted verbatim (the Logger constructs the ISO-8601
 *   UTC string).
 * - `<LEVEL>`: uppercased and right-padded to 5 chars
 *   (`'TRACE'`, `'DEBUG'`, `'INFO '`, `'WARN '`, `'ERROR'`). Padding to
 *   a fixed width keeps the visual column for `<component>` aligned in
 *   the user-visible Output channel.
 * - `<component>`: emitted verbatim. Components are short identifiers
 *   bound by `child({ component })` calls and are not user-supplied.
 * - `<message>`: internal newlines collapse to the literal two-character
 *   sequence `\n` (and `\r` to `\r`); literal backslashes escape to
 *   `\\`. This keeps every block structurally parseable even when a
 *   service logs a multi-line string. The same escaping is applied to
 *   `error.message` so the `err=` line is single-line.
 * - `ctx=<json>`: `JSON.stringify(record.context)` on a single line,
 *   indented two spaces. Omitted when `context` is absent.
 * - `cid=<correlationId>`: indented two spaces, omitted when absent.
 * - `err=<error.message>`: indented two spaces; followed by each
 *   `error.stack` line indented two spaces. Omitted when no error.
 *
 * Stack lines are indented by two spaces (the same indent as the
 * `err=` and `ctx=` continuation prefixes) so the parser can identify
 * them as continuation lines belonging to the current record. Each
 * stack line is split by `'\n'` and re-prefixed; existing leading
 * whitespace inside the stack (e.g. the `'    at fn (…)'` shape Node
 * emits) is preserved verbatim, only with two extra spaces in front.
 *
 * ### Test-only export discipline
 *
 * `parseRecord` is callable from production code today (no
 * `__*ForTest` prefix) because it pairs with `formatRecord` as a pure
 * helper and contains no module-level state. It is "test-only" in the
 * sense that no production caller invokes it — only the property
 * tests asserting the round-trip property (task 4.7). If the IntelliG
 * runtime ever needs to parse rendered log blocks (e.g. an in-process
 * log viewer), this export is the canonical entry point.
 */

import type { JsonValue, LogLevel, LogRecord } from './sinks/types';

/**
 * Right-pad-target width for the rendered level token. `'ERROR'` and
 * `'TRACE'` already fill it; `'INFO '`, `'WARN '`, `'DEBUG'` are
 * padded to keep the column alignment consistent.
 */
const LEVEL_WIDTH = 5;

/**
 * Indent prefix applied to every continuation line in a rendered
 * block (`ctx=`, `cid=`, `err=`, and each stack line). Two spaces is
 * the convention captured by the Requirement 3.2 grammar.
 */
const CONTINUATION_INDENT = '  ';

/**
 * Type guard: narrow an arbitrary string to `LogLevel`. Used by
 * `parseRecord` to reject blocks whose header line carries a level
 * token outside the five-record-level enum.
 */
function isLogLevel(s: string): s is LogLevel {
  return s === 'trace' || s === 'debug' || s === 'info' || s === 'warn' || s === 'error';
}

/**
 * Escape backslashes and embedded line-terminators so a multi-line
 * `message` (or `error.message`) renders on a single header/continuation
 * line. The order — `\\` first, then `\n`, then `\r` — matters: doing
 * `\n` before `\\` would turn a literal `'\\n'` (two chars: backslash
 * + n) into `'\\\\n'` and then the second pass would see no
 * un-escaped backslashes to escape, leaving the inverse parser unable
 * to disambiguate the original.
 */
function escapeInline(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/**
 * Inverse of `escapeInline`. Single regex pass with a dispatch
 * function so the order of substitutions reflects the ordering used
 * during escaping (left-to-right, not nested).
 */
function unescapeInline(s: string): string {
  return s.replace(/\\([\\nr])/g, (_match, ch: string) => {
    if (ch === 'n') {
      return '\n';
    }
    if (ch === 'r') {
      return '\r';
    }
    return '\\';
  });
}

/**
 * Render a `LogRecord` to the OutputChannel block grammar
 * (Requirement 3.2). The returned string contains internal `'\n'`
 * separators between continuation lines but does NOT terminate with a
 * newline — `outputChannel.appendLine` supplies the trailing line
 * terminator (task 2.1).
 *
 * @param record an already-sanitized `LogRecord`
 * @returns multi-line rendered block (no trailing newline)
 */
export function formatRecord(record: LogRecord): string {
  const lines: string[] = [];

  const levelToken = record.level.toUpperCase().padEnd(LEVEL_WIDTH, ' ');
  const messageEscaped = escapeInline(record.message);

  lines.push(`[${record.timestamp}] ${levelToken} ${record.component}: ${messageEscaped}`);

  if (record.context !== undefined) {
    lines.push(`${CONTINUATION_INDENT}ctx=${JSON.stringify(record.context)}`);
  }

  if (record.correlationId !== undefined) {
    lines.push(`${CONTINUATION_INDENT}cid=${record.correlationId}`);
  }

  if (record.error !== undefined) {
    lines.push(`${CONTINUATION_INDENT}err=${escapeInline(record.error.message)}`);
    if (record.error.stack !== undefined && record.error.stack !== '') {
      // Split on `\n`; preserve any existing internal whitespace on
      // each stack frame line by only prefixing two more spaces. A
      // single trailing empty element (when the stack ends with a
      // bare `\n`) is dropped so the rendered block does not carry a
      // dangling indent-only line that the parser would treat as a
      // valid stack frame.
      const stackLines = record.error.stack.split('\n');
      const lastIdx = stackLines.length - 1;
      for (let idx = 0; idx < stackLines.length; idx++) {
        if (idx === lastIdx && stackLines[idx] === '') {
          continue;
        }
        lines.push(`${CONTINUATION_INDENT}${stackLines[idx]}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Header-line regex: `[<timestamp>] <LEVEL> <component>: <message>`.
 *
 * - Group 1 — timestamp: any run of chars between `[` and `]` (the
 *   ISO-8601 string the Logger constructs never contains `]`).
 * - Group 2 — level token: exactly `LEVEL_WIDTH` (5) chars, may
 *   include a trailing pad space (e.g. `'INFO '`). The parser trims
 *   and lowercases this group.
 * - Group 3 — component: lazy match up to the first `': '` separator.
 *   Component names are short identifiers bound by `child(...)` and
 *   do not normally contain `': '`; if one ever does, the lazy match
 *   keeps the first `': '` as the boundary which is consistent with
 *   how `formatRecord` writes the line.
 * - Group 4 — escaped message: anything to end-of-line.
 */
const HEADER_REGEX = /^\[([^\]]+)\] (.{5}) (.+?): (.*)$/;

/**
 * Test-only inverse of `formatRecord`. Reconstructs a `LogRecord`
 * from its rendered block. Strict: malformed input throws.
 *
 * The reconstructed record is not byte-identical to the original
 * record on its own — the round-trip property (Requirement 14.1) is
 * stated modulo sanitization, and the inline-escape pass collapses
 * literal `\n` / `\r` / `\\` characters. The pair `formatRecord` /
 * `parseRecord` is the only place where the grammar is encoded; keep
 * any future grammar evolution synchronized across both functions.
 *
 * @param s a rendered block as produced by `formatRecord` (with or
 *          without a trailing newline)
 * @returns the reconstructed `LogRecord`
 * @throws if the header line does not match the expected grammar or
 *         if a continuation line is unrecognized
 */
export function parseRecord(s: string): LogRecord {
  // Tolerate a trailing newline (appendLine appends one). Splitting on
  // `\n` after stripping a single trailing `\n` keeps the indices of
  // every other line unchanged.
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s;
  const lines = trimmed.split('\n');

  if (lines.length === 0 || lines[0] === '') {
    throw new Error('parseRecord: empty input');
  }

  const headerMatch = HEADER_REGEX.exec(lines[0]);
  if (!headerMatch) {
    throw new Error(`parseRecord: header line did not match grammar: ${JSON.stringify(lines[0])}`);
  }
  const [, timestamp, levelRaw, component, messageEscaped] = headerMatch;

  const levelLower = levelRaw.trim().toLowerCase();
  if (!isLogLevel(levelLower)) {
    throw new Error(`parseRecord: invalid level token: ${JSON.stringify(levelRaw)}`);
  }
  const level: LogLevel = levelLower;
  const message = unescapeInline(messageEscaped);

  let context: { readonly [k: string]: JsonValue | undefined } | undefined;
  let correlationId: string | undefined;
  let errorMessage: string | undefined;
  const stackLines: string[] = [];
  let inErrorBlock = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // The OutputChannel itself never emits empty separator lines
    // between records, but tolerate a stray empty line at the tail
    // (e.g. when the caller concatenated multiple appendLine outputs).
    if (line === '' && i === lines.length - 1) {
      continue;
    }

    if (line.startsWith(`${CONTINUATION_INDENT}ctx=`)) {
      const json = line.slice(CONTINUATION_INDENT.length + 'ctx='.length);
      // Allow any JSON-serializable shape; the Logger has already
      // sanitized the value tree before rendering.
      context = JSON.parse(json) as {
        readonly [k: string]: JsonValue | undefined;
      };
      inErrorBlock = false;
    } else if (line.startsWith(`${CONTINUATION_INDENT}cid=`)) {
      correlationId = line.slice(CONTINUATION_INDENT.length + 'cid='.length);
      inErrorBlock = false;
    } else if (line.startsWith(`${CONTINUATION_INDENT}err=`)) {
      errorMessage = unescapeInline(line.slice(CONTINUATION_INDENT.length + 'err='.length));
      inErrorBlock = true;
    } else if (inErrorBlock && line.startsWith(CONTINUATION_INDENT)) {
      stackLines.push(line.slice(CONTINUATION_INDENT.length));
    } else {
      throw new Error(`parseRecord: unrecognized continuation line: ${JSON.stringify(line)}`);
    }
  }

  // Build the record with optional fields omitted (rather than set to
  // `undefined`) so deep-equality checks in the round-trip property
  // test see the same shape on both sides.
  const error: LogRecord['error'] | undefined =
    errorMessage !== undefined
      ? stackLines.length > 0
        ? { message: errorMessage, stack: stackLines.join('\n') }
        : { message: errorMessage }
      : undefined;

  const base: {
    timestamp: string;
    level: LogLevel;
    component: string;
    message: string;
  } = {
    timestamp,
    level,
    component,
    message,
  };

  return {
    ...base,
    ...(context !== undefined ? { context } : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

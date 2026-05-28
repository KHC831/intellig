/**
 * Record-shape sanitizer for the structured Logger.
 *
 * The Logger emits `LogRecord` objects whose user-facing fields
 * (`message`, `error.message`, `error.stack`, `correlationId`, and
 * every string-valued leaf inside `context`) MUST be scrubbed of
 * credentials and home-dir paths before reaching a `LogSink`
 * (Requirement 4.1). This file is the single recursion-and-walk
 * point for that scrub: it delegates every string-leaf
 * transformation to `sanitizeGitError` (the existing, ADR-005-pinned
 * helper) and adds the structural concerns the JSON walker needs:
 *
 * - Recursion into arrays and plain objects (Requirement 4.2).
 * - Cycle detection via a `WeakSet` of visited objects/arrays so a
 *   self-referential `context` substitutes `'[Circular]'` on revisit
 *   instead of throwing or looping (Requirement 7.4).
 * - Silent drop of `Symbol`-keyed entries (consistent with
 *   `JSON.stringify`).
 * - A top-level `try/catch` around the walk so a thrown sanitizer
 *   produces a sentinel result the Logger can recognise without
 *   propagating the throw into caller flow (Requirement 4.5 — the
 *   Logger boundary turns the sentinel into the documented fallback
 *   warn record).
 *
 * ### ADR-005 conformance
 *
 * The pass *ordering* (credential URL → Windows backslash → Windows
 * forward slash → POSIX home) is non-obvious and historically the
 * source of regressions; ADR-005 pins it inside `sanitizeGitError`.
 * This module deliberately does NOT re-derive any redaction logic —
 * every string passes through `sanitizeGitError` so the ordering
 * remains owned by the single ADR-005 site. New redaction rules MUST
 * be added there.
 *
 * ### Class instances
 *
 * The walker enumerates a record/object's own enumerable string keys
 * (`Object.keys`) — so a class instance with no own enumerable
 * string keys renders as `{}`, and one with own string keys is
 * walked exactly like a plain object. Symbol keys are not enumerated
 * by `Object.keys` and so are dropped without an explicit branch.
 * `null` is preserved verbatim.
 *
 * ### Errors as fields
 *
 * `Error` instances appear in `LogRecord.error` (already split into
 * `message` / `stack` strings by the Logger before this walker
 * runs); they are NOT expected as raw values inside `context`.
 * If a caller does pass an `Error` inside `context`, the walker
 * treats it as a regular object — its enumerable own keys (typically
 * none) are walked. The Logger boundary is responsible for
 * extracting `error.message` / `error.stack` into the dedicated
 * `LogRecord.error` field (Requirement 4.4).
 */

import { sanitizeGitError } from '../gitError';
import type { JsonValue, LogRecord } from './sinks/types';

/**
 * Stable component name used by the sentinel record returned when the
 * top-level walk throws. The Logger inspects this constant to detect
 * a sanitization-failure result and synthesise the §4.5 fallback warn
 * record on its side; nothing else should treat this as a regular
 * component name.
 */
export const SANITIZE_FAILURE_COMPONENT = '__sanitize_failure__';

/**
 * Marker substituted in place of any object or array that the walker
 * has already seen on the current recursion stack. Matches the
 * grammar used by other JSON-walking sanitizers in the wider Node.js
 * ecosystem (e.g. `util.inspect`'s `[Circular]` token), so log
 * readers familiar with stdout traces recognise the shape.
 */
const CIRCULAR_MARKER = '[Circular]';

/**
 * Outcome of `sanitizeRecord`. The sanitizer either produces a fully
 * sanitized clone of the input (`ok: true`) or — when the walk
 * itself throws — a sentinel result (`ok: false`) that the Logger
 * boundary turns into the §4.5 fallback warn record. Modelling the
 * outcome as a tagged union keeps the failure path explicit at every
 * call site instead of relying on a magic-value record shape.
 */
export type SanitizeResult =
  | {
      readonly ok: true;
      readonly record: LogRecord;
    }
  | {
      readonly ok: false;
      /**
       * Sentinel record describing the failure. The Logger reads
       * `record.component` to recover the original component name
       * (which the walker preserves verbatim from the input record
       * even when the rest of the walk failed) so the §4.5 fallback
       * warn carries the right binding. The sentinel `message` is a
       * fixed, content-free string — no caller payload reaches a
       * sink via this path.
       */
      readonly record: LogRecord;
      readonly cause: unknown;
    };

/**
 * Walk a `LogRecord` and return a fully sanitized clone (or a
 * sentinel result when the walk throws).
 *
 * Sanitization rules applied:
 *
 * - `record.message` → `sanitizeGitError(record.message)`
 * - `record.correlationId` → `sanitizeGitError(record.correlationId)`
 *   (defensive — correlation IDs are hex by construction, but the
 *   field is typed as a string and we never trust the source).
 * - `record.error.message`, `record.error.stack` → likewise.
 * - `record.context` → recursive walk (see {@link sanitizeJsonValue}).
 *
 * Object identity is NOT preserved: every container (object/array)
 * is rebuilt as a fresh value so the Logger never mutates the
 * caller's bag (Requirement 1.6 is enforced at the Logger boundary,
 * but cloning here keeps the contract obvious).
 *
 * @param record the input record produced by the Logger emit path
 * @returns an `ok: true` result with the sanitized record, or an
 *   `ok: false` sentinel when the walk threw
 */
export function sanitizeRecord(record: LogRecord): SanitizeResult {
  try {
    const visited = new WeakSet<object>();

    const sanitized: LogRecord = {
      timestamp: record.timestamp,
      level: record.level,
      component: record.component,
      message: sanitizeString(record.message),
      ...(record.correlationId !== undefined
        ? { correlationId: sanitizeString(record.correlationId) }
        : {}),
      ...(record.context !== undefined
        ? { context: sanitizeContextRoot(record.context, visited) }
        : {}),
      ...(record.error !== undefined ? { error: sanitizeError(record.error) } : {}),
    };

    return { ok: true, record: sanitized };
  } catch (cause) {
    // Synthesise the sentinel record at the failure site. The Logger
    // turns this into the §4.5 fallback warn at the emit boundary —
    // we only need to surface enough of the original record's
    // identity (component, level, timestamp) for that warn to carry
    // the right binding. We deliberately re-use the input
    // `timestamp`/`level`/`component` verbatim WITHOUT routing them
    // through `sanitizeGitError` here: those fields are not
    // user-supplied content (timestamp is generated, level is one of
    // five literals, component is a code-supplied binding string),
    // so re-running the failing sanitizer on them would defeat the
    // point of the fallback. The Logger may apply its own
    // belt-and-braces sanitization to `component` if it chooses.
    return {
      ok: false,
      record: {
        timestamp: record.timestamp,
        level: 'warn',
        component: record.component,
        message: 'log sanitization failed',
      },
      cause,
    };
  }
}

/**
 * Sanitize a single string leaf via the ADR-005-pinned helper.
 *
 * Extracted so the recursive walker has a single seam to delegate
 * to; tests asserting "no logger-side redaction logic" can pin this
 * function as the only call site of `sanitizeGitError` inside
 * `src/utils/logger/`.
 */
function sanitizeString(value: string): string {
  return sanitizeGitError(value);
}

/**
 * Sanitize the root-level `context` map. Distinct from the recursive
 * helper because the root MUST be a string-keyed object (the
 * `LogRecord.context` type is `{ [k: string]: JsonValue | undefined }`)
 * — an array at the root would be a type violation upstream. We still
 * defend against it by treating non-object values as the empty
 * context, which keeps the Logger emit path total.
 */
function sanitizeContextRoot(
  context: { readonly [key: string]: JsonValue | undefined },
  visited: WeakSet<object>,
): { readonly [key: string]: JsonValue | undefined } {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    return {};
  }
  visited.add(context);
  const out: { [key: string]: JsonValue | undefined } = {};
  // Object.keys returns own enumerable string keys only — Symbol keys
  // are dropped silently, matching JSON.stringify behaviour.
  for (const key of Object.keys(context)) {
    const child = context[key];
    if (child === undefined) {
      // Skip undefined entries — they would not survive
      // JSON.stringify either, and the LogRecord type already
      // permits their absence.
      continue;
    }
    out[key] = sanitizeJsonValue(child, visited);
  }
  return out;
}

/**
 * Recursively sanitize a `JsonValue`. The `visited` `WeakSet` is
 * threaded through every container traversal so any cycle anywhere
 * in the tree collapses to `'[Circular]'` (Requirement 7.4) instead
 * of recursing forever.
 */
function sanitizeJsonValue(value: JsonValue, visited: WeakSet<object>): JsonValue {
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    if (visited.has(value)) {
      return CIRCULAR_MARKER;
    }
    visited.add(value);
    // Build the result eagerly; arrays with `undefined` slots become
    // `null` (mirroring JSON.stringify's array behaviour) so the
    // result remains a valid `JsonValue[]`.
    const out: JsonValue[] = [];
    for (const item of value) {
      out.push(item === undefined ? null : sanitizeJsonValue(item, visited));
    }
    return out;
  }
  // Plain object branch. `value` is typed as `JsonValue`, so by
  // construction it has no Symbol keys — but the LogRecord may have
  // received a real-world object from a caller; we still iterate via
  // Object.keys to drop any Symbol keys silently.
  if (visited.has(value)) {
    return CIRCULAR_MARKER;
  }
  visited.add(value);
  const out: { [key: string]: JsonValue | undefined } = {};
  for (const key of Object.keys(value)) {
    const child = (value as { readonly [key: string]: JsonValue | undefined })[key];
    if (child === undefined) {
      continue;
    }
    out[key] = sanitizeJsonValue(child, visited);
  }
  return out;
}

/**
 * Sanitize the dedicated `error` field. Both `message` and the
 * optional `stack` pass through `sanitizeGitError` so home-path
 * fragments embedded in stack frames (`at fn (/Users/<name>/...)`)
 * are scrubbed alongside credentialed URLs in the message body.
 */
function sanitizeError(error: NonNullable<LogRecord['error']>): NonNullable<LogRecord['error']> {
  return {
    message: sanitizeString(error.message),
    ...(error.stack !== undefined ? { stack: sanitizeString(error.stack) } : {}),
  };
}

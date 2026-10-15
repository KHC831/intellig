/**
 * Diff whitespace ignore-policy — parity with IntelliJ's diff viewer "Ignore
 * whitespace" dropdown.
 *
 * IntelliJ models this as `com.intellij.diff.tools.util.base.IgnorePolicy`
 * (platform/diff-impl/src/com/intellij/diff/tools/util/base/IgnorePolicy.java):
 *   DEFAULT                  — do not ignore
 *   TRIM_WHITESPACES         — trim leading/trailing whitespace
 *   IGNORE_WHITESPACES       — ignore all whitespace
 *   IGNORE_WHITESPACES_CHUNKS— ignore whitespace and whitespace-only (empty) lines
 * (plus two experimental/formatting policies we don't surface here).
 *
 * We map the four user-facing policies onto git's `diff`/`show` whitespace
 * flags. The flags are fixed literals — never user text — so splicing them
 * into the argv is injection-safe.
 */

/** User-facing diff whitespace ignore policies (subset of IntelliJ's IgnorePolicy). */
export type DiffIgnorePolicy =
  'default' | 'trim-whitespaces' | 'ignore-whitespaces' | 'ignore-whitespaces-empty-lines';

/** Policy applied when the setting is unset — preserves git's normal behavior. */
export const DEFAULT_DIFF_IGNORE_POLICY: DiffIgnorePolicy = 'default';

/**
 * Map a {@link DiffIgnorePolicy} onto the git whitespace flags appended to a
 * `diff`/`show` invocation. Returns an empty array for the default (no-ignore)
 * policy so current behavior is unchanged.
 *
 * - `trim-whitespaces`              → `--ignore-space-at-eol`
 * - `ignore-whitespaces`           → `--ignore-all-space` (git's `-w`)
 * - `ignore-whitespaces-empty-lines`→ `--ignore-all-space --ignore-blank-lines`
 */
export function diffIgnorePolicyFlags(policy: DiffIgnorePolicy): string[] {
  switch (policy) {
    case 'trim-whitespaces':
      return ['--ignore-space-at-eol'];
    case 'ignore-whitespaces':
      return ['--ignore-all-space'];
    case 'ignore-whitespaces-empty-lines':
      return ['--ignore-all-space', '--ignore-blank-lines'];
    case 'default':
    default:
      return [];
  }
}

/** Coerce an arbitrary config string to a valid {@link DiffIgnorePolicy}. */
export function normalizeDiffIgnorePolicy(value: string | undefined): DiffIgnorePolicy {
  switch (value) {
    case 'trim-whitespaces':
    case 'ignore-whitespaces':
    case 'ignore-whitespaces-empty-lines':
      return value;
    default:
      return DEFAULT_DIFF_IGNORE_POLICY;
  }
}

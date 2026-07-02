/**
 * Git version detection + capability gating.
 *
 * Some rebase flags are version-gated and FAIL HARD on older git rather than
 * degrading gracefully:
 *   - `--update-refs` was added in git 2.38; on older git
 *     `git rebase --update-refs` aborts with "error: unknown option
 *     `update-refs'". We must refuse it with a clear message instead of
 *     passing it blindly.
 *
 * (Other flags merely no-op silently — `--keep-empty`/`--autosquash` need the
 * merge backend, the default since 2.26 — and so don't need a hard pre-flight
 * guard.)
 *
 * Kept tiny + dependency-free so the parser can be unit-tested in isolation.
 */

/** A parsed git semantic version (patch optional, defaults to 0). */
export interface IGitVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * The oldest git IntelliG supports. Judge every new flag against this floor
 * (the discipline gap behind past field failures: `fetch --porcelain` needed
 * git 2.41 and broke older gits until the ref-snapshot redesign). The floor
 * is set by the newest flag we emit UNCONDITIONALLY:
 *   - `pull --autostash` in MERGE mode — accepted from git 2.27 (older git
 *     fatals "--autostash is only valid with --rebase"; updateProject sets it
 *     unconditionally).
 * Version-gated flags above the floor (e.g. `rebase --update-refs`, 2.38) get
 * an explicit pre-flight check instead. All mainstream 2022+ distros ship
 * >= 2.30 (Ubuntu 22.04 = 2.34), so the floor sits comfortably below the
 * field.
 */
export const MIN_SUPPORTED_GIT: IGitVersion = { major: 2, minor: 27, patch: 0 };

/**
 * Parse the `git --version` banner into a {@link IGitVersion}.
 *
 * Accepts the standard `git version 2.38.1` form and vendor-suffixed variants
 * like `git version 2.50.1 (Apple Git-155)`. Returns `undefined` when no
 * `<major>.<minor>` pair can be found (so callers can fail open rather than
 * mis-gate on an unparseable banner).
 *
 * @param output raw stdout from `git --version`.
 */
export function parseGitVersion(output: string): IGitVersion | undefined {
  if (typeof output !== 'string') {
    return undefined;
  }
  const match = output.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    return undefined;
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: match[3] ? parseInt(match[3], 10) : 0,
  };
}

/**
 * Whether `version` is at least `major.minor`. An `undefined` version (banner
 * unparseable) is treated as "new enough" — fail open so a parsing quirk never
 * blocks a flag the running git may well support.
 */
export function gitVersionAtLeast(
  version: IGitVersion | undefined,
  major: number,
  minor: number
): boolean {
  if (!version) {
    return true;
  }
  if (version.major !== major) {
    return version.major > major;
  }
  return version.minor >= minor;
}

/** Minimum git version (major, minor) that supports `git rebase --update-refs`. */
export const UPDATE_REFS_MIN: readonly [number, number] = [2, 38];

/** Whether the parsed git version supports `git rebase --update-refs` (≥ 2.38). */
export function supportsUpdateRefs(version: IGitVersion | undefined): boolean {
  return gitVersionAtLeast(version, UPDATE_REFS_MIN[0], UPDATE_REFS_MIN[1]);
}

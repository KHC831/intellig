/*
 * posix-path.mjs — one spelling of a relative path across hosts.
 *
 * `path.relative` uses the host separator, so on Windows a guard that compares
 * a scanned file against a `/`-spelled allowlist, seam or pattern silently
 * matches nothing, and its report reads `src\a.ts`. Every guard builds its
 * relative paths here instead (scripts/check-script-host-paths.mjs fences that).
 */

import * as nodePath from 'node:path';

/** `relative(from, to)` spelled with `/` on every host. */
export function posixRelative(from, to, impl = nodePath) {
  return impl.relative(from, to).split(impl.sep).join('/'); // script-path-exempt: this is the shared helper
}

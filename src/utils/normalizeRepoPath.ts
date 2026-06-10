/**
 * Canonical repository-path identity (spec L14).
 *
 * Repository identity comparisons (e.g. "is the dropdown's selected
 * repo still in the rebuilt list?") must not compare `Uri.fsPath`
 * strings directly. On Windows the same repo can surface with a
 * lower- or upper-case drive letter (`C:\repo` vs `c:\repo`) and with
 * either slash flavor (`C:\repo` vs `C:/repo`), depending on whether
 * the path came from VS Code, from `git rev-parse --show-toplevel`,
 * or from a workspace-folder URI. Comparing the raw strings then
 * reports two spellings of the same directory as different repos —
 * which is exactly the class of bug that made the repo selector jump
 * to the wrong repo after a reload.
 *
 * `normalizeRepoPath` collapses those spellings to a single canonical
 * form so identity comparisons are stable across the platforms and
 * path sources the extension sees.
 *
 * Normalization rules:
 *   - Replace every backslash with a forward slash.
 *   - Lowercase a leading Windows drive letter (`C:/...` -> `c:/...`).
 *     Drive letters are case-insensitive on Windows; the rest of the
 *     path is left as-is.
 *   - Strip a single trailing slash (except for a bare root `/`).
 *   - POSIX paths keep their case — Linux/macOS-with-case-sensitive-FS
 *     treat `/Repo` and `/repo` as distinct directories, so lowercasing
 *     the whole path would wrongly merge them.
 */
import type * as vscode from 'vscode';

/** Normalize a repository root path string to its canonical identity form. */
export function normalizeRepoPathString(fsPath: string): string {
  if (!fsPath) {
    return '';
  }

  // Unify slash flavor first so the drive-letter and trailing-slash
  // checks below only need to reason about forward slashes.
  let out = fsPath.replace(/\\/g, '/');

  // Lowercase a leading Windows drive letter: "C:/..." -> "c:/...".
  // Only the drive letter is case-folded; the remainder is untouched.
  if (/^[A-Za-z]:/.test(out)) {
    out = out[0].toLowerCase() + out.slice(1);
  }

  // Strip a single trailing slash, but never reduce a bare root to ''.
  if (out.length > 1 && out.endsWith('/')) {
    out = out.slice(0, -1);
  }

  return out;
}

/** Normalize a repository root `Uri` to its canonical identity form. */
export function normalizeRepoPath(uri: vscode.Uri): string {
  return normalizeRepoPathString(uri.fsPath);
}

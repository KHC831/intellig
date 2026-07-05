import * as os from 'os';
import * as path from 'path';

/**
 * Abbreviate a leading home-directory prefix to `~` for display. Keeps the rest
 * of the path intact — unlike gitError's sanitizer, which also anonymizes the
 * username. Display-only: never use the result as a real filesystem path.
 */
export function abbreviateHomePath(fsPath: string): string {
  const home = os.homedir();
  if (!home) {
    return fsPath;
  }
  if (fsPath === home) {
    return '~';
  }
  // Require the separator so `/Users/bob` doesn't match `/Users/bobby`.
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return fsPath.startsWith(prefix) ? '~' + path.sep + fsPath.slice(prefix.length) : fsPath;
}

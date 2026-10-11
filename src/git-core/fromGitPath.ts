import * as path from 'path';

/**
 * An absolute path git printed, spelled the way this host spells paths. Git
 * prints `D:/a/repo` on Windows where Node and VS Code spell `D:\a\repo`, so
 * every absolute path read from git output goes through here before anything
 * compares or stores it.
 */
export function fromGitPath(gitPath: string, impl: Pick<typeof path, 'normalize'> = path): string {
  return impl.normalize(gitPath);
}

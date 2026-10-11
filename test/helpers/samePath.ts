import { canonicalizeFsPath } from '../../src/utils/repoRelativePath';

/**
 * Whether two paths name the same file. Spellings differ by host: git prints
 * `D:/a/x` where Node spells `D:\a\x`, Windows temp dirs surface as 8.3 short
 * names, and macOS temp paths resolve through `/private`. Compare paths from
 * different sources through here, never with `===` on one resolved side.
 */
export function isSamePath(a: string, b: string): boolean {
  return canonicalizeFsPath(a) === canonicalizeFsPath(b);
}

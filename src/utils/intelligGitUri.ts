/**
 * Shared reader for `intellig-git:` revision-document URIs.
 *
 * Producers emit one of two query shapes (see `provideGitShowContent` in
 * registration/wiring.ts, which documents the discriminator):
 *   - STRUCTURED: `ref=<ref>&repoRoot=<absRepoRoot>` (both keys always
 *     present when a producer knows the repo root);
 *   - LEGACY: the whole query is `encodeURIComponent(ref)`.
 *
 * Consumers that need to know WHAT revision a virtual document shows (e.g.
 * blaming the document at its own pinned ref) parse through here instead of
 * re-implementing the shape contract.
 */

export const INTELLIG_GIT_SCHEME = 'intellig-git';

export interface IIntelligGitTarget {
  /** Repo-root-relative file path (the URI's path component). */
  filePath: string;
  /** The ref whose content the document shows. */
  ref: string;
  /** Absolute repo root, when the producer encoded one (structured form). */
  repoRoot?: string;
}

/**
 * Parse an `intellig-git:` URI into its target parts. Returns `undefined`
 * for other schemes, an empty ref, or a malformed percent-encoding.
 */
export function parseIntelligGitTarget(uri: {
  scheme: string;
  path: string;
  query: string;
}): IIntelligGitTarget | undefined {
  if (uri.scheme !== INTELLIG_GIT_SCHEME) {
    return undefined;
  }
  const params = new URLSearchParams(uri.query);
  if (params.has('ref') && params.has('repoRoot')) {
    const ref = params.get('ref') ?? '';
    if (!ref) {
      return undefined;
    }
    return { filePath: uri.path, ref, repoRoot: params.get('repoRoot') ?? undefined };
  }
  try {
    const ref = decodeURIComponent(uri.query);
    if (!ref) {
      return undefined;
    }
    return { filePath: uri.path, ref };
  } catch {
    return undefined;
  }
}

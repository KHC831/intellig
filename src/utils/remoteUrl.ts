/**
 * Remote-URL parser.
 *
 * Extracts `{ host, owner, repo }` from a git remote URL. Supports:
 *   - HTTPS:     https://github.com/owner/repo.git
 *   - HTTPS:     https://gitlab.example.com/group/subgroup/repo (no .git)
 *   - SSH:       git@github.com:owner/repo.git
 *   - SSH alt:   ssh://git@github.com/owner/repo.git
 *   - Bare:      github.com/owner/repo
 *
 * Hosts covered explicitly: github.com, gitlab.com, bitbucket.org, plus any
 * subdomain of those. A heuristic `*.<tld>` fallback recognises self-hosted
 * GitLab (gitlab.example.com) — callers that care about provider-specific
 * URL schemes should still dispatch on the detected host family.
 */

/**
 * Parsed remote-URL structure.
 */
export interface IRemoteUrl {
  /** Lowercased hostname, e.g. `github.com` or `gitlab.example.com`. */
  host: string;
  /** Path segment immediately after the host — typically the user/org. */
  owner: string;
  /** Final path segment, with `.git` suffix stripped. */
  repo: string;
  /**
   * Detected hosting-provider family. Use this for URL-builder dispatch
   * rather than the raw host — `gitlab.example.com` still reports `gitlab`.
   */
  provider: RemoteUrlProvider;
  /**
   * For providers like GitLab that support nested groups, the full path
   * between host and the final repo segment. For a URL like
   * `gitlab.com/group/subgroup/repo.git` this is `group/subgroup`. For
   * single-level `github.com/owner/repo.git` this equals `owner`.
   */
  pathPrefix: string;
}

/**
 * Supported remote-hosting providers. `unknown` means we parsed the URL
 * but couldn't classify it — builders should return `undefined` for
 * provider-specific endpoints in that case.
 */
export type RemoteUrlProvider = 'github' | 'gitlab' | 'bitbucket' | 'unknown';

/**
 * Parse a git remote URL. Returns `undefined` if the input isn't something
 * recognisable as a git remote.
 */
export function parseRemoteUrl(rawUrl: string | undefined | null): IRemoteUrl | undefined {
  if (!rawUrl) {
    return undefined;
  }
  const url = rawUrl.trim();
  if (url.length === 0) {
    return undefined;
  }

  // Strip trailing whitespace/newlines and optional .git suffix at the end.
  // We handle that once we have the normalized path; keep input otherwise.

  // ── 1. SSH shorthand: git@host:owner/repo(.git) ─────────────────────────
  const sshMatch = url.match(/^(?:([\w-]+)@)?([a-zA-Z0-9.-]+):([^:]+?)(?:\.git)?\/?$/);
  if (sshMatch && !/^https?:|^ssh:|^git:|^file:/i.test(url)) {
    const host = sshMatch[2].toLowerCase();
    const pathPart = sshMatch[3];
    const parsed = _splitOwnerRepo(pathPart);
    if (!parsed) {
      return undefined;
    }
    return _build(host, parsed.pathPrefix, parsed.repo);
  }

  // ── 2. URL-shaped: https://, http://, ssh://, git:// ───────────────────
  // Build a URL object after normalising so malformed inputs don't throw.
  let asUrl: URL | undefined;
  try {
    asUrl = new URL(url);
  } catch {
    asUrl = undefined;
  }
  if (asUrl) {
    const host = asUrl.hostname.toLowerCase();
    const trimmedPath = asUrl.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    const pathWithoutGit = trimmedPath.replace(/\.git$/i, '');
    const parsed = _splitOwnerRepo(pathWithoutGit);
    if (!parsed) {
      return undefined;
    }
    return _build(host, parsed.pathPrefix, parsed.repo);
  }

  // ── 3. Bare host/owner/repo (no scheme, no `@:`) ───────────────────────
  const bareMatch = url.match(/^([a-zA-Z0-9.-]+)\/([^\s]+?)(?:\.git)?\/?$/);
  if (bareMatch) {
    const host = bareMatch[1].toLowerCase();
    const pathPart = bareMatch[2];
    const parsed = _splitOwnerRepo(pathPart);
    if (!parsed) {
      return undefined;
    }
    return _build(host, parsed.pathPrefix, parsed.repo);
  }

  return undefined;
}

/**
 * Classify a host as github / gitlab / bitbucket / unknown. Accepts bare
 * domains and subdomains (self-hosted GitLab is common).
 */
export function detectProvider(host: string): RemoteUrlProvider {
  const h = host.toLowerCase();
  if (h === 'github.com' || h.endsWith('.github.com')) {
    return 'github';
  }
  if (h === 'gitlab.com' || h.startsWith('gitlab.') || h.includes('.gitlab.')) {
    return 'gitlab';
  }
  if (h === 'bitbucket.org' || h.endsWith('.bitbucket.org') || h.startsWith('bitbucket.')) {
    return 'bitbucket';
  }
  return 'unknown';
}

/**
 * Split the path segment after the host into `{ pathPrefix, repo }`. For a
 * URL like `.../a/b/c.git` this returns `{ pathPrefix: 'a/b', repo: 'c' }`.
 * Returns `undefined` when there's no repo segment (e.g. user page URL).
 */
function _splitOwnerRepo(path: string): { pathPrefix: string; repo: string } | undefined {
  const trimmed = path.replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split('/').filter((p) => p.length > 0);
  if (parts.length < 2) {
    return undefined;
  }
  const repo = parts[parts.length - 1];
  const pathPrefix = parts.slice(0, -1).join('/');
  if (!pathPrefix || !repo) {
    return undefined;
  }
  return { pathPrefix, repo };
}

function _build(host: string, pathPrefix: string, repo: string): IRemoteUrl {
  const provider = detectProvider(host);
  // `owner` mirrors the first path segment (top-level user/org), while
  // `pathPrefix` captures the full path for nested-group providers.
  const owner = pathPrefix.split('/')[0];
  return { host, owner, repo, provider, pathPrefix };
}

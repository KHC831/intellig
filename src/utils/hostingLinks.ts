/**
 * T3-09 — URL builders for external hosting providers.
 *
 * Given a parsed {@link IRemoteUrl}, build deep-links into the provider's
 * web UI for:
 *   - a specific commit,
 *   - a specific issue/pull-request id,
 *   - the repository home.
 *
 * Returns `undefined` when the provider is `unknown` so callers can
 * gracefully skip the menu entry rather than generating a 404.
 *
 * Provider URL schemes used:
 *   GitHub:    https://github.com/<owner>/<repo>/commit/<hash>
 *              https://github.com/<owner>/<repo>/issues/<id>
 *   GitLab:    https://<host>/<path>/<repo>/-/commit/<hash>
 *              https://<host>/<path>/<repo>/-/issues/<id>
 *   Bitbucket: https://bitbucket.org/<owner>/<repo>/commits/<hash>
 *              https://bitbucket.org/<owner>/<repo>/issues/<id>
 */

import { IRemoteUrl } from './remoteUrl';

/**
 * Label for the "Open on ..." context-menu entry, based on the provider.
 * Returns `undefined` for unknown providers so callers can hide the entry.
 */
export function hostingProviderLabel(remote: IRemoteUrl): string | undefined {
  switch (remote.provider) {
    case 'github':
      return 'Open on GitHub';
    case 'gitlab':
      return 'Open on GitLab';
    case 'bitbucket':
      return 'Open on Bitbucket';
    default:
      return undefined;
  }
}

/**
 * Base repository URL — `https://<host>/<pathPrefix>/<repo>`. Always uses
 * HTTPS regardless of the scheme of the parsed remote.
 */
export function repoUrl(remote: IRemoteUrl): string {
  return `https://${remote.host}/${remote.pathPrefix}/${remote.repo}`;
}

/**
 * Deep-link to a specific commit hash. Returns `undefined` for unknown
 * providers (we don't guess URL shapes for self-hosted non-GitLab).
 */
export function commitUrl(remote: IRemoteUrl, hash: string): string | undefined {
  if (!hash || !/^[A-Fa-f0-9]{4,64}$/.test(hash)) return undefined;
  const base = repoUrl(remote);
  switch (remote.provider) {
    case 'github':
      return `${base}/commit/${hash}`;
    case 'gitlab':
      return `${base}/-/commit/${hash}`;
    case 'bitbucket':
      return `${base}/commits/${hash}`;
    default:
      return undefined;
  }
}

/**
 * Deep-link to an issue or pull-request id. `id` is parsed as an integer;
 * non-numeric inputs yield `undefined`.
 */
export function issueUrl(remote: IRemoteUrl, id: string | number): string | undefined {
  const n = typeof id === 'number' ? id : Number.parseInt(String(id), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const base = repoUrl(remote);
  switch (remote.provider) {
    case 'github':
      return `${base}/issues/${n}`;
    case 'gitlab':
      return `${base}/-/issues/${n}`;
    case 'bitbucket':
      return `${base}/issues/${n}`;
    default:
      return undefined;
  }
}

// ─── Issue reference detection ──────────────────────────────────────────────

/**
 * Regex that matches issue/PR references in commit messages.
 *
 * Accepts:
 *  - `#123`               — plain hash reference (GitHub, GitLab short form).
 *  - `GH-123`             — GitHub long form often used in commit subjects.
 *  - `PROJECT-42`         — JIRA-style project key + number.
 *
 * Non-word-boundary enforcement is done via a negative lookbehind on the
 * prefix (so `abc#42` doesn't match) and `\b` after the digits (so
 * `PROJ-5x` doesn't match).
 *
 * Captured groups:
 *   (prefix, id)
 */
export const ISSUE_REFERENCE_REGEX = /(?<![A-Za-z0-9_])(#|GH-|[A-Z][A-Z0-9]+-)(\d+)\b/g;

/**
 * Single reference found in a commit message.
 */
export interface IIssueReference {
  /** Original matched text, e.g. `#42` or `GH-101` or `PROJ-7`. */
  raw: string;
  /** Numeric issue id (without prefix). */
  id: string;
  /**
   * Reference kind:
   *  - `'hash'`      — `#123`
   *  - `'gh-number'` — `GH-123`
   *  - `'jira'`      — `PROJ-123` (JIRA-style project key)
   */
  kind: 'hash' | 'gh-number' | 'jira';
  /** Start index in the source text. */
  start: number;
  /** End index (exclusive) in the source text. */
  end: number;
}

/**
 * Find all issue/PR references in a commit message. Resets the global
 * regex between calls so this is safe to call repeatedly.
 */
export function findIssueReferences(message: string): IIssueReference[] {
  const out: IIssueReference[] = [];
  if (!message) return out;
  const re = new RegExp(ISSUE_REFERENCE_REGEX.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    const prefix = m[1];
    const id = m[2];
    let kind: IIssueReference['kind'] = 'hash';
    if (prefix === '#') kind = 'hash';
    else if (prefix === 'GH-') kind = 'gh-number';
    else kind = 'jira';
    out.push({
      raw: m[0],
      id,
      kind,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

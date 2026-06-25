/**
 * Regression test for the "Changed files" double-click diff in a multi-root
 * workspace.
 *
 * Bug: the commit-details file diff built legacy `intellig-git:` URIs that
 * carried only the ref (no repo root). In a workspace with several repos the
 * content provider could not tell which repo owned the commit, so it prompted
 * for a repo and — on a wrong/empty pick — opened a blank diff, or an
 * all-added ("all green") diff because the parent side resolved to nothing.
 *
 * `buildCommitFileDiffUris` must encode the resolved repo root on BOTH sides
 * (structured `?ref=…&repoRoot=…` shape) and compare the commit against its
 * first parent (`<hash>~1`).
 */

import '../../setup';
import * as assert from 'assert';
import { buildCommitFileDiffUris } from '../../../src/registration/wiring';

const HASH = 'a'.repeat(40);
const REPO_ROOT = '/workspace/repo-b';
const FILE = 'src/app.ts';
// URLSearchParams encodes a path's slashes (`/` → `%2F`); the structured
// `intellig-git:` query carries the repo root in that form.
const ENCODED_ROOT = 'repoRoot=%2Fworkspace%2Frepo-b';

describe('buildCommitFileDiffUris — multi-repo commit-file diff', () => {
  it('encodes the repo root on BOTH sides so the content provider never guesses', () => {
    const { leftUri, rightUri } = buildCommitFileDiffUris(FILE, HASH, REPO_ROOT);

    for (const str of [leftUri.toString(), rightUri.toString()]) {
      assert.ok(str.includes('intellig-git:'), `uses the intellig-git scheme, got: "${str}"`);
      assert.ok(str.includes(FILE), `carries the repo-relative file path, got: "${str}"`);
      assert.ok(
        str.includes(ENCODED_ROOT),
        `repoRoot is encoded (structured shape) so the owning repo is unambiguous, got: "${str}"`
      );
      assert.ok(str.includes('ref='), `ref is in the structured shape, got: "${str}"`);
    }
  });

  it('diffs the commit against its first parent (<hash>~1 on the left)', () => {
    const { leftUri, rightUri } = buildCommitFileDiffUris(FILE, HASH, REPO_ROOT);

    // URLSearchParams encodes `~` as %7E; the left side is the parent rev.
    assert.ok(
      leftUri.toString().includes(`ref=${HASH}%7E1`),
      `left side is the parent revision, got: "${leftUri.toString()}"`
    );
    assert.ok(
      rightUri.toString().includes(`ref=${HASH}&`),
      `right side is the commit itself, got: "${rightUri.toString()}"`
    );
  });
});

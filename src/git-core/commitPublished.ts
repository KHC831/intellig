/**
 * Published-commit probe shared by every `-x` / rewrite-guard consumer:
 * a commit is "published" when it is reachable from any remote-tracking
 * branch (`git branch --remotes --contains <hash>`).
 */

import { isHexObjectId } from './gitDirMarkers';
import type { GitCli } from './gitCli';

/** The one gitCli call the probe needs. */
export type PublishProbeCli = Pick<GitCli, 'exec'>;

/**
 * Return true when `hash` is reachable from any remote-tracking branch —
 * i.e., someone has already pushed it somewhere. An empty output means no
 * remote branch contains the commit.
 *
 * Probe failures resolve to `probeFailureMeansPublished`: rewrite guards pass
 * `true` (stay conservative, assume pushed, block the rewrite), while the
 * cherry-pick `-x` suffix passes `false` — provenance is annotated only for
 * commits KNOWN to be published.
 *
 * `hash` is passed positionally to `git branch --contains <hash>`, which has
 * no `--end-of-options`; anything that is not a valid hex object name is
 * rejected before exec as a defensive guard. `isHexObjectId` accepts 64-hex
 * too — a 40-cap regex silently skipped the already-pushed warning in
 * SHA-256 repos (this guard fails OPEN, unlike the exec-failure path).
 */
export async function isCommitPublished(
  cli: PublishProbeCli,
  cwd: string,
  hash: string,
  probeFailureMeansPublished: boolean
): Promise<boolean> {
  if (!isHexObjectId(hash, { allowPrefix: true })) {
    return false;
  }
  try {
    const res = await cli.exec(['branch', '--remotes', '--contains', hash], { cwd });
    if (res.exitCode !== 0) {
      return probeFailureMeansPublished;
    }
    return res.stdout.trim().length > 0;
  } catch {
    return probeFailureMeansPublished;
  }
}

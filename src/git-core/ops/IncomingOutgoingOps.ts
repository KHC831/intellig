import { IRepository } from '../interfaces/IGitService';
import { buildGitArgs } from '../gitCli';
import { IGitOpsContext } from './GitOpsContext';

/**
 * Incoming / outgoing commit counts for a branch relative to its upstream.
 *
 * "Incoming" = commits on the upstream not yet in the local branch (what a
 * pull would bring in); equivalent to git's "behind". "Outgoing" = local
 * commits not yet on the upstream (what a push would send); equivalent to
 * git's "ahead". The naming mirrors IntelliJ git4idea's "Incoming / Outgoing"
 * branch view, which is the surface this feeds (status badge, branch arrows,
 * the Incoming tab).
 */
export interface IIncomingOutgoing {
  /** Branch the counts are for (short name, e.g. `main`). */
  branch: string;
  /** Resolved upstream tracking ref (e.g. `origin/main`), or undefined when none. */
  upstream?: string;
  /** Commits the upstream has that the local branch lacks (pull would fetch). */
  incoming: number;
  /** Local commits the upstream lacks (push would send). */
  outgoing: number;
  /**
   * True when the branch has no configured upstream. `incoming` / `outgoing`
   * are both 0 in that case — callers render "no upstream" rather than
   * "in sync".
   */
  noUpstream: boolean;
}

/**
 * Incoming/outgoing commit-count operations extracted as an *Ops collaborator
 * of the {@link GitService} façade (the {@link IGitService} composite is
 * frozen per ADR-001, so new git capabilities land here rather than on the
 * interface). Stateless: reaches the live GitCli lazily through
 * {@link IGitOpsContext}, matching the {@link BranchOps} / {@link RemoteOps}
 * convention.
 *
 * The single git primitive is:
 *
 *   git rev-list --left-right --count <upstream>...<branch>
 *
 * which prints `<incoming>\t<outgoing>` — the left side (`<upstream>`) is the
 * count reachable only from the upstream (incoming), the right side
 * (`<branch>`) the count reachable only from the local branch (outgoing).
 * Refs are user-controlled, so they splice through {@link buildGitArgs}'s
 * `--end-of-options` guard.
 */
export class IncomingOutgoingOps {
  constructor(private readonly ctx: IGitOpsContext) {}

  /**
   * Incoming/outgoing counts for an explicit branch against its tracking
   * upstream.
   *
   * Resolves the branch's upstream via
   * `git rev-parse --abbrev-ref <branch>@{upstream}`; when the branch has no
   * upstream, returns a `noUpstream: true` result with zero counts instead of
   * throwing (a branch with no upstream is a normal state, not an error).
   *
   * @param repo - The repository
   * @param branch - Short branch name (e.g. `main`, `feature/foo`)
   */
  async getForBranch(repo: IRepository, branch: string): Promise<IIncomingOutgoing> {
    const cwd = repo.rootUri.fsPath;

    const upstream = await this._resolveUpstream(cwd, `${branch}@{upstream}`);
    if (!upstream) {
      return { branch, incoming: 0, outgoing: 0, noUpstream: true };
    }

    const counts = await this._countLeftRight(cwd, upstream, branch);
    return {
      branch,
      upstream,
      incoming: counts.incoming,
      outgoing: counts.outgoing,
      noUpstream: false,
    };
  }

  /**
   * Incoming/outgoing counts for the repository's current HEAD branch against
   * its upstream, using the `@{upstream}` / `HEAD` shorthand so a detached or
   * just-checked-out HEAD resolves correctly without first reading the branch
   * name.
   *
   * Returns `branch: 'HEAD'` with `noUpstream: true` when HEAD has no upstream
   * (detached HEAD, or a local branch that was never pushed / set to track).
   *
   * @param repo - The repository
   */
  async getForCurrentBranch(repo: IRepository): Promise<IIncomingOutgoing> {
    const cwd = repo.rootUri.fsPath;

    const branch = await this._resolveUpstream(cwd, 'HEAD');
    const upstream = await this._resolveUpstream(cwd, '@{upstream}');
    if (!upstream) {
      return { branch: branch ?? 'HEAD', incoming: 0, outgoing: 0, noUpstream: true };
    }

    const counts = await this._countLeftRight(cwd, '@{upstream}', 'HEAD');
    return {
      branch: branch ?? 'HEAD',
      upstream,
      incoming: counts.incoming,
      outgoing: counts.outgoing,
      noUpstream: false,
    };
  }

  /**
   * Resolve a ref to its short name via `git rev-parse --abbrev-ref`.
   * Returns undefined when the ref does not resolve (no upstream configured,
   * detached HEAD, etc.) — git exits non-zero, which is an expected,
   * non-exceptional outcome here.
   */
  private async _resolveUpstream(cwd: string, ref: string): Promise<string | undefined> {
    // NOTE: `git rev-parse --abbrev-ref` must NOT be built with
    // `--end-of-options` — rev-parse echoes that token back as an extra output
    // line (`--end-of-options\norigin/feature`), so the resolved upstream came
    // back as garbage and incoming/outgoing collapsed to 0/0 (every branch
    // looked "up to date"). The two other `rev-parse --abbrev-ref` call sites
    // exec the argv directly; match them. The ref is an internal
    // `@{upstream}` / `<branch>@{upstream}` expression and git rejects branch
    // names beginning with `-`, so there is no leading-dash injection vector.
    const result = await this.ctx.gitCli.exec(['rev-parse', '--abbrev-ref', ref], {
      cwd,
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    const value = result.stdout.trim();
    return value.length > 0 ? value : undefined;
  }

  /**
   * Run `git rev-list --left-right --count <left>...<right>` and parse the
   * `<incoming>\t<outgoing>` output. Left side → incoming, right side →
   * outgoing. Returns zero counts on any non-zero exit or unparseable output
   * (defensive — the caller renders "in sync" rather than surfacing a parse
   * failure).
   */
  private async _countLeftRight(
    cwd: string,
    left: string,
    right: string
  ): Promise<{ incoming: number; outgoing: number }> {
    const result = await this.ctx.gitCli.exec(
      buildGitArgs('rev-list', ['--left-right', '--count'], [`${left}...${right}`]),
      { cwd }
    );

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return { incoming: 0, outgoing: 0 };
    }

    const parts = result.stdout.trim().split(/\s+/);
    if (parts.length < 2) {
      return { incoming: 0, outgoing: 0 };
    }
    return {
      incoming: parseInt(parts[0], 10) || 0,
      outgoing: parseInt(parts[1], 10) || 0,
    };
  }
}

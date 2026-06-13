import type { GitCli } from '../gitCli';
import type { IRepository, IFetchResult } from '../interfaces/IGitService';

/**
 * Narrow read-through bridge handed to every *Ops collaborator. It owns NO
 * state — it forwards to the live GitService fields so the test-time
 * `(service as any)._gitCli = mock` swap (RULE G1) and per-repo cache
 * invalidation continue to work unchanged.
 */
export interface IGitOpsContext {
  /** Live accessor — reads the façade's current _gitCli on EVERY call. */
  readonly gitCli: GitCli;
  /** Forwards to GitService.invalidateCache(rootPath). */
  invalidateCache(rootPath: string): void;
  /**
   * Fire the onDidFetch event. The EventEmitter stays private on GitService;
   * collaborators fire through this so the emitter is never captured/owned by
   * a collaborator (same vocabulary as the GTWProvider fireX() capabilities).
   */
  fireDidFetch(payload: { repo: IRepository; result: IFetchResult }): void;
}

/**
 * Build an {@link IGitOpsContext} from accessor closures.
 *
 * The façade passes `() => this._gitCli` and `(p) => this.invalidateCache(p)`
 * so the returned context re-reads the live `_gitCli` field on EVERY
 * `ctx.gitCli` access (RULE G1) — the cli is never captured at construction,
 * which keeps the test-time `(service as any)._gitCli = mock` swap working.
 *
 * Closure form (rather than a `const self = this` alias) so `this` binds to
 * the GitService lexically in the caller's arrows and the module stays free
 * of `this`-aliasing.
 */
export function createGitOpsContext(
  getGitCli: () => GitCli,
  invalidateCache: (rootPath: string) => void,
  fireDidFetch: (payload: { repo: IRepository; result: IFetchResult }) => void
): IGitOpsContext {
  return {
    get gitCli(): GitCli {
      return getGitCli();
    },
    invalidateCache,
    fireDidFetch,
  };
}

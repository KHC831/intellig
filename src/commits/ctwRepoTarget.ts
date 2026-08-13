/**
 * The Commit tool window's STICKY target repository.
 *
 * The CTW renders one repository's changelists and every action targets it;
 * this class owns which one. Seeded by the first successful resolution
 * (active editor → single repo → one disambiguation prompt) and reused, so a
 * multi-root workspace never re-prompts per action; the Git tool window's
 * repository selector switches it explicitly. The root is stored as a PATH,
 * not an IRepository — repo objects are replaced on every reload, so the
 * live object is re-derived per use ({@link live}).
 */

import type { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { resolveRepo } from '../utils/resolveRepo';
import { normalizeRepoPathString } from '../utils/normalizeRepoPath';

export class CtwRepoTarget {
  private _root: string | undefined;

  constructor(private readonly _gitService: IGitService) {}

  /** Point the target at `repo` (the selector's explicit choice). */
  set(repo: IRepository): void {
    this._root = repo.rootUri.fsPath;
  }

  /** The live IRepository for the sticky root, or undefined if it closed. */
  live(): IRepository | undefined {
    if (this._root === undefined) {
      return undefined;
    }
    const wanted = normalizeRepoPathString(this._root);
    return this._gitService
      .getRepositories()
      .find((r) => normalizeRepoPathString(r.rootUri.fsPath) === wanted);
  }

  /**
   * Resolve for a USER action: sticky target first, else the interactive
   * chain (active editor → single repo → disambiguation prompt). The answer
   * is adopted, so the prompt appears at most once.
   */
  async resolveForAction(): Promise<IRepository | undefined> {
    return this.live() ?? this._resolve(false);
  }

  /**
   * Resolve for BACKGROUND work (boot reload, live pushes): sticky target
   * first, else the deterministic chain only — never a prompt. A prompt here
   * is the "Select a repository on every action" bug. A resolution is
   * adopted so later actions target the repo the view actually renders.
   */
  async resolveForBackground(): Promise<IRepository | undefined> {
    return this.live() ?? this._resolve(true);
  }

  private async _resolve(nonInteractive: boolean): Promise<IRepository | undefined> {
    const resolved = await resolveRepo(this._gitService, {
      preferActive: true,
      silent: true,
      ...(nonInteractive ? { nonInteractive: true } : {}),
    });
    if (resolved && this._root === undefined) {
      this._root = resolved.rootUri.fsPath;
    }
    return resolved;
  }
}

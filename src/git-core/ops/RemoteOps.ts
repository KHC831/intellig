import * as vscode from 'vscode';
import {
  IRepository,
  ICommitOptions,
  IFetchOptions,
  IFetchResult,
  IFetchRefUpdate,
  IPullOptions,
  IPushOptions,
  IRemote,
} from '../interfaces/IGitService';
import { buildGitArgs } from '../gitCli';
import { parseRemotes } from '../gitParser';
import { IGitOpsContext } from './GitOpsContext';

/**
 * Commit + remote-interaction git verbs (commit/amend/fetch/pull/push and
 * remote add/remove/list) extracted from the {@link GitService} façade.
 * Stateless: reaches the live GitCli + cache invalidation lazily through
 * {@link IGitOpsContext}, and fires onDidFetch through the context's
 * fire-through capability so the emitter stays owned by GitService.
 */
export class RemoteOps {
  constructor(private readonly ctx: IGitOpsContext) {}

  /**
   * Commit staged changes to the repository.
   *
   * @param repo - The repository to commit to
   * @param message - The commit message
   * @param options - Commit options (amend, signOff, noVerify, allowEmpty)
   * @throws Error if commit message is empty (unless amending or allowEmpty is true)
   */
  async commit(repo: IRepository, message: string, options: ICommitOptions = {}): Promise<void> {
    // Validate commit message - prevent empty messages unless amending or allowEmpty
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !options.amend && !options.allowEmpty) {
      throw new Error('Commit message cannot be empty');
    }

    const args = ['commit', '-m', message];

    if (options.amend) {
      args.push('--amend');
    }
    if (options.signOff) {
      args.push('--signoff');
    }
    if (options.noVerify) {
      args.push('--no-verify');
    }
    if (options.allowEmpty) {
      args.push('--allow-empty');
    }
    // `--author="Name <email>"` override.
    if (options.author && options.author.trim().length > 0) {
      args.push(`--author=${options.author.trim()}`);
    }

    await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  async amend(repo: IRepository, message: string): Promise<void> {
    await this.commit(repo, message, { amend: true });
  }

  async fetch(repo: IRepository, optionsOrRemote?: IFetchOptions | string): Promise<IFetchResult> {
    // Back-compat: a plain string argument is treated as the remote name.
    const options: IFetchOptions =
      typeof optionsOrRemote === 'string' ? { remote: optionsOrRemote } : (optionsOrRemote ?? {});

    // Split flags vs. the remote ref so buildGitArgs can splice
    // `--end-of-options` between them; defends against argv injection
    // through a hostile remote name (the auto-fetch loop runs unattended
    // and remote names come from `.git/config`).
    const flags: string[] = ['--porcelain'];
    if (options.prune) {
      flags.push('--prune');
    }
    // Resolve tag-fetching policy. User-passed `tags` / `noTags` in
    // `options` always win over the `intellig.fetchTags` config so
    // programmatic callers (PushDialog retry, Pull dialog, etc.) can opt
    // out of the global policy. When neither the option nor the config
    // dictates a flag ("auto"), we emit no tag-related flag and let git's
    // own default (follow `remote.<remote>.tagOpt`) apply.
    if (options.tags) {
      flags.push('--tags');
    } else if (options.noTags) {
      flags.push('--no-tags');
    } else {
      const fetchTagsPolicy = vscode.workspace
        .getConfiguration('intellig')
        .get<string>('fetchTags', 'auto');
      if (fetchTagsPolicy === 'all') {
        flags.push('--tags');
      } else if (fetchTagsPolicy === 'never') {
        flags.push('--no-tags');
      }
      // 'auto' (and any unexpected value) → no flag.
    }
    const refs: string[] = [];
    if (options.all) {
      flags.push('--all');
    } else if (options.remote) {
      refs.push(options.remote);
    } else {
      flags.push('--all');
    }

    const args = buildGitArgs('fetch', flags, refs);
    const cliResult = await this.ctx.gitCli.exec(args, {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });

    const result = this._parseFetchPorcelain(cliResult.stdout, cliResult.stderr);
    this.ctx.invalidateCache(repo.rootUri.fsPath);
    this.ctx.fireDidFetch({ repo, result });
    return result;
  }

  /**
   * Parse `git fetch --porcelain` output.
   *
   * Each porcelain line has the shape `<flag> <old-sha> <new-sha> <ref>`
   * (whitespace-separated). We skip lines that do not conform and surface
   * stderr diagnostics as non-fatal errors.
   */
  private _parseFetchPorcelain(stdout: string, stderr: string): IFetchResult {
    const updatedRefs: IFetchRefUpdate[] = [];
    const errors: string[] = [];

    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const parts = line.split(/\s+/);
      if (parts.length < 4) {
        continue;
      }
      const oldSha = parts[1];
      const newSha = parts[2];
      const ref = parts.slice(3).join(' ');
      if (!/^[0-9a-f]{40}$/.test(newSha)) {
        continue;
      }
      if (oldSha === newSha) {
        continue;
      }
      updatedRefs.push({ ref, oldSha, newSha });
    }

    if (stderr) {
      for (const rawLine of stderr.split('\n')) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        // Skip informational lines git emits on stderr.
        if (/^From\s|^\s*->\s|^\s*\*\s|^\s*\+/.test(line)) {
          continue;
        }
        errors.push(line);
      }
    }

    return {
      updatedRefs,
      ahead: 0,
      behind: updatedRefs.length,
      errors,
    };
  }

  async pull(repo: IRepository, options?: IPullOptions): Promise<void> {
    // Order: git pull [--rebase|--ff-only|--no-ff] [--squash] [--no-commit] [--no-verify] <remote> <branch>
    // Split flags vs. refs (remote/branch) so buildGitArgs can
    // splice `--end-of-options` between them; defends against argv
    // injection through hostile remote/branch names.
    const flags: string[] = [];

    // Strategy flags are mutually exclusive; first non-empty wins to stay safe
    // even if the caller hasn't resolved the UI mutex.
    if (options?.rebase) {
      flags.push('--rebase');
    } else if (options?.ffOnly) {
      flags.push('--ff-only');
    } else if (options?.noFf) {
      flags.push('--no-ff');
    }

    if (options?.squash) {
      flags.push('--squash');
    }
    if (options?.noCommit) {
      flags.push('--no-commit');
    }
    if (options?.noVerify) {
      flags.push('--no-verify');
    }
    if (options?.prune) {
      flags.push('--prune');
    }

    const refs: string[] = [];
    if (options?.remote) {
      refs.push(options.remote);
    }
    if (options?.branch) {
      refs.push(options.branch);
    }

    const args = buildGitArgs('pull', flags, refs);
    await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  async push(repo: IRepository, options?: IPushOptions): Promise<void> {
    // Order: git push [--force|--force-with-lease] [--set-upstream] [--no-verify]
    //                 [--tags|--follow-tags] <remote> [<refspec>|<branch>]
    // Split flags vs. refs so buildGitArgs splices
    // `--end-of-options`; defends against argv injection through hostile
    // remote / refspec / branch names.
    const flags: string[] = [];

    // Force flags are mutually exclusive; `force` (bare --force) wins if a
    // caller sets both so the command can't silently downgrade the user's
    // explicit request. Safety policy still puts the onus on the UI to
    // prefer `forceWithLease`.
    if (options?.force) {
      flags.push('--force');
    } else if (options?.forceWithLease) {
      flags.push('--force-with-lease');
    }
    if (options?.setUpstream) {
      flags.push('--set-upstream');
    }
    if (options?.noVerify) {
      flags.push('--no-verify');
    }
    // Tag flags are mutually exclusive; prefer --follow-tags when both set
    // so we don't accidentally push unrelated tags.
    if (options?.followTags) {
      flags.push('--follow-tags');
    } else if (options?.tags) {
      flags.push('--tags');
    }

    const refs: string[] = [];
    if (options?.remote) {
      refs.push(options.remote);
    }
    // Explicit refspec (`local:target`) takes precedence over positional branch.
    if (options?.refspec) {
      refs.push(options.refspec);
    } else if (options?.branch) {
      refs.push(options.branch);
    }

    const args = buildGitArgs('push', flags, refs);
    await this.ctx.gitCli.exec(args, { cwd: repo.rootUri.fsPath, throwOnError: true });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  async getRemotes(repo: IRepository): Promise<IRemote[]> {
    const result = await this.ctx.gitCli.exec(['remote', '-v'], { cwd: repo.rootUri.fsPath });
    if (result.exitCode !== 0) {
      return [];
    }
    return parseRemotes(result.stdout);
  }

  async addRemote(repo: IRepository, name: string, url: string): Promise<void> {
    await this.ctx.gitCli.exec(['remote', 'add', name, url], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  async removeRemote(repo: IRepository, name: string): Promise<void> {
    await this.ctx.gitCli.exec(['remote', 'remove', name], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Change a remote's fetch URL (`git remote set-url <name> <url>`).
   * `git remote` has no `--end-of-options`, so a leading-dash guard on both
   * args is the argv-injection defense (mirrors the branch/stash name guards).
   */
  async setRemoteUrl(repo: IRepository, name: string, url: string): Promise<void> {
    if (!name || name.startsWith('-')) {
      throw new Error(`Invalid remote name: ${name}`);
    }
    if (!url || url.startsWith('-')) {
      throw new Error(`Invalid remote URL: ${url}`);
    }
    await this.ctx.gitCli.exec(['remote', 'set-url', name, url], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Rename a remote (`git remote rename <old> <new>`). Both names are
   * leading-dash-guarded against argv injection.
   */
  async renameRemote(repo: IRepository, oldName: string, newName: string): Promise<void> {
    if (!oldName || oldName.startsWith('-')) {
      throw new Error(`Invalid remote name: ${oldName}`);
    }
    if (!newName || newName.startsWith('-')) {
      throw new Error(`Invalid remote name: ${newName}`);
    }
    await this.ctx.gitCli.exec(['remote', 'rename', oldName, newName], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }
}

/**
 * Un-Resolve File — send mis-resolved files back to conflicted state so the
 * resolution can be redone (`git checkout --merge`, via
 * {@link ConflictResolutionService.unresolveFile}). Dependency-injected so
 * unit tests drive the flow headlessly; the spine command in
 * `rebaseConflictCommands.ts` wires the real services and toasts.
 */

import type { IRepository } from '../git-core/interfaces/IGitService';

interface IUnresolveCapableService {
  unresolveFile(repo: IRepository, filePath: string): Promise<{ success: boolean; error?: string }>;
}

/** Injected seams for {@link runUnresolveFlow}. */
export interface IUnresolveFlowDeps {
  repo: IRepository;
  conflictService: IUnresolveCapableService;
  showInformationMessage: (message: string) => Thenable<string | undefined>;
  showErrorMessage: (message: string) => Thenable<string | undefined>;
}

/**
 * Un-resolve every selected path. Refuses with one honest toast when no
 * merge/rebase/cherry-pick is in progress (git would refuse each file with a
 * terser error); otherwise processes the whole selection, surfacing each
 * failure while still un-resolving the rest.
 */
export async function runUnresolveFlow(deps: IUnresolveFlowDeps, paths: string[]): Promise<void> {
  if (!deps.repo.inProgress) {
    void deps.showErrorMessage(
      'Cannot un-resolve: no merge, rebase, or cherry-pick is in progress.'
    );
    return;
  }

  const succeeded: string[] = [];
  for (const filePath of paths) {
    const result = await deps.conflictService.unresolveFile(deps.repo, filePath);
    if (result.success) {
      succeeded.push(filePath);
    } else {
      void deps.showErrorMessage(result.error ?? `Failed to un-resolve '${filePath}'`);
    }
  }

  if (succeeded.length === 1) {
    void deps.showInformationMessage(`Restored conflict in '${succeeded[0]}'`);
  } else if (succeeded.length > 1) {
    void deps.showInformationMessage(`Restored conflicts in ${succeeded.length} files`);
  }
}

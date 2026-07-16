import type * as vscode from 'vscode';
import { StashView, createStashView } from './StashView';
import { ShelfView, createShelfView } from './ShelfView';
import type { IGitService, IRepository, IFileStatus } from '../git-core/interfaces/IGitService';
import type { IShelfService } from './interfaces/IShelfService';
import type { IConflictResolutionService } from '../conflicts/interfaces/IConflictResolutionService';
import type { IChangelistService } from '../changelists/interfaces/IChangelistService';

/**
 * The context slots the singleton accessors read/write — both
 * `ICommandContext` and `IViewRegistrationContext` satisfy this structurally.
 */
export interface IStashShelfViewHost {
  readonly context: vscode.ExtensionContext;
  stashView: StashView | undefined;
  shelfView: ShelfView | undefined;
}

/** The services the two views need — `ExtensionServices` satisfies this. */
export interface IStashShelfViewServices {
  readonly gitService: IGitService;
  readonly shelfService: IShelfService;
  readonly conflictResolutionService: IConflictResolutionService;
  readonly changelistService: IChangelistService;
}

/**
 * Lazily create the shared {@link StashView} singleton with its FULL
 * dependency set. Every creation site must go through here: scattered
 * `createStashView(...)` calls drifted their dependency lists (the palette
 * fallbacks omitted the conflict service, silently dropping the
 * Resolve-Conflicts arm). Registers the view for disposal on creation.
 */
export function ensureStashView(
  host: IStashShelfViewHost,
  services: IStashShelfViewServices
): StashView {
  if (!host.stashView) {
    host.stashView = createStashView(services.gitService, services.conflictResolutionService);
    host.context.subscriptions.push(host.stashView);
  }
  return host.stashView;
}

/** {@link ShelfView} counterpart of {@link ensureStashView}. */
export function ensureShelfView(
  host: IStashShelfViewHost,
  services: IStashShelfViewServices
): ShelfView {
  if (!host.shelfView) {
    host.shelfView = createShelfView(
      services.shelfService,
      (repo: IRepository): Promise<IFileStatus[]> => services.gitService.getStatus(repo),
      services.conflictResolutionService,
      services.changelistService
    );
    host.context.subscriptions.push(host.shelfView);
  }
  return host.shelfView;
}

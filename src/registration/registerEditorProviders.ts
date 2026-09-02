/**
 * The providers that decorate an open editor rather than owning a view:
 * gutter blame, the changed-line tracker, and the change-marker hover popup.
 *
 * Grouped because they share a shape — construct against `gitService`, push to
 * `subscriptions`, no view to register and no context slot to fill (blame
 * excepted, which other features reach for).
 */

import {
  createGutterBlameProvider,
  createLineStatusHoverProvider,
  createLineStatusTracker,
} from '../services';
import type { ExtensionServices, IGitService } from '../services';
import type { IViewRegistrationContext } from './ViewRegistrationContext';

/**
 * Register every editor-decoration provider for disposal with the extension.
 *
 * @param ctx - The activation context (subscriptions + the blame slot).
 * @param services - The resolved service bundle, already narrowed by the caller.
 * @param gitService - The shared git service the providers read from.
 */
export function registerEditorDecorationProviders(
  ctx: IViewRegistrationContext,
  services: ExtensionServices,
  gitService: IGitService
): void {
  ctx.gutterBlameProvider = createGutterBlameProvider(
    services.blameService,
    gitService,
    services.blameOptionsSource
  );
  ctx.context.subscriptions.push(ctx.gutterBlameProvider);

  // Live changed-line gutter marks (LineStatusTracker parity). Self-contained
  // and config-driven, so it isn't stored on the context — just disposed.
  ctx.context.subscriptions.push(createLineStatusTracker(gitService));

  // Inline-diff hover popup on a change marker (LineStatusMarkerPopup parity):
  // the committed content for the hovered range, plus revert/copy.
  ctx.context.subscriptions.push(createLineStatusHoverProvider(gitService));
}

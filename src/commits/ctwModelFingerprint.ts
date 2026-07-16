/**
 * Pure fingerprint of the Commit Tool Window render model — vscode-free.
 *
 * Two pushes with the same fingerprint would build identical tree/shelf DOM,
 * so the host skips the post (no-op service events are the common case on the
 * repository lane). The composer is EXCLUDED: the host's composer mirror may
 * lag the webview by an in-flight `updateComposerField`, and a live update
 * never writes the composer anyway — so a composer-only delta must neither
 * trigger nor suppress a push.
 *
 * The model is already JSON-serializable with deterministic ordering (sorted
 * changelists, sorted dir groups, timestamp-sorted shelf rows), so a stable
 * JSON projection is sufficient — nothing here is order-ambiguous.
 */

import type { ICommitToolWindowInitModel } from './commitToolWindow.types';

export function fingerprintCtwModel(model: ICommitToolWindowInitModel): string {
  return JSON.stringify({
    activeTab: model.activeTab,
    grouping: model.grouping,
    local: model.local,
    shelf: model.shelf,
    selectedFiles: model.selectedFiles,
  });
}

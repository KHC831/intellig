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
    // The webview learns its retarget stamp ONLY from a pushed model, and the
    // host drops any repo-scoped message carrying a stale one. Two clean repos
    // in a multi-root workspace differ in nothing else, so leaving this out
    // makes a switch between them skip the push and wedge the view — Commit
    // included — with no toast and no way back. A field the host GUARDS on is
    // part of what makes a model distinct.
    repoRoot: model.repoRoot,
    activeTab: model.activeTab,
    grouping: model.grouping,
    local: model.local,
    shelf: model.shelf,
    selectedFiles: model.selectedFiles,
  });
}

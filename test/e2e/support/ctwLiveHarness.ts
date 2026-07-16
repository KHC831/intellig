/**
 * E2E harness for the Commit Tool Window's live-update seam.
 *
 * The Electron host never opens the CTW panel UI, so the singleton stays
 * unresolved and its never-resolved guard keeps the push path dormant. These
 * helpers give it a recording webview stand-in (satisfying the guard) so a
 * spec can drive REAL git mutations in a fixture and assert the typed
 * `updateModel` posts the host emits — the watcher → service-event → push
 * chain no mock-based lane can exercise.
 */

import type { CommitToolWindow } from '../../../src/commits/CommitToolWindow';
import type { IStash } from '../../../src/git-core/interfaces/IGitService';

/** One changelist node (or the unversioned pseudo-node) in a recorded post. */
interface IRecordedChangelist {
  name?: string;
  files?: Array<{ path?: string }>;
  dirGroups?: Array<{ files?: Array<{ path?: string }> }>;
}

/** The slice of a posted updateModel these specs assert against. */
export interface IRecordedCtwPost {
  type?: string;
  model?: {
    local?: {
      changelists?: IRecordedChangelist[];
      unversioned?: IRecordedChangelist | null;
    };
    shelf?: { rows?: Array<{ kind?: string; name?: string }> };
  };
}

/**
 * Reaches the private view handle (to stand in for an unresolved webview) and
 * the stash mirror the push path maintains. TestSurface idiom
 * (docs/testing.md section 3): the public API cannot express "the host pushed
 * this model", which is exactly the wire contract under test.
 */
interface CommitToolWindowE2eSurface {
  _view: unknown;
  _stashEntries: IStash[];
}

export function injectRecordingView(ctw: CommitToolWindow): {
  posted: IRecordedCtwPost[];
  stashEntries(): IStash[];
  restore(): void;
} {
  const posted: IRecordedCtwPost[] = [];
  const surface = ctw as unknown as CommitToolWindowE2eSurface;
  surface._view = {
    visible: true,
    webview: {
      postMessage: (m: unknown): Promise<boolean> => {
        posted.push(m as IRecordedCtwPost);
        return Promise.resolve(true);
      },
    },
  };
  return {
    posted,
    stashEntries: () => surface._stashEntries,
    restore: () => {
      surface._view = undefined;
    },
  };
}

/** Stash-row names from the most recent updateModel post (empty if none yet). */
export function lastPushedStashNames(posted: readonly IRecordedCtwPost[]): string[] {
  const updates = posted.filter((p) => p.type === 'updateModel');
  const last = updates[updates.length - 1];
  return (last?.model?.shelf?.rows ?? [])
    .filter((r) => r.kind === 'stash')
    .map((r) => r.name ?? '');
}

function changelistPaths(cl: IRecordedChangelist | null | undefined): string[] {
  if (!cl) {
    return [];
  }
  return [
    ...(cl.files ?? []).map((f) => f.path ?? ''),
    ...(cl.dirGroups ?? []).flatMap((g) => (g.files ?? []).map((f) => f.path ?? '')),
  ];
}

/** Changelist file paths of the most recent updateModel post (both grouping modes). */
export function lastPushedChangelistPaths(posted: readonly IRecordedCtwPost[]): string[] {
  const updates = posted.filter((p) => p.type === 'updateModel');
  const last = updates[updates.length - 1];
  return (last?.model?.local?.changelists ?? []).flatMap((cl) => changelistPaths(cl));
}

/** Unversioned-bucket file paths of the most recent updateModel post. */
export function lastPushedUnversionedPaths(posted: readonly IRecordedCtwPost[]): string[] {
  const updates = posted.filter((p) => p.type === 'updateModel');
  const last = updates[updates.length - 1];
  return changelistPaths(last?.model?.local?.unversioned);
}

/**
 * Poll `condition` until it returns true or `timeoutMs` elapses. The live
 * chain crosses several debounces (250 ms watcher lane, 300 ms reconcile,
 * 300 ms push coalescer), so specs wait on observed state, not fixed sleeps.
 */
export async function pollUntil(
  condition: () => boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pollUntil timed out after ${timeoutMs}ms: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

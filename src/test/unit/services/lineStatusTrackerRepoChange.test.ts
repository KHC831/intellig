/**
 * Unit tests for LineStatusTracker's HEAD-cache invalidation on repo-state
 * change.
 *
 * The tracker diffs each open buffer against a per-URI cache of the committed
 * HEAD content. When the repo's HEAD moves (commit / checkout / pull / reset)
 * the cached HEAD is stale and the gutter keeps diffing against the OLD HEAD
 * until the file is reopened. These specs pin that the tracker subscribes to
 * the canonical `IGitService.onDidChangeRepository` event, drops its
 * `_headCache`, repaints the active editor, and disposes the subscription with
 * the tracker.
 */

import * as assert from 'assert';
import { LineStatusTracker } from '../../../linestatus/LineStatusTracker';
import { IGitService, IRepository } from '../../../git-core/interfaces/IGitService';
import { Uri, window } from '../../mocks/vscode';
import { createMockGitService, attachedRepo } from '../../mocks/mockGitService';

/** Reach into the private HEAD cache without reflection hacks. */
function headCache(tracker: LineStatusTracker): Map<string, string> {
  return (tracker as unknown as { _headCache: Map<string, string> })._headCache;
}

/** Minimal fake editor that records every setDecorations call. */
function fakeFileEditor(uri: Uri, text: string): { editor: unknown; calls: () => number } {
  let decoCalls = 0;
  const editor = {
    document: { uri, getText: () => text },
    selection: { active: { line: 0 } },
    setDecorations: (): void => {
      decoCalls++;
    },
  };
  return { editor, calls: () => decoCalls };
}

const flushDebounce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250));

describe('LineStatusTracker — repo-state cache invalidation', () => {
  let gitService: IGitService & {
    fireChangeRepository(repo: IRepository): void;
    changeRepositorySubscriberCount(): number;
  };
  let repo: IRepository;
  let tracker: LineStatusTracker | undefined;

  beforeEach(() => {
    window.activeTextEditor = undefined;
    repo = attachedRepo();
    gitService = createMockGitService(repo, {
      getRepository: async () => repo,
      // HEAD content the gutter would diff against after a refresh.
      getFileAtRevision: async () => 'a\nb\nX\n',
    } as Partial<IGitService>);
  });

  afterEach(() => {
    tracker?.dispose();
    tracker = undefined;
    window.activeTextEditor = undefined;
  });

  it('clears the cached HEAD content for every URI when the repository changes', () => {
    tracker = new LineStatusTracker(gitService);
    const cache = headCache(tracker);
    cache.set('file:///test/repo/a.ts', 'old-head-a');
    cache.set('file:///test/repo/b.ts', 'old-head-b');

    gitService.fireChangeRepository(repo);

    assert.strictEqual(cache.size, 0, 'HEAD cache must be dropped after a repo-state change');
  });

  it('repaints the active editor against fresh HEAD after the repository changes', async () => {
    const uri = Uri.file('/test/repo/file.ts');
    const fake = fakeFileEditor(uri, 'a\nb\nc\n');
    window.activeTextEditor = fake.editor;

    tracker = new LineStatusTracker(gitService);
    // Let the constructor's initial scheduleUpdate settle so the only
    // decorations counted below are the ones the repo-state repaint produces.
    await flushDebounce();
    // Seed a stale HEAD so a repaint is observable as a setDecorations call.
    headCache(tracker).set(uri.toString(), 'a\nb\nc\n');
    const before = fake.calls();

    gitService.fireChangeRepository(repo);
    await flushDebounce();

    assert.ok(
      fake.calls() > before,
      'active editor decorations must be recomputed after a repo-state change'
    );
  });

  it('disposes the repo-state subscription when the tracker is disposed', () => {
    tracker = new LineStatusTracker(gitService);
    assert.strictEqual(
      gitService.changeRepositorySubscriberCount(),
      1,
      'tracker must subscribe to onDidChangeRepository'
    );

    tracker.dispose();
    tracker = undefined;

    assert.strictEqual(
      gitService.changeRepositorySubscriberCount(),
      0,
      'repo-state subscription must be disposed with the tracker'
    );
  });
});

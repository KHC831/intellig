/**
 * Unit tests for InlineBlameProvider.
 *
 * Tests cover:
 * - enable/disable/toggle functionality
 * - Decoration creation and formatting
 * - Hover message generation
 * - Age-based color calculation
 * - Relative date formatting
 */

import * as assert from 'assert';
import { InlineBlameProvider } from '../../../src/blame/InlineBlameProvider';
import { IBlameService, IBlameInfo } from '../../../src/blame/interfaces/IBlameService';
import { IGitService, IRepository, IBlameLine } from '../../../src/git-core/interfaces/IGitService';
import { Uri, EventEmitter, window } from '../../mocks/vscode';

// Mock BlameService for testing
class MockBlameService implements IBlameService {
  public mockBlameInfo: IBlameInfo = { path: '', lines: [] };
  public getBlameCallCount = 0;
  public lastGetBlameArgs: { repo: IRepository; path: string; revision?: string } | null = null;

  private _onDidChangeBlame = new EventEmitter<{ path: string; blame: IBlameInfo }>();
  readonly onDidChangeBlame = this._onDidChangeBlame.event;

  getBlame(repo: IRepository, path: string, revision?: string): Promise<IBlameInfo> {
    this.getBlameCallCount++;
    this.lastGetBlameArgs = { repo, path, revision };
    return Promise.resolve(this.mockBlameInfo);
  }

  getBlameForLine(_repo: IRepository, _path: string, line: number): Promise<IBlameLine> {
    const blameLine = this.mockBlameInfo.lines.find((bl) => bl.line === line);
    if (blameLine) {
      return Promise.resolve(blameLine);
    }
    return Promise.resolve({
      line,
      commit: '0000000000000000000000000000000000000000',
      author: 'Not Committed Yet',
      authorEmail: '',
      date: new Date(),
      message: 'Uncommitted changes',
    });
  }

  getPreviousRevisionBlame(_repo: IRepository, path: string, _commit: string): Promise<IBlameInfo> {
    return Promise.resolve({ path, lines: [] });
  }

  dispose(): void {
    this._onDidChangeBlame.dispose();
  }
}

// Mock GitService for testing
class MockGitService {
  public mockRepository: IRepository | undefined;
  public getRepositoryCallCount = 0;

  private _onDidChangeRepository = new EventEmitter<IRepository>();
  readonly onDidChangeRepository = this._onDidChangeRepository.event;

  getRepository(_uri: unknown): Promise<IRepository | undefined> {
    this.getRepositoryCallCount++;
    return Promise.resolve(this.mockRepository);
  }

  getRepositories(): IRepository[] {
    return this.mockRepository ? [this.mockRepository] : [];
  }

  /** TestSurface: drive a repo-state change (commit / checkout / pull / reset). */
  fireRepositoryChange(repo: IRepository): void {
    this._onDidChangeRepository.fire(repo);
  }

  /** TestSurface: number of currently-active onDidChangeRepository subscribers. */
  repoSubscriberCount(): number {
    return (this._onDidChangeRepository as unknown as { listeners: unknown[] }).listeners.length;
  }

  dispose(): void {
    this._onDidChangeRepository.dispose();
  }
}

describe('InlineBlameProvider', () => {
  let inlineBlameProvider: InlineBlameProvider;
  let mockBlameService: MockBlameService;
  let mockGitService: MockGitService;
  let mockRepo: IRepository;

  beforeEach(() => {
    // Create mock services
    mockBlameService = new MockBlameService();
    mockGitService = new MockGitService();

    // Create a mock repository
    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
    mockGitService.mockRepository = mockRepo;

    // Create InlineBlameProvider with mock services
    inlineBlameProvider = new InlineBlameProvider(
      mockBlameService as unknown as IBlameService,
      mockGitService as unknown as IGitService
    );
  });

  afterEach(() => {
    inlineBlameProvider.dispose();
    mockBlameService.dispose();
    mockGitService.dispose();
  });

  describe('enable/disable/toggle', () => {
    it('should start disabled by default', () => {
      assert.strictEqual(inlineBlameProvider.isEnabled(), false);
    });

    it('should enable when enable() is called', () => {
      inlineBlameProvider.enable();
      assert.strictEqual(inlineBlameProvider.isEnabled(), true);
    });

    it('should disable when disable() is called', () => {
      inlineBlameProvider.enable();
      inlineBlameProvider.disable();
      assert.strictEqual(inlineBlameProvider.isEnabled(), false);
    });

    it('should toggle state when toggle() is called', () => {
      assert.strictEqual(inlineBlameProvider.isEnabled(), false);

      const result1 = inlineBlameProvider.toggle();
      assert.strictEqual(result1, true);
      assert.strictEqual(inlineBlameProvider.isEnabled(), true);

      const result2 = inlineBlameProvider.toggle();
      assert.strictEqual(result2, false);
      assert.strictEqual(inlineBlameProvider.isEnabled(), false);
    });

    it('should fire onDidChangeEnabled event when enabled', () => {
      let eventFired = false;
      let eventValue: boolean | undefined;

      const disposable = inlineBlameProvider.onDidChangeEnabled((enabled) => {
        eventFired = true;
        eventValue = enabled;
      });

      inlineBlameProvider.enable();

      assert.strictEqual(eventFired, true);
      assert.strictEqual(eventValue, true);

      disposable.dispose();
    });

    it('should fire onDidChangeEnabled event when disabled', () => {
      inlineBlameProvider.enable();

      let eventFired = false;
      let eventValue: boolean | undefined;

      const disposable = inlineBlameProvider.onDidChangeEnabled((enabled) => {
        eventFired = true;
        eventValue = enabled;
      });

      inlineBlameProvider.disable();

      assert.strictEqual(eventFired, true);
      assert.strictEqual(eventValue, false);

      disposable.dispose();
    });

    it('should not fire event when already enabled and enable() is called', () => {
      inlineBlameProvider.enable();

      let eventCount = 0;
      const disposable = inlineBlameProvider.onDidChangeEnabled(() => {
        eventCount++;
      });

      inlineBlameProvider.enable();

      assert.strictEqual(eventCount, 0);

      disposable.dispose();
    });

    it('should not fire event when already disabled and disable() is called', () => {
      let eventCount = 0;
      const disposable = inlineBlameProvider.onDidChangeEnabled(() => {
        eventCount++;
      });

      inlineBlameProvider.disable();

      assert.strictEqual(eventCount, 0);

      disposable.dispose();
    });
  });

  describe('formatRelativeDate (via internal testing)', () => {
    // We test the relative date formatting indirectly through the provider
    // by checking the formatted output contains expected patterns

    it('should format dates correctly', () => {
      // Set up mock blame info with various dates
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

      // These dates should produce different relative time strings
      // We can't directly test the private method, but we verify the provider
      // handles various date ranges without errors
      const dates = [now, oneHourAgo, oneDayAgo, oneWeekAgo, oneMonthAgo, oneYearAgo];

      dates.forEach((date) => {
        mockBlameService.mockBlameInfo = {
          path: 'test.ts',
          lines: [
            {
              line: 1,
              commit: 'abc123def456789012345678901234567890abcd',
              author: 'Test Author',
              authorEmail: 'test@example.com',
              date: date,
              message: 'Test commit message',
            },
          ],
        };
      });

      // Provider should handle all date ranges without throwing
      assert.doesNotThrow(() => {
        inlineBlameProvider.enable();
      });
    });
  });

  describe('age-based color calculation', () => {
    it('should handle recent commits (< 7 days)', () => {
      const recentDate = new Date();
      mockBlameService.mockBlameInfo = {
        path: 'test.ts',
        lines: [
          {
            line: 1,
            commit: 'abc123def456789012345678901234567890abcd',
            author: 'Test Author',
            authorEmail: 'test@example.com',
            date: recentDate,
            message: 'Recent commit',
          },
        ],
      };

      // Provider should handle recent dates without throwing
      assert.doesNotThrow(() => {
        inlineBlameProvider.enable();
      });
    });

    it('should handle medium-age commits (7-30 days)', () => {
      const mediumDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      mockBlameService.mockBlameInfo = {
        path: 'test.ts',
        lines: [
          {
            line: 1,
            commit: 'abc123def456789012345678901234567890abcd',
            author: 'Test Author',
            authorEmail: 'test@example.com',
            date: mediumDate,
            message: 'Medium age commit',
          },
        ],
      };

      assert.doesNotThrow(() => {
        inlineBlameProvider.enable();
      });
    });

    it('should handle old commits (30-90 days)', () => {
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      mockBlameService.mockBlameInfo = {
        path: 'test.ts',
        lines: [
          {
            line: 1,
            commit: 'abc123def456789012345678901234567890abcd',
            author: 'Test Author',
            authorEmail: 'test@example.com',
            date: oldDate,
            message: 'Old commit',
          },
        ],
      };

      assert.doesNotThrow(() => {
        inlineBlameProvider.enable();
      });
    });

    it('should handle very old commits (> 90 days)', () => {
      const veryOldDate = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
      mockBlameService.mockBlameInfo = {
        path: 'test.ts',
        lines: [
          {
            line: 1,
            commit: 'abc123def456789012345678901234567890abcd',
            author: 'Test Author',
            authorEmail: 'test@example.com',
            date: veryOldDate,
            message: 'Very old commit',
          },
        ],
      };

      assert.doesNotThrow(() => {
        inlineBlameProvider.enable();
      });
    });
  });

  describe('uncommitted changes handling', () => {
    it('should handle uncommitted changes (zero commit hash)', () => {
      mockBlameService.mockBlameInfo = {
        path: 'test.ts',
        lines: [
          {
            line: 1,
            commit: '0000000000000000000000000000000000000000',
            author: 'Not Committed Yet',
            authorEmail: '',
            date: new Date(),
            message: 'Uncommitted changes',
          },
        ],
      };

      // Provider should handle uncommitted changes without throwing
      assert.doesNotThrow(() => {
        inlineBlameProvider.enable();
      });
    });
  });

  describe('dispose', () => {
    it('should dispose without errors', () => {
      assert.doesNotThrow(() => {
        inlineBlameProvider.dispose();
      });
    });

    it('should be safe to call dispose multiple times', () => {
      assert.doesNotThrow(() => {
        inlineBlameProvider.dispose();
        inlineBlameProvider.dispose();
      });
    });

    it('should disable when disposed', () => {
      inlineBlameProvider.enable();
      inlineBlameProvider.dispose();

      // After dispose, isEnabled should return false
      assert.strictEqual(inlineBlameProvider.isEnabled(), false);
    });
  });

  describe('refresh', () => {
    it('should not throw when called while disabled', async () => {
      await assert.doesNotReject(async () => {
        await inlineBlameProvider.refresh();
      });
    });

    it('should not throw when called while enabled but no editor', async () => {
      inlineBlameProvider.enable();
      await assert.doesNotReject(async () => {
        await inlineBlameProvider.refresh();
      });
    });
  });

  describe('string truncation', () => {
    it('should handle long author names', () => {
      mockBlameService.mockBlameInfo = {
        path: 'test.ts',
        lines: [
          {
            line: 1,
            commit: 'abc123def456789012345678901234567890abcd',
            author: 'Very Long Author Name That Should Be Truncated',
            authorEmail: 'test@example.com',
            date: new Date(),
            message: 'Test commit',
          },
        ],
      };

      assert.doesNotThrow(() => {
        inlineBlameProvider.enable();
      });
    });

    it('should handle long commit messages', () => {
      mockBlameService.mockBlameInfo = {
        path: 'test.ts',
        lines: [
          {
            line: 1,
            commit: 'abc123def456789012345678901234567890abcd',
            author: 'Test Author',
            authorEmail: 'test@example.com',
            date: new Date(),
            message:
              'This is a very long commit message that should be truncated to fit in the inline display without taking up too much space',
          },
        ],
      };

      assert.doesNotThrow(() => {
        inlineBlameProvider.enable();
      });
    });

    it('should handle short strings without truncation', () => {
      mockBlameService.mockBlameInfo = {
        path: 'test.ts',
        lines: [
          {
            line: 1,
            commit: 'abc123def456789012345678901234567890abcd',
            author: 'John',
            authorEmail: 'john@example.com',
            date: new Date(),
            message: 'Fix bug',
          },
        ],
      };

      assert.doesNotThrow(() => {
        inlineBlameProvider.enable();
      });
    });
  });

  describe('hover message creation', () => {
    it('should handle blame info with email', () => {
      mockBlameService.mockBlameInfo = {
        path: 'test.ts',
        lines: [
          {
            line: 1,
            commit: 'abc123def456789012345678901234567890abcd',
            author: 'Test Author',
            authorEmail: 'test@example.com',
            date: new Date(),
            message: 'Test commit message',
          },
        ],
      };

      assert.doesNotThrow(() => {
        inlineBlameProvider.enable();
      });
    });

    it('should handle blame info without email', () => {
      mockBlameService.mockBlameInfo = {
        path: 'test.ts',
        lines: [
          {
            line: 1,
            commit: 'abc123def456789012345678901234567890abcd',
            author: 'Test Author',
            authorEmail: '',
            date: new Date(),
            message: 'Test commit message',
          },
        ],
      };

      assert.doesNotThrow(() => {
        inlineBlameProvider.enable();
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // hover includes a clickable commit-hash link when the repo has a
  // parseable remote URL. Falls back to plain hash when the parse fails.
  // ────────────────────────────────────────────────────────────────────────
  describe('hover message — issue-link wiring', () => {
    const sampleBlame: IBlameLine = {
      line: 1,
      commit: 'abc123def456789012345678901234567890abcd',
      author: 'Test Author',
      authorEmail: 'test@example.com',
      date: new Date('2024-01-15T12:00:00Z'),
      message: 'fix: close #42',
    };

    it('contains the provider commit URL when the repo has a GitHub remote', () => {
      const repo: IRepository = {
        rootUri: Uri.file('/test/repo'),
        state: 'idle',
        head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
        remotes: [{ name: 'origin', fetchUrl: 'https://github.com/acme/widgets.git' }],
        submodules: [],
      };
      const md = (
        inlineBlameProvider as unknown as {
          createHoverMessage: (bl: IBlameLine, repo?: IRepository) => { value: string };
        }
      ).createHoverMessage(sampleBlame, repo);
      assert.ok(
        md.value.includes(
          'https://github.com/acme/widgets/commit/abc123def456789012345678901234567890abcd'
        ),
        `hover value should contain commit URL; got: ${md.value}`
      );
      // The short-hash should be rendered inside a markdown link.
      assert.ok(
        md.value.includes('[`abc123d`]'),
        `hover value should link the short hash; got: ${md.value}`
      );
    });

    it('falls back to plain hash when the repo has no remotes', () => {
      const repo: IRepository = {
        rootUri: Uri.file('/test/repo'),
        state: 'idle',
        head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
        remotes: [],
        submodules: [],
      };
      const md = (
        inlineBlameProvider as unknown as {
          createHoverMessage: (bl: IBlameLine, repo?: IRepository) => { value: string };
        }
      ).createHoverMessage(sampleBlame, repo);
      // No "/commit/" provider URL, no short-hash markdown link.
      assert.ok(!md.value.includes('/commit/'), `no provider URL; got: ${md.value}`);
      assert.ok(
        md.value.includes('**Commit:** `abc123d`'),
        `plain hash rendered; got: ${md.value}`
      );
    });

    it('falls back to plain hash when parseRemoteUrl returns undefined', () => {
      const repo: IRepository = {
        rootUri: Uri.file('/test/repo'),
        state: 'idle',
        head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
        // Intentionally gibberish — parseRemoteUrl should return undefined.
        remotes: [{ name: 'origin', fetchUrl: 'not a url at all' }],
        submodules: [],
      };
      assert.doesNotThrow(() => {
        const md = (
          inlineBlameProvider as unknown as {
            createHoverMessage: (bl: IBlameLine, repo?: IRepository) => { value: string };
          }
        ).createHoverMessage(sampleBlame, repo);
        assert.ok(!md.value.includes('/commit/'), 'no provider URL on parse failure');
        assert.ok(
          md.value.includes('**Commit:** `abc123d`'),
          `plain hash rendered; got: ${md.value}`
        );
      });
    });

    it('falls back to plain hash when repo is undefined', () => {
      const md = (
        inlineBlameProvider as unknown as {
          createHoverMessage: (bl: IBlameLine, repo?: IRepository) => { value: string };
        }
      ).createHoverMessage(sampleBlame, undefined);
      assert.ok(!md.value.includes('/commit/'), 'no provider URL when repo missing');
      assert.ok(md.value.includes('`abc123d`'), 'plain short hash rendered');
    });

    it('wires View Commit / Copy Hash to registered commands (click-through)', () => {
      const md = (
        inlineBlameProvider as unknown as {
          createHoverMessage: (bl: IBlameLine, repo?: IRepository) => { value: string };
        }
      ).createHoverMessage(sampleBlame, undefined);
      assert.ok(
        md.value.includes('command:intellig.editor.revealCommitInGraph?'),
        `View Commit must reveal the commit in the graph (scroll + highlight); got: ${md.value}`
      );
      assert.ok(
        md.value.includes('command:intellig.editor.copyCommitHash?'),
        `Copy Hash must invoke the registered copy-hash command; got: ${md.value}`
      );
      assert.ok(
        !md.value.includes('command:intellig.viewCommit'),
        'must not reference the unregistered intellig.viewCommit command'
      );
    });
  });

  describe('repo-state cache invalidation', () => {
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    /** Reach into the private blame cache without reflection hacks. */
    function blameCache(provider: InlineBlameProvider): Map<string, IBlameInfo> {
      return (provider as unknown as { _blameCache: Map<string, IBlameInfo> })._blameCache;
    }

    /** Minimal fake editor that records every setDecorations call. */
    function fakeFileEditor(): { editor: unknown; calls: () => number } {
      let decoCalls = 0;
      const uri = Uri.file('/test/repo/file.ts');
      const editor = {
        document: {
          uri,
          lineAt: (line: number) => ({ text: '', lineNumber: line }),
        },
        selection: { active: { line: 0 } },
        setDecorations: (): void => {
          decoCalls++;
        },
      };
      return { editor, calls: () => decoCalls };
    }

    it('clears the blame cache when the repository changes', () => {
      blameCache(inlineBlameProvider).set('file:///test/repo/a.ts', { path: 'a.ts', lines: [] });

      mockGitService.fireRepositoryChange(mockRepo);

      assert.strictEqual(
        blameCache(inlineBlameProvider).size,
        0,
        'blame cache must be dropped after a repo-state change'
      );
    });

    it('refreshes the current editor blame after the repository changes', async () => {
      const fake = fakeFileEditor();
      window.activeTextEditor = fake.editor;
      inlineBlameProvider.enable();
      await flush();
      const before = fake.calls();

      mockGitService.fireRepositoryChange(mockRepo);
      await flush();

      assert.ok(
        fake.calls() > before,
        'current editor blame must be recomputed after a repo-state change'
      );
      window.activeTextEditor = undefined;
    });

    it('re-parses the remote URL after the repository changes (remote set-url)', () => {
      const repo: IRepository = {
        rootUri: Uri.file('/test/repo'),
        state: 'idle',
        head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
        remotes: [{ name: 'origin', fetchUrl: 'https://github.com/acme/old.git' }],
        submodules: [],
      };
      const hover = (r: IRepository): string =>
        (
          inlineBlameProvider as unknown as {
            createHoverMessage: (bl: IBlameLine, repo?: IRepository) => { value: string };
          }
        ).createHoverMessage(
          {
            line: 1,
            commit: 'abc123def456789012345678901234567890abcd',
            author: 'A',
            authorEmail: 'a@x.com',
            date: new Date('2024-01-15T12:00:00Z'),
            message: 'm',
          },
          r
        ).value;

      // Prime the per-repo remote cache against the old URL.
      assert.ok(hover(repo).includes('https://github.com/acme/old/commit/'));

      // User runs `git remote set-url origin …/new.git`; the repo object's
      // remotes update and a repo-state change fires.
      repo.remotes = [{ name: 'origin', fetchUrl: 'https://github.com/acme/new.git' }];
      mockGitService.fireRepositoryChange(repo);

      // Hover must now point at the new host, not the stale cached one.
      const after = hover(repo);
      assert.ok(
        after.includes('https://github.com/acme/new/commit/'),
        `hover must reflect the new remote after a repo change; got: ${after}`
      );
      assert.ok(!after.includes('acme/old/commit/'), 'stale remote URL must not survive');
    });

    it('disposes the repo-state subscription with the provider', () => {
      assert.strictEqual(
        mockGitService.repoSubscriberCount(),
        1,
        'provider must subscribe to onDidChangeRepository'
      );

      inlineBlameProvider.dispose();

      assert.strictEqual(
        mockGitService.repoSubscriberCount(),
        0,
        'repo-state subscription must be disposed with the provider'
      );
    });
  });

  describe('cursor-move race guard (finding #10)', () => {
    /**
     * Expose updateDecoration as a test seam so we can drive two overlapping
     * calls without needing to fire VS Code selection-change events through the
     * mock (which does not support live selection listeners).
     */
    function updateDecoration(
      provider: InlineBlameProvider,
      editor: unknown,
      line: number
    ): Promise<void> {
      return (
        provider as unknown as {
          updateDecoration(editor: unknown, line: number): Promise<void>;
        }
      ).updateDecoration(editor, line);
    }

    it('older pending lookup does not overwrite a newer decoration after cursor move', async () => {
      // Arrange: a blame service whose resolution can be delayed or immediate.
      let resolveFirst!: () => void;
      const firstCallGate = new Promise<void>((res) => {
        resolveFirst = res;
      });
      let callCount = 0;

      // Override getBlame on the shared mockBlameService: first call blocks
      // until resolveFirst() is called; second call resolves immediately.
      const origGetBlame = mockBlameService.getBlame.bind(mockBlameService);
      (
        mockBlameService as unknown as { getBlame: (...a: unknown[]) => Promise<unknown> }
      ).getBlame = async (...args) => {
        callCount++;
        if (callCount === 1) {
          await firstCallGate;
        }
        return origGetBlame(...(args as Parameters<typeof origGetBlame>));
      };

      // Set up mock blame lines for lines 5 and 10.
      mockBlameService.mockBlameInfo = {
        path: 'src/file.ts',
        lines: [
          {
            line: 6 /* 1-indexed; line arg to updateDecoration is 0-indexed */,
            commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            author: 'Line5Author',
            authorEmail: 'a@x.com',
            date: new Date('2024-01-01'),
            message: 'line 5 commit',
          },
          {
            line: 11 /* 1-indexed */,
            commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            author: 'Line10Author',
            authorEmail: 'b@x.com',
            date: new Date('2024-01-02'),
            message: 'line 10 commit',
          },
        ],
      };

      // Build a fake editor that records the LAST range's start line from each
      // non-empty setDecorations call so we can assert which decoration won.
      let lastDecoratedLine: number | undefined;
      const fakeEditor = {
        document: {
          uri: Uri.file('/test/repo/src/file.ts'),
          isDirty: false,
          getText: (): string => '',
          lineAt: (line: number) => ({ text: 'x', lineNumber: line }),
        },
        selection: { active: { line: 5 } },
        setDecorations: (_type: unknown, decos: unknown[]): void => {
          if (decos.length > 0) {
            // Each decoration is { range: Range, ... }; record the range start line.
            const first = decos[0] as { range: { start: { line: number } } };
            lastDecoratedLine = first.range.start.line;
          }
        },
      };

      inlineBlameProvider.enable();

      // Act: kick off the FIRST lookup (line 5) — it blocks on firstCallGate.
      const firstDone = updateDecoration(inlineBlameProvider, fakeEditor, 5);

      // Kick off the SECOND lookup (line 10) — it resolves immediately.
      fakeEditor.selection = { active: { line: 10 } };
      const secondDone = updateDecoration(inlineBlameProvider, fakeEditor, 10);
      await secondDone;

      // After the second resolves, line 10 should be decorated.
      assert.strictEqual(lastDecoratedLine, 10, 'second (newer) lookup must win immediately');

      // Now let the first (older) call finish.
      resolveFirst();
      await firstDone;

      // The older call must NOT overwrite line 10's decoration.
      assert.strictEqual(
        lastDecoratedLine,
        10,
        'older pending lookup must not overwrite the newer decoration after it resolves'
      );

      inlineBlameProvider.disable();
    });
  });
});

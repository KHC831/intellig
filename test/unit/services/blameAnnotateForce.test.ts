/**
 * "Annotate with Git Blame" (intellig.toggleBlame) must render the full-file
 * gutter annotation on the targeted editor regardless of the user's
 * `intellig.blameAnnotationStyle` setting — matching IntelliJ's
 * AnnotateToggleAction, where the explicit Annotate action always annotates.
 *
 * The provider therefore supports a forced enable: `enable(targetEditor, { force: true })`
 * targets the passed editor (the file the user right-clicked, freshly opened)
 * and bypasses the inline/gutter style kill-switch.
 */

import * as assert from 'assert';
import { GutterBlameProvider } from '../../../src/blame/GutterBlameProvider';
import { IBlameService, IBlameInfo } from '../../../src/blame/interfaces/IBlameService';
import { IGitService, IRepository, IBlameLine } from '../../../src/git-core/interfaces/IGitService';
import {
  Uri,
  Range,
  EventEmitter,
  setMockConfigValue,
  resetMockConfiguration,
} from '../../mocks/vscode';

class MockBlameService implements IBlameService {
  public mockBlameInfo: IBlameInfo = { path: '', lines: [] };
  private _onDidChangeBlame = new EventEmitter<{ path: string; blame: IBlameInfo }>();
  readonly onDidChangeBlame = this._onDidChangeBlame.event;
  getBlame(_repo: IRepository, _path: string): Promise<IBlameInfo> {
    return Promise.resolve(this.mockBlameInfo);
  }
  getBlameForLine(_repo: IRepository, _path: string, line: number): Promise<IBlameLine> {
    return Promise.resolve({
      line,
      commit: '0000000000000000000000000000000000000000',
      author: 'Test',
      authorEmail: '',
      date: new Date(),
      message: '',
    });
  }
  getPreviousRevisionBlame(_repo: IRepository, path: string): Promise<IBlameInfo> {
    return Promise.resolve({ path, lines: [] });
  }
  dispose(): void {
    this._onDidChangeBlame.dispose();
  }
}

class MockGitService {
  public mockRepository: IRepository | undefined;
  /**
   * Simulate a failed fresh `git rev-parse` resolution (the bug: `getRepository`
   * returns undefined for a file even though the repo is open) while the repo is
   * still present in `getRepositories()`.
   */
  public failGetRepository = false;
  private _onDidChangeRepository = new EventEmitter<IRepository>();
  readonly onDidChangeRepository = this._onDidChangeRepository.event;
  getRepository(_uri: unknown): Promise<IRepository | undefined> {
    return Promise.resolve(this.failGetRepository ? undefined : this.mockRepository);
  }
  getRepositories(): IRepository[] {
    return this.mockRepository ? [this.mockRepository] : [];
  }
  dispose(): void {
    this._onDidChangeRepository.dispose();
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Fake file editor recording the last setDecorations payload length. */
function fakeFileEditor(): {
  editor: unknown;
  lastCount: () => number;
} {
  let last = 0;
  const uri = Uri.file('/test/repo/file.ts');
  const editor = {
    document: { uri },
    selection: { active: { line: 0 } },
    visibleRanges: [new Range(0, 0, 1, 0)],
    setDecorations: (_type: unknown, decos: unknown[]): void => {
      last = decos.length;
    },
  };
  return { editor, lastCount: () => last };
}

describe('Annotate with Git Blame — forced full-file gutter', () => {
  let blameService: MockBlameService;
  let gitService: MockGitService;
  let repo: IRepository;

  beforeEach(() => {
    resetMockConfiguration();
    blameService = new MockBlameService();
    gitService = new MockGitService();
    repo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
    gitService.mockRepository = repo;
    blameService.mockBlameInfo = {
      path: 'file.ts',
      lines: [
        {
          line: 1,
          commit: 'abc123def456789012345678901234567890abcd',
          author: 'Jane',
          authorEmail: 'jane@example.com',
          date: new Date('2024-01-15T12:00:00Z'),
          message: 'first',
        },
        {
          line: 2,
          commit: 'def456abc789012345678901234567890abcd123',
          author: 'Bob',
          authorEmail: 'bob@example.com',
          date: new Date('2023-06-01T12:00:00Z'),
          message: 'second',
        },
      ],
    };
  });

  afterEach(() => {
    blameService.dispose();
    gitService.dispose();
    resetMockConfiguration();
  });

  it("renders gutter decorations for the targeted editor even when style='inline'", async () => {
    setMockConfigValue('intellig', 'blameAnnotationStyle', 'inline');
    const provider = new GutterBlameProvider(
      blameService as unknown as IBlameService,
      gitService as unknown as IGitService
    );
    const fake = fakeFileEditor();

    provider.enable(fake.editor as never, { force: true });
    await flush();

    assert.ok(
      fake.lastCount() > 0,
      'forced annotate must decorate the targeted editor even when the style gate is inline'
    );
    provider.dispose();
  });

  it("renders gutter decorations even when style='off' under force", async () => {
    setMockConfigValue('intellig', 'blameAnnotationStyle', 'off');
    const provider = new GutterBlameProvider(
      blameService as unknown as IBlameService,
      gitService as unknown as IGitService
    );
    const fake = fakeFileEditor();

    provider.enable(fake.editor as never, { force: true });
    await flush();

    assert.ok(
      fake.lastCount() > 0,
      "forced annotate must override the 'off' kill-switch (matches IntelliJ Annotate)"
    );
    provider.dispose();
  });

  it('resolves the repo from open repositories when getRepository() fails', async () => {
    // Reproduces the user-reported "Annotate enabled, nothing shows" bug: the
    // provider resolved the repo only via gitService.getRepository(uri), which
    // does a fresh `git rev-parse` that can fail (git PATH / transient) even
    // when the repo is open and cached — leaving the gutter empty. It must fall
    // back to the open-repositories ancestor match.
    setMockConfigValue('intellig', 'blameAnnotationStyle', 'gutter');
    gitService.failGetRepository = true;
    const provider = new GutterBlameProvider(
      blameService as unknown as IBlameService,
      gitService as unknown as IGitService
    );
    const fake = fakeFileEditor();

    provider.enable(fake.editor as never, { force: true });
    await flush();

    assert.ok(
      fake.lastCount() > 0,
      'annotate must resolve the open repo and decorate even when getRepository() returns undefined'
    );
    provider.dispose();
  });

  it('decorates EVERY blamed line, not just the visible viewport', async () => {
    // Scroll-lag fix: the gutter renders the whole file in one pass and lets VS
    // Code virtualize the on-screen rows. A viewport that only covers line 0 must
    // still produce decorations for BOTH blamed lines (editor lines 0 + 1). The
    // buffer is clean, so uncovered lines are NOT back-filled as Uncommitted.
    setMockConfigValue('intellig', 'blameAnnotationStyle', 'gutter');
    let lastCount = 0;
    const uri = Uri.file('/test/repo/file.ts');
    const narrowViewportEditor = {
      document: { uri, lineCount: 100, isDirty: false },
      selection: { active: { line: 0 } },
      // Only line 0 is on-screen — yet both blamed lines must be decorated.
      visibleRanges: [new Range(0, 0, 0, 0)],
      setDecorations: (_type: unknown, decos: unknown[]): void => {
        lastCount = decos.length;
      },
    };
    const provider = new GutterBlameProvider(
      blameService as unknown as IBlameService,
      gitService as unknown as IGitService
    );

    provider.enable(narrowViewportEditor as never, { force: true });
    await flush();

    assert.strictEqual(
      lastCount,
      2,
      'both blamed lines must be decorated even though only line 0 is visible'
    );
    provider.dispose();
  });

  it("does NOT render when enabled without force and style='inline'", async () => {
    setMockConfigValue('intellig', 'blameAnnotationStyle', 'inline');
    const provider = new GutterBlameProvider(
      blameService as unknown as IBlameService,
      gitService as unknown as IGitService
    );
    const fake = fakeFileEditor();

    provider.enable(fake.editor as never);
    await flush();

    assert.strictEqual(
      fake.lastCount(),
      0,
      'unforced gutter enable must still respect the style kill-switch'
    );
    provider.dispose();
  });
});

describe('GutterBlameProvider — async decoration-update race guard (finding #10)', () => {
  /**
   * Expose the private updateDecorations method as a test seam so we can
   * drive two overlapping calls without going through the enable/event path.
   */
  function updateDecorations(provider: GutterBlameProvider, editor: unknown): Promise<void> {
    return (
      provider as unknown as {
        updateDecorations(editor: unknown): Promise<void>;
      }
    ).updateDecorations(editor);
  }

  it('older pending blame fetch does not overwrite a newer full-file annotation', async () => {
    resetMockConfiguration();
    setMockConfigValue('intellig', 'blameAnnotationStyle', 'gutter');

    // Gate: first getBlame call blocks until resolveFirst() is called.
    let resolveFirst!: () => void;
    const firstCallGate = new Promise<void>((res) => {
      resolveFirst = res;
    });
    let callCount = 0;

    // Two distinct blame results: one line for the first (slow) call, two for
    // the second (fast) call. After both settle, we assert the second (two-line)
    // decoration survived, not the one-line stale result from the first.
    const blameOne: IBlameInfo = {
      path: 'src/file.ts',
      lines: [
        {
          line: 1,
          commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          author: 'SlowAuthor',
          authorEmail: 'slow@x.com',
          date: new Date('2024-01-01'),
          message: 'slow first commit',
        },
      ],
    };
    const blameTwo: IBlameInfo = {
      path: 'src/file.ts',
      lines: [
        {
          line: 1,
          commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          author: 'FastAuthor',
          authorEmail: 'fast@x.com',
          date: new Date('2024-01-02'),
          message: 'fast second commit L1',
        },
        {
          line: 2,
          commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          author: 'FastAuthor',
          authorEmail: 'fast@x.com',
          date: new Date('2024-01-03'),
          message: 'fast second commit L2',
        },
      ],
    };

    const slowBlameService = {
      onDidChangeBlame: new EventEmitter<{ path: string; blame: IBlameInfo }>().event,
      getBlame: async (): Promise<IBlameInfo> => {
        callCount++;
        if (callCount === 1) {
          await firstCallGate;
          return blameOne;
        }
        return blameTwo;
      },
      getBlameForLine: async (_r: unknown, _p: string, line: number): Promise<IBlameLine> =>
        Promise.resolve({
          line,
          commit: '0000000000000000000000000000000000000000',
          author: 'Test',
          authorEmail: '',
          date: new Date(),
          message: '',
        }),
      getPreviousRevisionBlame: async (_r: unknown, path: string): Promise<IBlameInfo> =>
        Promise.resolve({ path, lines: [] }),
      dispose: (): void => {},
    };

    const mockRepo: IRepository = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
    const gitSvc = {
      onDidChangeRepository: new EventEmitter<IRepository>().event,
      getRepositories: (): IRepository[] => [mockRepo],
      getRepository: async (): Promise<IRepository> => mockRepo,
      dispose: (): void => {},
    };

    const provider = new GutterBlameProvider(
      slowBlameService as unknown as IBlameService,
      gitSvc as unknown as IGitService
    );

    // A dirty document ensures both calls bypass the provider's local cache
    // and both hit slowBlameService.getBlame, allowing us to control timing.
    let lastDecoCount = 0;
    const fakeDoc = {
      uri: Uri.file('/test/repo/src/file.ts'),
      isDirty: true,
      getText: (): string => 'line1\nline2\n',
      lineCount: 2,
      lineAt: (l: number) => ({ lineNumber: l, text: 'x' }),
    };
    const fakeEditor = {
      document: fakeDoc,
      visibleRanges: [new Range(0, 0, 1, 0)],
      setDecorations: (_type: unknown, decos: unknown[]): void => {
        if (decos.length > 0) {
          lastDecoCount = decos.length;
        }
      },
    };

    // Act: kick off the first (slow) call.
    const firstDone = updateDecorations(provider, fakeEditor);

    // Kick off the second (fast) call — resolves immediately with 2 lines.
    const secondDone = updateDecorations(provider, fakeEditor);
    await secondDone;

    // After the fast call, 2 decorations should be applied.
    assert.strictEqual(lastDecoCount, 2, 'fast second call must paint 2 decorations immediately');

    // Release the slow first call and let it finish.
    resolveFirst();
    await firstDone;

    // The slow first call must NOT overwrite the two-line annotation.
    assert.strictEqual(
      lastDecoCount,
      2,
      'slow first call must not overwrite the newer 2-line decoration after resolving'
    );

    provider.dispose();
    resetMockConfiguration();
  });
});

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
  private _onDidChangeRepository = new EventEmitter<IRepository>();
  readonly onDidChangeRepository = this._onDidChangeRepository.event;
  getRepository(_uri: unknown): Promise<IRepository | undefined> {
    return Promise.resolve(this.mockRepository);
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

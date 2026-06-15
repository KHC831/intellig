/**
 * Tests for blameAnnotationStyle:'off' guard on blame providers.
 *
 * When intellig.blameAnnotationStyle is set to 'off', both InlineBlameProvider
 * and GutterBlameProvider must produce zero decorations even when enabled, so
 * the 'off' value acts as a master kill-switch that overrides the toggle state.
 */

import * as assert from 'assert';
import { InlineBlameProvider } from '../../../blame/InlineBlameProvider';
import { GutterBlameProvider } from '../../../blame/GutterBlameProvider';
import { IBlameService, IBlameInfo } from '../../../blame/interfaces/IBlameService';
import { IGitService, IRepository, IBlameLine } from '../../../git-core/interfaces/IGitService';
import { Uri, EventEmitter, setMockConfigValue, resetMockConfiguration } from '../../mocks/vscode';

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

describe("blameAnnotationStyle: 'off' guard", () => {
  let mockBlameService: MockBlameService;
  let mockGitService: MockGitService;
  let mockRepo: IRepository;

  beforeEach(() => {
    resetMockConfiguration();
    mockBlameService = new MockBlameService();
    mockGitService = new MockGitService();
    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
    mockGitService.mockRepository = mockRepo;
  });

  afterEach(() => {
    mockBlameService.dispose();
    mockGitService.dispose();
    resetMockConfiguration();
  });

  describe('InlineBlameProvider', () => {
    it("isAnnotationStyleEnabled returns false when style is 'off'", () => {
      setMockConfigValue('intellig', 'blameAnnotationStyle', 'off');
      const provider = new InlineBlameProvider(
        mockBlameService as unknown as IBlameService,
        mockGitService as unknown as IGitService
      );
      // The provider exposes a testable method for the style guard
      const styleEnabled = (
        provider as unknown as { isAnnotationStyleEnabled(): boolean }
      ).isAnnotationStyleEnabled();
      assert.strictEqual(
        styleEnabled,
        false,
        "isAnnotationStyleEnabled should be false when style='off'"
      );
      provider.dispose();
    });

    it("isAnnotationStyleEnabled returns true when style is 'inline'", () => {
      setMockConfigValue('intellig', 'blameAnnotationStyle', 'inline');
      const provider = new InlineBlameProvider(
        mockBlameService as unknown as IBlameService,
        mockGitService as unknown as IGitService
      );
      const styleEnabled = (
        provider as unknown as { isAnnotationStyleEnabled(): boolean }
      ).isAnnotationStyleEnabled();
      assert.strictEqual(
        styleEnabled,
        true,
        "isAnnotationStyleEnabled should be true when style='inline'"
      );
      provider.dispose();
    });

    it("isAnnotationStyleEnabled returns true when style is 'both'", () => {
      setMockConfigValue('intellig', 'blameAnnotationStyle', 'both');
      const provider = new InlineBlameProvider(
        mockBlameService as unknown as IBlameService,
        mockGitService as unknown as IGitService
      );
      const styleEnabled = (
        provider as unknown as { isAnnotationStyleEnabled(): boolean }
      ).isAnnotationStyleEnabled();
      assert.strictEqual(styleEnabled, true, "isAnnotationStyleEnabled should be true for 'both'");
      provider.dispose();
    });
  });

  describe('GutterBlameProvider', () => {
    it("isAnnotationStyleEnabled returns false when style is 'off'", () => {
      setMockConfigValue('intellig', 'blameAnnotationStyle', 'off');
      const provider = new GutterBlameProvider(
        mockBlameService as unknown as IBlameService,
        mockGitService as unknown as IGitService
      );
      const styleEnabled = (
        provider as unknown as { isAnnotationStyleEnabled(): boolean }
      ).isAnnotationStyleEnabled();
      assert.strictEqual(
        styleEnabled,
        false,
        "isAnnotationStyleEnabled should be false when style='off'"
      );
      provider.dispose();
    });

    it("isAnnotationStyleEnabled returns true when style is 'gutter'", () => {
      setMockConfigValue('intellig', 'blameAnnotationStyle', 'gutter');
      const provider = new GutterBlameProvider(
        mockBlameService as unknown as IBlameService,
        mockGitService as unknown as IGitService
      );
      const styleEnabled = (
        provider as unknown as { isAnnotationStyleEnabled(): boolean }
      ).isAnnotationStyleEnabled();
      assert.strictEqual(
        styleEnabled,
        true,
        "isAnnotationStyleEnabled should be true for 'gutter'"
      );
      provider.dispose();
    });
  });
});

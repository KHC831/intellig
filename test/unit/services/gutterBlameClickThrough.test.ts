/**
 * Gutter blame click-through — the annotation hover's action links must invoke
 * REGISTERED commands so clicking them actually opens the commit / copies the
 * hash. A prior version pointed at `intellig.viewCommit` /
 * `intellig.copyCommitHash` / `intellig.showPreviousRevision`, none of which
 * are registered, so the links were dead. Mirrors IntelliJ's annotation gutter
 * where clicking a revision shows that commit
 * (platform/vcs-impl AnnotateRevisionAction).
 */

import * as assert from 'assert';
import { GutterBlameProvider } from '../../../src/blame/GutterBlameProvider';
import { IBlameService, IBlameInfo } from '../../../src/blame/interfaces/IBlameService';
import { IGitService, IRepository, IBlameLine } from '../../../src/git-core/interfaces/IGitService';
import { EventEmitter } from '../../mocks/vscode';

class MockBlameService implements IBlameService {
  private _onDidChangeBlame = new EventEmitter<{ path: string; blame: IBlameInfo }>();
  readonly onDidChangeBlame = this._onDidChangeBlame.event;
  getBlame(_repo: IRepository, path: string): Promise<IBlameInfo> {
    return Promise.resolve({ path, lines: [] });
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
  private _onDidChangeRepository = new EventEmitter<IRepository>();
  readonly onDidChangeRepository = this._onDidChangeRepository.event;
  getRepository(): Promise<IRepository | undefined> {
    return Promise.resolve(undefined);
  }
  getRepositories(): IRepository[] {
    return [];
  }
  fireRepoChange(repo: IRepository): void {
    this._onDidChangeRepository.fire(repo);
  }
  dispose(): void {
    this._onDidChangeRepository.dispose();
  }
}

describe('GutterBlameProvider hover — click-through wiring', () => {
  const blameLine: IBlameLine = {
    line: 1,
    commit: 'abc123def456789012345678901234567890abcd',
    author: 'Test Author',
    authorEmail: 'test@example.com',
    date: new Date('2024-01-15T12:00:00Z'),
    message: 'fix: close #42',
    previousCommit: 'def4560000000000000000000000000000000000',
  };

  function hoverValue(): string {
    const provider = new GutterBlameProvider(
      new MockBlameService() as unknown as IBlameService,
      new MockGitService() as unknown as IGitService
    );
    const md = (
      provider as unknown as {
        createHoverMessage: (bl: IBlameLine) => { value: string };
      }
    ).createHoverMessage(blameLine);
    provider.dispose();
    return md.value;
  }

  it('routes View Commit to the registered show-commit command', () => {
    assert.ok(hoverValue().includes('command:intellig.editor.showCommit?'));
  });

  it('routes Copy Hash to the registered copy-hash command', () => {
    assert.ok(hoverValue().includes('command:intellig.editor.copyCommitHash?'));
  });

  it('routes Previous Revision to the registered show-commit command', () => {
    const value = hoverValue();
    assert.ok(value.includes('Previous Revision'), 'previous-revision link present');
    assert.ok(
      !value.includes('command:intellig.showPreviousRevision'),
      'must not reference the unregistered intellig.showPreviousRevision command'
    );
  });

  it('does not reference the unregistered intellig.viewCommit command', () => {
    assert.ok(!hoverValue().includes('command:intellig.viewCommit'));
  });
});

describe('GutterBlameProvider — repo-change cache invalidation', () => {
  it('clears the gutter blame cache on onDidChangeRepository (HEAD move)', () => {
    const git = new MockGitService();
    const provider = new GutterBlameProvider(
      new MockBlameService() as unknown as IBlameService,
      git as unknown as IGitService
    );
    const cache = (provider as unknown as { _blameCache: Map<string, unknown> })._blameCache;
    cache.set('file:///x.ts', { lines: [] });
    assert.strictEqual(cache.size, 1, 'precondition: cache seeded');

    git.fireRepoChange({
      rootUri: { fsPath: '/repo' },
    } as unknown as IRepository);

    assert.strictEqual(cache.size, 0, 'a repo change must clear the gutter blame cache');
    provider.dispose();
  });
});

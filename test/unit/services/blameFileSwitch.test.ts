/**
 * Regression: switching the active editor must re-render the gutter annotation
 * for the NEWLY focused file, not leave the previous file's blame on screen.
 *
 * The user reported "open a different file, it still shows the same git blame".
 * This drives the real `window.onDidChangeActiveTextEditor` path (via the mock's
 * `fireActiveTextEditor` helper) and asserts the rendered annotation text tracks
 * the active file's blame.
 */

import * as assert from 'assert';
import { GutterBlameProvider } from '../../../src/blame/GutterBlameProvider';
import { InlineBlameProvider } from '../../../src/blame/InlineBlameProvider';
import { IBlameService, IBlameInfo } from '../../../src/blame/interfaces/IBlameService';
import { IGitService, IRepository, IBlameLine } from '../../../src/git-core/interfaces/IGitService';
import {
  Uri,
  Range,
  EventEmitter,
  setMockConfigValue,
  resetMockConfiguration,
  fireActiveTextEditor,
} from '../../mocks/vscode';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Blame service that returns a different blame line per relative path. */
class PathAwareBlameService implements IBlameService {
  public byPath = new Map<string, IBlameLine[]>();
  private _onDidChangeBlame = new EventEmitter<{ path: string; blame: IBlameInfo }>();
  readonly onDidChangeBlame = this._onDidChangeBlame.event;
  getBlame(_repo: IRepository, path: string): Promise<IBlameInfo> {
    return Promise.resolve({ path, lines: this.byPath.get(path) ?? [] });
  }
  getBlameForLine(): Promise<IBlameLine> {
    throw new Error('not used');
  }
  getPreviousRevisionBlame(_repo: IRepository, path: string): Promise<IBlameInfo> {
    return Promise.resolve({ path, lines: [] });
  }
  dispose(): void {
    this._onDidChangeBlame.dispose();
  }
}

class MockGitService {
  public repo: IRepository;
  private _onDidChangeRepository = new EventEmitter<IRepository>();
  readonly onDidChangeRepository = this._onDidChangeRepository.event;
  constructor(repo: IRepository) {
    this.repo = repo;
  }
  getRepository(): Promise<IRepository | undefined> {
    return Promise.resolve(this.repo);
  }
  getRepositories(): IRepository[] {
    return [this.repo];
  }
  dispose(): void {
    this._onDidChangeRepository.dispose();
  }
}

/** Editor whose setDecorations captures the rendered annotation text column. */
function fakeEditor(fsPath: string): {
  editor: unknown;
  texts: () => string[];
} {
  const captured: string[][] = [];
  const editor = {
    document: { uri: Uri.file(fsPath), lineCount: 10 },
    selection: { active: { line: 0 } },
    visibleRanges: [new Range(0, 0, 9, 0)],
    setDecorations: (_type: unknown, decos: Array<{ renderOptions?: unknown }>): void => {
      // Capture the gutter cell text (one content-sized cell per line).
      const texts = decos
        .map((d) => {
          const before = (d.renderOptions as { before?: { contentText?: string } })?.before;
          return before?.contentText;
        })
        .filter((t): t is string => typeof t === 'string' && t.length > 0);
      if (texts.length > 0) {
        captured.push(texts);
      }
    },
  };
  return { editor, texts: () => captured[captured.length - 1] ?? [] };
}

function blameLine(commit: string, author: string): IBlameLine {
  return {
    line: 1,
    commit,
    author,
    authorEmail: `${author.toLowerCase()}@example.com`,
    date: new Date('2024-01-15T12:00:00Z'),
    message: 'a commit',
  };
}

describe('Gutter blame — active-editor switch re-renders for the new file', () => {
  let blame: PathAwareBlameService;
  let git: MockGitService;
  let provider: GutterBlameProvider;

  beforeEach(() => {
    resetMockConfiguration();
    setMockConfigValue('intellig', 'blameAnnotationStyle', 'gutter');
    const repo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    } as unknown as IRepository;
    blame = new PathAwareBlameService();
    blame.byPath.set('a.ts', [blameLine('aaaaaaa1234567890123456789012345678abcd', 'Alice')]);
    blame.byPath.set('b.ts', [blameLine('bbbbbbb1234567890123456789012345678abcd', 'Bob')]);
    git = new MockGitService(repo);
    provider = new GutterBlameProvider(
      blame as unknown as IBlameService,
      git as unknown as IGitService
    );
  });

  afterEach(() => {
    provider.dispose();
    blame.dispose();
    git.dispose();
    // Clear the shared mock active editor so it does not leak into later tests.
    fireActiveTextEditor(undefined);
    resetMockConfiguration();
  });

  it('shows the new file’s author after the active editor changes', async () => {
    const a = fakeEditor('/test/repo/a.ts');
    const b = fakeEditor('/test/repo/b.ts');

    // Enable on file A.
    provider.enable(a.editor as never, { force: true });
    await flush();
    await flush();
    assert.ok(
      a.texts().some((t) => t.includes('Alice')),
      `file A must annotate Alice; got: ${JSON.stringify(a.texts())}`
    );

    // Switch the active editor to file B.
    fireActiveTextEditor(b.editor);
    await flush();
    await flush();

    const bTexts = b.texts();
    assert.ok(
      bTexts.some((t) => t.includes('Bob')),
      `file B must annotate Bob after the switch; got: ${JSON.stringify(bTexts)}`
    );
    assert.ok(
      !bTexts.some((t) => t.includes('Alice')),
      `file B must NOT carry file A's blame; got: ${JSON.stringify(bTexts)}`
    );
  });
});

/** Inline-decoration editor: captures the `after.contentText` annotation. */
function fakeInlineEditor(fsPath: string): {
  editor: unknown;
  texts: () => string[];
} {
  const captured: string[][] = [];
  const editor = {
    document: {
      uri: Uri.file(fsPath),
      lineCount: 10,
      lineAt: (_line: number): { text: string } => ({ text: 'const x = 1;' }),
    },
    selection: { active: { line: 0 } },
    visibleRanges: [new Range(0, 0, 9, 0)],
    setDecorations: (_type: unknown, decos: Array<{ renderOptions?: unknown }>): void => {
      const texts = decos
        .map((d) => {
          const after = (d.renderOptions as { after?: { contentText?: string } })?.after;
          return after?.contentText;
        })
        .filter((t): t is string => typeof t === 'string' && t.length > 0);
      captured.push(texts);
    },
  };
  return { editor, texts: () => captured[captured.length - 1] ?? [] };
}

describe('Inline blame — active-editor switch re-renders for the new file', () => {
  let blame: PathAwareBlameService;
  let git: MockGitService;
  let provider: InlineBlameProvider;

  beforeEach(() => {
    resetMockConfiguration();
    setMockConfigValue('intellig', 'blameAnnotationStyle', 'inline');
    const repo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    } as unknown as IRepository;
    blame = new PathAwareBlameService();
    blame.byPath.set('a.ts', [blameLine('aaaaaaa1234567890123456789012345678abcd', 'Alice')]);
    blame.byPath.set('b.ts', [blameLine('bbbbbbb1234567890123456789012345678abcd', 'Bob')]);
    git = new MockGitService(repo);
    provider = new InlineBlameProvider(
      blame as unknown as IBlameService,
      git as unknown as IGitService
    );
  });

  afterEach(() => {
    provider.dispose();
    blame.dispose();
    git.dispose();
    // Clear the shared mock active editor so it does not leak into later tests.
    fireActiveTextEditor(undefined);
    resetMockConfiguration();
  });

  it('annotates the new file’s line after the active editor changes', async () => {
    const a = fakeInlineEditor('/test/repo/a.ts');
    const b = fakeInlineEditor('/test/repo/b.ts');

    // The inline provider reads the active editor from `window.activeTextEditor`
    // on enable; point it at A first.
    fireActiveTextEditor(a.editor);
    provider.enable();
    await flush();
    await flush();
    assert.ok(
      a.texts().some((t) => t.includes('Alice')),
      `file A must annotate Alice; got: ${JSON.stringify(a.texts())}`
    );

    fireActiveTextEditor(b.editor);
    await flush();
    await flush();

    const bTexts = b.texts();
    assert.ok(
      bTexts.some((t) => t.includes('Bob')),
      `file B must annotate Bob after the switch; got: ${JSON.stringify(bTexts)}`
    );
    assert.ok(
      !bTexts.some((t) => t.includes('Alice')),
      `file B must NOT carry file A's blame; got: ${JSON.stringify(bTexts)}`
    );
  });
});

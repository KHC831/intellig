/**
 * Hide Revision render elision.
 *
 * Pins the user-visible effect of `blame.hideRevision`:
 * - Gutter: a hidden line keeps its cell (width-holding blank) but renders no
 *   text and no tint, while other lines stay annotated.
 * - Inline: the current-line decoration is suppressed entirely for a hidden
 *   commit, and reappears once the revision is un-hidden.
 */

import * as assert from 'assert';
import { GutterBlameProvider } from '../../../src/blame/GutterBlameProvider';
import { InlineBlameProvider } from '../../../src/blame/InlineBlameProvider';
import { BlameOptionsSource } from '../../../src/blame/BlameOptionsSource';
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

const HIDDEN = 'aaaaaaa1111111111111111111111111111aaaa';
const VISIBLE = 'bbbbbbb2222222222222222222222222222bbbb';

class StaticBlameService implements IBlameService {
  public lines: IBlameLine[] = [];
  private _onDidChangeBlame = new EventEmitter<{ path: string; blame: IBlameInfo }>();
  readonly onDidChangeBlame = this._onDidChangeBlame.event;
  getBlame(_repo: IRepository, path: string): Promise<IBlameInfo> {
    return Promise.resolve({ path, lines: this.lines });
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

function bl(line: number, commit: string): IBlameLine {
  return {
    line,
    commit,
    author: 'Dev',
    authorEmail: 'dev@example.com',
    date: new Date('2024-01-15T12:00:00Z'),
    message: 'a commit',
  };
}

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

describe('Hide Revision render elision', () => {
  let blame: StaticBlameService;
  let git: MockGitService;
  let source: BlameOptionsSource;

  beforeEach(() => {
    resetMockConfiguration();
    blame = new StaticBlameService();
    git = new MockGitService(makeRepo());
    source = new BlameOptionsSource();
  });

  afterEach(() => {
    source.dispose();
    blame.dispose();
    git.dispose();
    fireActiveTextEditor(undefined);
    resetMockConfiguration();
  });

  it('gutter: hidden line renders a width-holding blank cell, others stay annotated', async () => {
    setMockConfigValue('intellig', 'blameAnnotationStyle', 'gutter');
    blame.lines = [bl(1, HIDDEN), bl(2, VISIBLE), bl(3, VISIBLE)];
    await source.hideRevision(HIDDEN);

    const provider = new GutterBlameProvider(
      blame as unknown as IBlameService,
      git as unknown as IGitService,
      source
    );

    // Capture the rendered gutter cell text + tint per line.
    const text = new Map<number, string>();
    const bg = new Map<number, string>();
    const editor = {
      document: { uri: Uri.file('/test/repo/f.ts'), lineCount: 3 },
      selection: { active: { line: 0 } },
      visibleRanges: [new Range(0, 0, 2, 0)],
      setDecorations: (
        _t: unknown,
        decos: Array<{
          range: { start: { line: number } };
          renderOptions?: { before?: { contentText?: string; backgroundColor?: string } };
        }>
      ): void => {
        for (const d of decos) {
          const before = d.renderOptions?.before;
          if (!before) {
            continue;
          }
          if (before.contentText !== undefined) {
            text.set(d.range.start.line, before.contentText);
          }
          if (before.backgroundColor !== undefined) {
            bg.set(d.range.start.line, before.backgroundColor);
          }
        }
      },
    };

    provider.enable(editor as never, { force: true });
    await flush();
    await flush();

    // Hidden line 0: cell exists (width held for column alignment) but carries
    // no visible text and no tint.
    const hiddenCell = text.get(0);
    assert.ok(hiddenCell !== undefined, 'hidden line must still have a gutter cell');
    assert.strictEqual(
      hiddenCell.replace(/[\s\u00a0]/g, ''),
      '',
      `hidden line cell must be blank; got "${hiddenCell}"`
    );
    assert.strictEqual(bg.get(0), 'transparent', 'hidden line must not be tinted');

    // Visible lines keep their annotation text and tint.
    for (const line of [1, 2]) {
      assert.ok(
        (text.get(line) ?? '').includes('Dev'),
        `line ${line} must stay annotated; got "${text.get(line)}"`
      );
      assert.notStrictEqual(bg.get(line), 'transparent', `line ${line} must stay tinted`);
    }

    // Width held: the blank cell is padded to the same width as annotated cells.
    assert.strictEqual(
      hiddenCell.length,
      (text.get(1) ?? '').length,
      'blank cell must hold the same column width as annotated cells'
    );

    provider.dispose();
  });

  it('inline: decoration is suppressed for a hidden commit and returns on un-hide', async () => {
    setMockConfigValue('intellig', 'blameAnnotationStyle', 'inline');
    blame.lines = [bl(1, HIDDEN)];
    await source.hideRevision(HIDDEN);

    const provider = new InlineBlameProvider(
      blame as unknown as IBlameService,
      git as unknown as IGitService,
      source
    );

    const applied: unknown[][] = [];
    const editor = {
      document: {
        uri: Uri.file('/test/repo/f.ts'),
        lineCount: 1,
        isDirty: false,
        lineAt: (): { text: string } => ({ text: 'const x = 1;' }),
      },
      selection: { active: { line: 0 } },
      visibleRanges: [new Range(0, 0, 0, 0)],
      setDecorations: (_t: unknown, decos: unknown[]): void => {
        applied.push(decos);
      },
    };

    fireActiveTextEditor(editor);
    provider.enable();
    await flush();
    await flush();

    assert.ok(
      applied.every((decos) => decos.length === 0),
      'no inline decoration may be applied while the commit is hidden'
    );

    // Un-hide: the option-source change re-renders and the decoration returns.
    await source.showRevision(HIDDEN);
    await flush();
    await flush();

    assert.ok(
      applied.some((decos) => decos.length > 0),
      'inline decoration must return once the revision is un-hidden'
    );

    provider.dispose();
  });
});

/**
 * Gutter render on edited/dirty files:
 *  - Flicker: a successful update must NOT clear decorations first and repaint
 *    (an empty frame collapses the gutter, jerking the code left then right).
 *    setDecorations is called once per type with the final array.
 *  - Alignment: uncommitted lines (git's all-zeros boundary commit) inside the
 *    document get a BLANK gutter cell of the same width as committed lines, so
 *    their code stays aligned instead of sliding under the annotation column.
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

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class Blame implements IBlameService {
  lines: IBlameLine[] = [];
  private e = new EventEmitter<{ path: string; blame: IBlameInfo }>();
  readonly onDidChangeBlame = this.e.event;
  getBlame(): Promise<IBlameInfo> {
    return Promise.resolve({ path: 'f.ts', lines: this.lines });
  }
  getBlameForLine(): Promise<IBlameLine> {
    throw new Error('unused');
  }
  getPreviousRevisionBlame(_r: IRepository, p: string): Promise<IBlameInfo> {
    return Promise.resolve({ path: p, lines: [] });
  }
  dispose(): void {
    this.e.dispose();
  }
}
class Git {
  private e = new EventEmitter<IRepository>();
  readonly onDidChangeRepository = this.e.event;
  constructor(private repo: IRepository) {}
  getRepository(): Promise<IRepository | undefined> {
    return Promise.resolve(this.repo);
  }
  getRepositories(): IRepository[] {
    return [this.repo];
  }
  dispose(): void {
    this.e.dispose();
  }
}
function bl(line: number, commit: string, day: string): IBlameLine {
  return { line, commit, author: 'Dev', authorEmail: 'd@x', date: new Date(day), message: 'm' };
}

interface Deco {
  range: { start: { line: number } };
  renderOptions?: { before?: { contentText?: string; backgroundColor?: string; width?: string } };
}

function makeProvider(lines: IBlameLine[], lineCount: number) {
  const repo = {
    rootUri: Uri.file('/r'),
    state: 'idle',
    head: { name: 'main', commit: 'a', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
  const blame = new Blame();
  blame.lines = lines;
  const provider = new GutterBlameProvider(
    blame as unknown as IBlameService,
    new Git(repo) as unknown as IGitService
  );
  // Record every setDecorations call (type + the decorations array).
  const calls: { decos: Deco[] }[] = [];
  const editor = {
    document: { uri: Uri.file('/r/f.ts'), lineCount, isDirty: false },
    selection: { active: { line: 0 } },
    visibleRanges: [new Range(0, 0, lineCount - 1, 0)],
    setDecorations: (_t: unknown, decos: Deco[]): void => {
      calls.push({ decos });
    },
  };
  return { provider, editor, calls };
}

describe('Gutter blame — dirty/edited render', () => {
  const A = 'aaaaaaa1111111111111111111111111111aaaa';
  const ZERO = '0000000000000000000000000000000000000000';

  beforeEach(() => {
    resetMockConfiguration();
    setMockConfigValue('intellig', 'blameAnnotationStyle', 'gutter');
  });
  afterEach(() => resetMockConfiguration());

  it('does not clear-then-repaint on a successful update (no flicker)', async () => {
    const { provider, editor, calls } = makeProvider(
      [bl(1, A, '2026-01-01'), bl(2, A, '2026-01-01')],
      2
    );
    provider.enable(editor as never, { force: true });
    await flush();
    await flush();

    // Every setDecorations call on the success path must carry the real
    // decorations — an empty array would be a flicker-inducing pre-clear.
    assert.ok(calls.length > 0, 'expected decorations to be applied');
    for (const c of calls) {
      assert.ok(
        c.decos.length > 0,
        `successful render must not setDecorations([]) (pre-clear flicker); calls=${calls.length}`
      );
    }
    provider.dispose();
  });

  it('renders an aligned blank cell for an uncommitted line instead of skipping it', async () => {
    // Lines 1,3 committed; line 2 uncommitted (a freshly inserted line).
    const { provider, editor, calls } = makeProvider(
      [bl(1, A, '2026-01-01'), bl(2, ZERO, '2026-06-01'), bl(3, A, '2026-01-01')],
      3
    );
    provider.enable(editor as never, { force: true });
    await flush();
    await flush();

    // Collect the TEXT-column cell (width in `ch`) per line across all calls.
    const text = new Map<number, string>();
    const width = new Map<number, string>();
    for (const c of calls) {
      for (const d of c.decos) {
        const before = d.renderOptions?.before;
        if (!before || !(before.width ?? '').endsWith('ch')) {
          continue;
        }
        if (before.contentText !== undefined) {
          text.set(d.range.start.line, before.contentText);
        }
        if (before.width !== undefined) {
          width.set(d.range.start.line, before.width);
        }
      }
    }

    // The uncommitted line (editor line 1) must still get a gutter cell…
    assert.ok(text.has(1), 'uncommitted line must still receive a gutter cell (not skipped)');
    // …blank…
    assert.strictEqual(text.get(1), '', 'uncommitted line gutter text must be blank');
    // …and the SAME width as the committed lines, so code stays aligned.
    assert.strictEqual(
      width.get(1),
      width.get(0),
      'blank cell width must match committed-line width for alignment'
    );

    provider.dispose();
  });
});

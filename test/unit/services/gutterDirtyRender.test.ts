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
  renderOptions?: {
    before?: {
      contentText?: string;
      backgroundColor?: string;
      width?: string;
      margin?: string;
      textDecoration?: string;
    };
  };
}

/** Non-breaking space — the gutter pads/aligns with these (plain spaces collapse). */
const NBSP = '\u00a0';

/** The heat bar is the only `before` with a fixed `3px` width; everything else is text. */
function isHeatBar(before: NonNullable<Deco['renderOptions']>['before']): boolean {
  return before?.width === '3px';
}

/** Collect the text-column cell content per document line across all setDecorations calls. */
function collectTextCells(calls: { decos: Deco[] }[]): Map<number, string> {
  const text = new Map<number, string>();
  for (const c of calls) {
    for (const d of c.decos) {
      const before = d.renderOptions?.before;
      if (!before || isHeatBar(before) || before.contentText === undefined) {
        continue;
      }
      text.set(d.range.start.line, before.contentText);
    }
  }
  return text;
}

/** Drop all padding (NBSP + plain space) to reveal the annotation text, if any. */
function stripPad(s: string | undefined): string {
  return (s ?? '').replace(/\s/g, '');
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

    // Collect the TEXT-column cell content per line across all calls. The box is
    // content-sized (no `ch` width), so alignment is encoded in the NBSP-padded
    // contentText LENGTH, not a width property.
    const text = collectTextCells(calls);

    // The uncommitted line (editor line 1) must still get a gutter cell…
    assert.ok(text.has(1), 'uncommitted line must still receive a gutter cell (not skipped)');
    // …blank (only the symmetric pad, no annotation text)…
    assert.strictEqual(
      stripPad(text.get(1)),
      '',
      'uncommitted line gutter text must be blank (pad only)'
    );
    // …and the SAME rendered width as the committed lines, so code stays aligned.
    assert.strictEqual(
      text.get(1)?.length,
      text.get(0)?.length,
      'blank cell width must match committed-line width for alignment'
    );

    provider.dispose();
  });

  it('synchronously gives a newly inserted line a blank cell (no caret jump)', async () => {
    const { provider, editor, calls } = makeProvider(
      [bl(1, A, '2026-01-01'), bl(2, A, '2026-01-01')],
      2
    );
    provider.enable(editor as never, { force: true });
    await flush();
    await flush();
    calls.length = 0; // only look at what the edit produces

    // Simulate pressing Enter at the end of line 0: one newline inserted, the
    // document grows to 3 lines. The shift must run synchronously (no await).
    (editor.document as { lineCount: number }).lineCount = 3;
    const change = {
      range: { start: { line: 0 }, end: { line: 0 } },
      text: '\n',
    } as unknown as import('vscode').TextDocumentContentChangeEvent;
    const ok = (
      provider as unknown as {
        _shiftRenderStateForEdit: (
          e: unknown,
          c: readonly import('vscode').TextDocumentContentChangeEvent[]
        ) => boolean;
      }
    )._shiftRenderStateForEdit(editor, [change]);
    assert.strictEqual(ok, true, 'single-change edit must shift+repaint synchronously');

    // Collect the text-column cell per line from the synchronous repaint.
    const text = collectTextCells(calls);

    // Every line 0..2 must have a cell — crucially the new line (index 1) so the
    // caret doesn't sit at column 0 waiting for the debounced re-blame.
    const seen = [...text.keys()].join(',');
    assert.ok(text.has(0) && text.has(1) && text.has(2), `all 3 lines need a cell; got ${seen}`);
    assert.strictEqual(
      text.get(1)?.length,
      text.get(0)?.length,
      'new line cell keeps the column width'
    );
    provider.dispose();
  });

  it('column width is grow-only (does not shrink when content shrinks) — fixed-sized', async () => {
    const longAuthor: IBlameLine = {
      line: 1,
      commit: A,
      author: 'A Very Long Author Name Indeed',
      authorEmail: 'a@x',
      date: new Date('2026-01-01'),
      message: 'm',
    };
    const { provider, editor, calls } = makeProvider([longAuthor], 1);
    provider.enable(editor as never, { force: true });
    await flush();
    await flush();
    // The rendered width is the content-cell length (NBSP-padded, grow-only).
    const widthOf = (): number | undefined => {
      const cells = collectTextCells(calls);
      const last = [...cells.values()].pop();
      return last?.length;
    };
    const wide = widthOf();
    assert.ok(wide, 'expected a rendered cell width');

    // Shrink the blame to a tiny author and re-render: the column must NOT shrink
    // (grow-only) so it stays put instead of jittering narrower.
    (provider as unknown as { _blameService: { lines: IBlameLine[] } })._blameService.lines = [
      bl(1, A, '2026-01-01'),
    ];
    calls.length = 0;
    await provider.refresh();
    await flush();
    assert.strictEqual(widthOf(), wide, 'width must not shrink when content shrinks');
    provider.dispose();
  });

  it('pads the annotation column symmetrically by 2 spaces with no dead-space gap', async () => {
    const { provider, editor, calls } = makeProvider([bl(1, A, '2026-01-01')], 1);
    provider.enable(editor as never, { force: true });
    await flush();
    await flush();

    // Pull the text-column cell and the heat bar (3px width).
    let textBefore: NonNullable<Deco['renderOptions']>['before'] | undefined;
    let heatBefore: NonNullable<Deco['renderOptions']>['before'] | undefined;
    for (const c of calls) {
      for (const d of c.decos) {
        const before = d.renderOptions?.before;
        if (!before) {
          continue;
        }
        if (isHeatBar(before)) {
          heatBefore = before;
        } else if (before.contentText !== undefined) {
          textBefore = before;
        }
      }
    }
    assert.ok(textBefore, 'expected a text-column cell');
    assert.ok(heatBefore, 'expected a heat-bar cell');

    const content = textBefore.contentText ?? '';
    // No fixed `ch` width box — the cell is sized by its content, so a short line
    // can't leave dead space on the right.
    assert.strictEqual(textBefore.width, undefined, 'text cell must not use a fixed ch-width box');
    // The font (with white-space: pre) is restated per-instance, or the NBSP pad
    // collapses and the left pad vanishes.
    assert.ok(
      (textBefore.textDecoration ?? '').includes('white-space: pre'),
      'text cell must restate white-space: pre so the pad is not collapsed'
    );
    // Left pad: 2 non-breaking spaces lead the (single, widest) line's content.
    assert.ok(
      content.startsWith(NBSP + NBSP),
      `text cell must lead with a 2-NBSP pad; got ${JSON.stringify(content)}`
    );
    // Right pad: this is the widest line, so its content has NO alignment fill —
    // exactly 2 trailing NBSP and a non-pad char before them (symmetric, no dead
    // space).
    assert.ok(
      content.endsWith(NBSP + NBSP),
      `text cell must end with a 2-NBSP pad; got ${JSON.stringify(content)}`
    );
    assert.notStrictEqual(
      content[content.length - 3],
      NBSP,
      'widest line must have exactly 2 trailing pad chars (no right dead space)'
    );
    // Boundary to code: a clean 2ch right margin, flush-left to the tinted block
    // (no px gap between text column and heat bar — the old dead space).
    assert.strictEqual(
      heatBefore.margin,
      '0 2ch 0 0',
      'heat bar must sit flush to the text block with a 2ch gap to code'
    );
    assert.ok(
      !(heatBefore.margin ?? '').includes('px'),
      'heat bar margin must not use asymmetric px spacing'
    );

    provider.dispose();
  });
});

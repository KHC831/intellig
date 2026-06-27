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

/** Collect the text-column cell background per document line across all calls. */
function collectTextBg(calls: { decos: Deco[] }[]): Map<number, string | undefined> {
  const bg = new Map<number, string | undefined>();
  for (const c of calls) {
    for (const d of c.decos) {
      const before = d.renderOptions?.before;
      if (!before || isHeatBar(before) || before.contentText === undefined) {
        continue;
      }
      bg.set(d.range.start.line, before.backgroundColor);
    }
  }
  return bg;
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
    document: { uri: Uri.file('/r/f.ts'), lineCount, isDirty: false, getText: (): string => '' },
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

  it('annotates an uncommitted line as "Uncommitted" (tinted, aligned), not blank', async () => {
    // Lines 1,3 committed; line 2 uncommitted (a freshly inserted line).
    const { provider, editor, calls } = makeProvider(
      [bl(1, A, '2026-01-01'), bl(2, ZERO, '2026-06-01'), bl(3, A, '2026-01-01')],
      3
    );
    provider.enable(editor as never, { force: true });
    await flush();
    await flush();

    const text = collectTextCells(calls);
    const bg = collectTextBg(calls);

    // The uncommitted line (editor line 1) gets a cell labelled "Uncommitted"…
    assert.ok(text.has(1), 'uncommitted line must receive a gutter cell (not skipped)');
    assert.ok(
      stripPad(text.get(1)).includes('Uncommitted'),
      `uncommitted line must read "Uncommitted"; got ${JSON.stringify(text.get(1))}`
    );
    // …with a visible (non-transparent) tint so it shows colour like the rest…
    assert.ok(
      bg.get(1) !== undefined && bg.get(1) !== 'transparent',
      `uncommitted line must be tinted; got ${bg.get(1)}`
    );
    // …and the SAME rendered width as the committed lines, so code stays aligned.
    assert.strictEqual(
      text.get(1)?.length,
      text.get(0)?.length,
      'uncommitted cell width must match committed-line width for alignment'
    );

    provider.dispose();
  });

  it('does NOT fabricate "Uncommitted" for a line the blame did not cover (no stale last-line marker)', async () => {
    // Blame returns 2 committed lines, the buffer has 3 (a phantom trailing line
    // after the final newline, which git never blames). That line must NOT be
    // labelled Uncommitted — otherwise adding then removing a last line strands a
    // stale "Uncommitted" marker that never clears while the buffer is dirty. Only
    // a real git all-zeros line is Uncommitted.
    const { provider, editor, calls } = makeProvider(
      [bl(1, A, '2026-01-01'), bl(2, A, '2026-01-01')],
      3
    );
    (editor.document as { isDirty: boolean }).isDirty = true;
    provider.enable(editor as never, { force: true });
    await flush();
    await flush();

    const text = collectTextCells(calls);
    assert.ok(
      !stripPad(text.get(2) ?? '').includes('Uncommitted'),
      `uncovered trailing line must not be labelled Uncommitted; got ${JSON.stringify(text.get(2))}`
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
    // No font-size override — shrinking the font shrinks the inline box so the
    // tint stops filling the line height, striping a same-commit run into bars.
    assert.ok(
      /display:\s*inline-block/.test(textBefore.textDecoration ?? ''),
      'text cell must be an inline-block so its box (not the font) sets the tint height'
    );
    // …pinned to the row line-height, so the tint fills the whole row and a
    // same-commit run is a solid block even though the text is smaller.
    assert.ok(
      /line-height:\s*\d+px/.test(textBefore.textDecoration ?? ''),
      'text cell must pin line-height to the row height for a continuous block'
    );
    // The text itself is a smaller, font-relative size (it scales with the editor
    // font but cannot break the block, since the inline-block height is fixed).
    assert.ok(
      /font-size:\s*\d+px/.test(textBefore.textDecoration ?? ''),
      'text cell must set a (relative) font-size'
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

  it('renders a FIXED-size column regardless of content (consistent file to file)', async () => {
    // A file whose author names are short and another whose author is very long
    // must produce the SAME rendered text-cell width — the column is a constant
    // size, not grown to fit each file. Overflow is truncated with an ellipsis.
    const shortAuthor = bl(1, A, '2026-01-01'); // author 'Dev'
    const longAuthor: IBlameLine = {
      line: 1,
      commit: A,
      author: 'Maximilian Alexander Featherstonehaugh',
      authorEmail: 'm@x',
      date: new Date('2026-01-01'),
      message: 'm',
    };

    const short = makeProvider([shortAuthor], 1);
    short.provider.enable(short.editor as never, { force: true });
    await flush();
    await flush();

    const long = makeProvider([longAuthor], 1);
    long.provider.enable(long.editor as never, { force: true });
    await flush();
    await flush();

    const shortCell = [...collectTextCells(short.calls).values()].pop();
    const longCell = [...collectTextCells(long.calls).values()].pop();
    assert.ok(shortCell && longCell, 'both files must render a text cell');
    assert.strictEqual(
      longCell.length,
      shortCell.length,
      `column width must be identical across files; short=${shortCell.length} long=${longCell.length}`
    );
    // The long author overflowed the fixed author column, so it was truncated.
    assert.ok(longCell.includes('…'), 'an overflowing author must be truncated with an ellipsis');

    short.provider.dispose();
    long.provider.dispose();
  });
});

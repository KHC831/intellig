/**
 * Gutter render: every line is annotated (text on each line) and the FULL
 * annotation column is tinted with a per-commit color — same commit = same
 * color, distinct commits = distinct colors.
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
  private repo: IRepository;
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
    this.e.dispose();
  }
}
function bl(line: number, commit: string, day: string): IBlameLine {
  return { line, commit, author: 'Dev', authorEmail: 'd@x', date: new Date(day), message: 'm' };
}

describe('Gutter blame — per-line annotation + per-commit colors', () => {
  it('annotates every line and tints the full column per commit', async () => {
    resetMockConfiguration();
    setMockConfigValue('intellig', 'blameAnnotationStyle', 'gutter');
    const repo = {
      rootUri: Uri.file('/r'),
      state: 'idle',
      head: { name: 'main', commit: 'a', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    } as unknown as IRepository;
    const blame = new Blame();
    // Lines 1-3 = commit A, lines 4-5 = commit B (5 editor lines 0..4).
    const A = 'aaaaaaa1111111111111111111111111111aaaa';
    const B = 'bbbbbbb2222222222222222222222222222bbbb';
    blame.lines = [
      bl(1, A, '2026-01-01'),
      bl(2, A, '2026-01-01'),
      bl(3, A, '2026-01-01'),
      bl(4, B, '2026-06-01'),
      bl(5, B, '2026-06-01'),
    ];
    const provider = new GutterBlameProvider(
      blame as unknown as IBlameService,
      new Git(repo) as unknown as IGitService
    );

    // Capture the TEXT column (width in `ch`) — content + background per line.
    const text = new Map<number, string>();
    const textBg = new Map<number, string>();
    const editor = {
      document: { uri: Uri.file('/r/f.ts'), lineCount: 5 },
      selection: { active: { line: 0 } },
      visibleRanges: [new Range(0, 0, 4, 0)],
      setDecorations: (
        _t: unknown,
        decos: Array<{
          range: { start: { line: number } };
          renderOptions?: {
            before?: { contentText?: string; backgroundColor?: string; width?: string };
          };
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
            textBg.set(d.range.start.line, before.backgroundColor);
          }
        }
      },
    };

    provider.enable(editor as never, { force: true });
    await flush();
    await flush();

    // Annotation text on EVERY line (no block blanking).
    for (let line = 0; line <= 4; line++) {
      assert.ok(
        (text.get(line) ?? '').length > 0,
        `line ${line} must be annotated; got "${text.get(line)}"`
      );
    }

    // Full column tinted on every line; same commit = same color, different = different.
    for (let line = 0; line <= 4; line++) {
      assert.ok(textBg.get(line), `line ${line} must be tinted; got ${textBg.get(line)}`);
    }
    assert.strictEqual(textBg.get(0), textBg.get(2), 'all of commit A shares one color');
    assert.strictEqual(textBg.get(3), textBg.get(4), 'all of commit B shares one color');
    assert.notStrictEqual(textBg.get(0), textBg.get(3), 'commit A and B must have DISTINCT colors');

    provider.dispose();
    resetMockConfiguration();
  });
});

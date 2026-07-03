/**
 * Gutter blame on `intellig-git:` revision documents.
 *
 * "Annotate Previous Revision" opens the file AS IT WAS at the parent commit
 * (an `intellig-git:` virtual document) and annotates THAT document —
 * parent-revision blame cannot align with the current working-tree buffer.
 * These tests pin that the provider blames a revision document at its own
 * pinned ref (from the URI query) instead of skipping non-file schemes.
 */

import * as assert from 'assert';
import { GutterBlameProvider } from '../../../src/blame/GutterBlameProvider';
import { parseIntelligGitTarget } from '../../../src/utils/intelligGitUri';
import type { IBlameService, IBlameInfo } from '../../../src/blame/interfaces/IBlameService';
import type {
  IBlameLine,
  IGitService,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';
import { Uri, Range, EventEmitter } from '../../mocks/vscode';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function bl(line: number): IBlameLine {
  return {
    line,
    commit: 'c0ffee1234567890c0ffee1234567890c0ffee12',
    author: 'Dev',
    authorEmail: 'd@x',
    date: new Date('2024-01-01'),
    message: 'm',
  };
}

describe('parseIntelligGitTarget', () => {
  it('reads the structured ref=…&repoRoot=… form', () => {
    const target = parseIntelligGitTarget({
      scheme: 'intellig-git',
      path: 'src/f.ts',
      query: new URLSearchParams({ ref: 'abc123^', repoRoot: '/repo' }).toString(),
    });
    assert.deepStrictEqual(target, { filePath: 'src/f.ts', ref: 'abc123^', repoRoot: '/repo' });
  });

  it('reads the legacy encoded-ref form', () => {
    const target = parseIntelligGitTarget({
      scheme: 'intellig-git',
      path: 'src/f.ts',
      query: encodeURIComponent('origin/main'),
    });
    assert.deepStrictEqual(target, { filePath: 'src/f.ts', ref: 'origin/main' });
  });

  it('rejects other schemes and empty refs', () => {
    assert.strictEqual(
      parseIntelligGitTarget({ scheme: 'file', path: '/x', query: 'HEAD' }),
      undefined
    );
    assert.strictEqual(
      parseIntelligGitTarget({ scheme: 'intellig-git', path: 'x', query: '' }),
      undefined
    );
  });
});

describe('GutterBlameProvider on intellig-git revision documents', () => {
  it('blames the document at its own pinned ref (repo from the encoded root)', async () => {
    const repo = {
      rootUri: Uri.file('/repo'),
      state: 'idle',
      head: { name: 'main', commit: 'a', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    } as unknown as IRepository;

    const blameCalls: Array<{ path: string; revision: string | undefined }> = [];
    const blameEmitter = new EventEmitter<{ path: string; blame: IBlameInfo }>();
    const blameService = {
      onDidChangeBlame: blameEmitter.event,
      getBlame: (_repo: IRepository, path: string, revision?: string): Promise<IBlameInfo> => {
        blameCalls.push({ path, revision });
        return Promise.resolve({ path, lines: [bl(1), bl(2)] });
      },
      getBlameForLine: (): Promise<IBlameLine> => {
        throw new Error('unused');
      },
      dispose: (): void => {},
    } as unknown as IBlameService;

    const repoRequests: string[] = [];
    const gitEmitter = new EventEmitter<IRepository>();
    const gitService = {
      onDidChangeRepository: gitEmitter.event,
      getRepository: (uri: { fsPath: string }): Promise<IRepository | undefined> => {
        repoRequests.push(uri.fsPath);
        return Promise.resolve(uri.fsPath === '/repo' ? repo : undefined);
      },
      getRepositories: (): IRepository[] => [repo],
    } as unknown as IGitService;

    const provider = new GutterBlameProvider(blameService, gitService);

    const decoCalls: unknown[][] = [];
    const editor = {
      document: {
        uri: Uri.from({
          scheme: 'intellig-git',
          path: 'src/f.ts',
          query: new URLSearchParams({ ref: 'abc123^', repoRoot: '/repo' }).toString(),
        }),
        lineCount: 2,
        isDirty: false,
        getText: (): string => '',
      },
      selection: { active: { line: 0 } },
      visibleRanges: [new Range(0, 0, 1, 0)],
      setDecorations: (_t: unknown, decos: unknown[]): void => {
        decoCalls.push(decos);
      },
    };

    provider.enable(editor as never, { force: true });
    await flush();
    await flush();

    assert.strictEqual(blameCalls.length, 1, 'blame must be requested for the revision doc');
    assert.strictEqual(blameCalls[0].path, 'src/f.ts');
    assert.strictEqual(
      blameCalls[0].revision,
      'abc123^',
      'blame must be pinned at the ref the document shows'
    );
    assert.ok(repoRequests.includes('/repo'), 'repo resolved from the encoded repoRoot');
    assert.ok(
      decoCalls.some((d) => d.length > 0),
      'gutter decorations must be applied to the revision document'
    );

    provider.dispose();
  });
});

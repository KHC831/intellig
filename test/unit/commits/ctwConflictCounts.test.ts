/**
 * The per-file conflict-region count: the wrapper that reads working-tree
 * files, as opposed to the marker parser it delegates to.
 *
 * Every behaviour its docstring promises is pinned here. Without this the
 * whole producer could return an empty map and the "N conflicts" badge would
 * quietly stop appearing, with the parser's own tests still green.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { countConflictRegionsPerFile } from '../../../src/commits/ctwConflictCounts';
import type { IFileChange } from '../../../src/changelists/interfaces/IChangelistService';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

const REPO = { rootUri: Uri.file('/repo') } as unknown as IRepository;

const CONFLICTED = (path: string): IFileChange => ({
  path,
  status: 'conflicted',
  staged: false,
});

function twoRegions(): string {
  return (
    'a\n<<<<<<< HEAD\nours1\n=======\ntheirs1\n>>>>>>> other\n' +
    'b\n<<<<<<< HEAD\nours2\n=======\ntheirs2\n>>>>>>> other\nc\n'
  );
}

/**
 * Serve `contents` by repo-relative path; anything else throws, as fs does.
 * A Map for the same reason the production code uses one: `__proto__` is a
 * real filename, and an object literal would swallow it.
 */
function serve(
  contents: ReadonlyMap<string, string>,
  sizes?: ReadonlyMap<string, number>
): () => void {
  const fsApi = vscode.workspace.fs as unknown as {
    readFile: (uri: { fsPath?: string; path?: string }) => Promise<Uint8Array>;
    stat: (uri: { fsPath?: string; path?: string }) => Promise<{ size: number }>;
  };
  const original = fsApi.readFile;
  const originalStat = fsApi.stat;
  const match = (uri: { fsPath?: string; path?: string }): string | undefined => {
    const full = uri.fsPath ?? uri.path ?? '';
    return Array.from(contents.keys()).find((k) => full.endsWith(k));
  };
  fsApi.stat = async (uri): Promise<{ size: number }> => {
    const key = match(uri);
    if (key === undefined) {
      throw new Error(`ENOENT: ${uri.fsPath ?? uri.path ?? ''}`);
    }
    // Default to the real byte length, so only a test that asks for a size
    // gets a fabricated one.
    return { size: sizes?.get(key) ?? Buffer.byteLength(contents.get(key) as string, 'utf8') };
  };
  fsApi.readFile = async (uri): Promise<Uint8Array> => {
    const key = match(uri);
    if (key === undefined) {
      throw new Error(`ENOENT: ${uri.fsPath ?? uri.path ?? ''}`);
    }
    return new Uint8Array(Buffer.from(contents.get(key) as string, 'utf8'));
  };
  return () => {
    fsApi.readFile = original;
    fsApi.stat = originalStat;
  };
}

describe('countConflictRegionsPerFile', () => {
  let restore: () => void = () => {};

  afterEach(() => {
    restore();
    restore = () => {};
  });

  it('counts the regions of each conflicted file', async () => {
    restore = serve(new Map([['a.ts', twoRegions()]]));

    const counts = await countConflictRegionsPerFile(REPO, [CONFLICTED('a.ts')]);

    assert.strictEqual(counts.get('a.ts'), 2, 'both regions counted');
  });

  it('reads only the conflicted files', async () => {
    // The docstring's reason for existing: a merge can touch hundreds of
    // files and only the unmerged handful is worth opening.
    const read: string[] = [];
    const fsApi = vscode.workspace.fs as unknown as {
      readFile: (uri: { fsPath?: string; path?: string }) => Promise<Uint8Array>;
    };
    const original = fsApi.readFile;
    restore = () => {
      fsApi.readFile = original;
    };
    fsApi.readFile = async (uri): Promise<Uint8Array> => {
      read.push(uri.fsPath ?? uri.path ?? '');
      return new Uint8Array(Buffer.from(twoRegions(), 'utf8'));
    };

    const counts = await countConflictRegionsPerFile(REPO, [
      CONFLICTED('conflicted.ts'),
      { path: 'ordinary.ts', status: 'modified', staged: false },
    ]);

    assert.strictEqual(read.length, 1, 'exactly one file opened');
    assert.match(read[0], /conflicted\.ts$/);
    assert.ok(!counts.has('ordinary.ts'), 'an unmerged-only map');
  });

  it('leaves an unreadable file OUT rather than counting it zero', async () => {
    // A binary conflict, a file deleted on this side, or one racing the index.
    // Absent means the row shows no badge; zero would render "0 conflicts".
    restore = serve(new Map([['readable.ts', twoRegions()]]));

    const counts = await countConflictRegionsPerFile(REPO, [
      CONFLICTED('readable.ts'),
      CONFLICTED('gone.ts'),
    ]);

    assert.strictEqual(counts.get('readable.ts'), 2, 'the readable one still counts');
    assert.strictEqual(counts.has('gone.ts'), false, 'the unreadable one is absent');
    assert.strictEqual(counts.get('gone.ts'), undefined, 'and not a zero');
  });

  it('keys by path safely, including names that collide with Object prototype', async () => {
    // A Map, not an object literal: `__proto__` and `constructor` are real
    // filenames and read as already-present on a literal.
    restore = serve(
      new Map([
        ['__proto__', twoRegions()],
        ['constructor', twoRegions()],
      ])
    );

    const counts = await countConflictRegionsPerFile(REPO, [
      CONFLICTED('__proto__'),
      CONFLICTED('constructor'),
    ]);

    assert.strictEqual(counts.get('__proto__'), 2);
    assert.strictEqual(counts.get('constructor'), 2);
  });
  it('skips a file too large to be worth reading', async () => {
    const body = '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n';
    let readCalls = 0;
    restore = serve(
      new Map([
        ['big.bin', body],
        ['small.ts', body],
      ]),
      new Map([
        ['big.bin', 64 * 1024 * 1024],
        ['small.ts', Buffer.byteLength(body, 'utf8')],
      ])
    );
    const fsApi = vscode.workspace.fs as unknown as {
      readFile: (uri: { fsPath?: string; path?: string }) => Promise<Uint8Array>;
    };
    const passthrough = fsApi.readFile;
    fsApi.readFile = async (uri): Promise<Uint8Array> => {
      readCalls += 1;
      return passthrough(uri);
    };

    const counts = await countConflictRegionsPerFile(REPO, [
      CONFLICTED('big.bin'),
      CONFLICTED('small.ts'),
    ]);

    assert.strictEqual(counts.has('big.bin'), false, 'an oversized file gets no badge');
    assert.strictEqual(counts.get('small.ts'), 1, 'an ordinary file still counts');
    assert.strictEqual(readCalls, 1, 'the oversized file is never read into memory');
  });
});

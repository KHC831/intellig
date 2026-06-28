/**
 * R4-2: _shiftRenderStateForEdit must increment _decorationRequestSeq.
 *
 * updateDecorations captures a request token (mySeq = ++_decorationRequestSeq)
 * before its first await, then bails after the await if a newer call has
 * started. _shiftRenderStateForEdit was the synchronous on-edit repaint path
 * but did NOT bump the seq — so an in-flight updateDecorations that resolved
 * after the shift would overwrite the freshly-shifted gutter with stale
 * pre-edit blame until the debounced re-blame fired.
 *
 * After the fix _shiftRenderStateForEdit increments the seq before
 * _applyRenderState, so any older in-flight updateDecorations bails at its
 * post-await guard.
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

function bl(line: number, commit: string): IBlameLine {
  return {
    line,
    commit,
    author: 'Dev',
    authorEmail: 'd@x',
    date: new Date('2026-01-01'),
    message: 'm',
  };
}

interface ProviderSurface {
  _decorationRequestSeq: number;
  _shiftRenderStateForEdit(
    editor: unknown,
    changes: readonly import('vscode').TextDocumentContentChangeEvent[]
  ): boolean;
}

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const initialLines: IBlameInfo = { path: 'f.ts', lines: [bl(1, A), bl(2, A)] };

function makeSetup() {
  let callCount = 0;

  // Pre-create a deferred promise for the second blame call so it is
  // always resolvable regardless of when the blame service invokes getBlame.
  let resolveSecond!: (v: IBlameInfo) => void;
  const secondBlamePromise = new Promise<IBlameInfo>((res) => {
    resolveSecond = res;
  });

  class ControlledBlame implements IBlameService {
    private e = new EventEmitter<{ path: string; blame: IBlameInfo }>();
    readonly onDidChangeBlame = this.e.event;
    getBlame(): Promise<IBlameInfo> {
      callCount++;
      if (callCount === 1) {
        // First call (from enable): resolves immediately.
        return Promise.resolve(initialLines);
      }
      // Second call (from refresh): blocks until resolveSecond is called.
      return secondBlamePromise;
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

  const repo = {
    rootUri: Uri.file('/r'),
    state: 'idle',
    head: { name: 'main', commit: 'a', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;

  const blame = new ControlledBlame();
  const git: IGitService = {
    onDidChangeRepository: new EventEmitter<IRepository>().event,
    getRepository: () => Promise.resolve(repo),
    getRepositories: () => [repo],
    dispose: () => {},
  } as unknown as IGitService;

  const calls: { decos: unknown[] }[] = [];
  const editor = {
    document: { uri: Uri.file('/r/f.ts'), lineCount: 2, isDirty: false, getText: () => '' },
    selection: { active: { line: 0 } },
    visibleRanges: [new Range(0, 0, 1, 0)],
    setDecorations: (_t: unknown, decos: unknown[]): void => {
      calls.push({ decos });
    },
  };

  const provider = new GutterBlameProvider(blame as unknown as IBlameService, git);

  return {
    provider,
    editor,
    calls,
    surface: provider as unknown as ProviderSurface,
    resolveSecondBlame: () => resolveSecond(initialLines),
  };
}

describe('GutterBlameProvider — _shiftRenderStateForEdit bumps seq (R4-2)', () => {
  beforeEach(() => {
    resetMockConfiguration();
    setMockConfigValue('intellig', 'blameAnnotationStyle', 'gutter');
  });
  afterEach(() => resetMockConfiguration());

  it('_shiftRenderStateForEdit increments _decorationRequestSeq', async () => {
    const { provider, editor, surface } = makeSetup();

    // Let the first enable settle so _renderState is populated.
    provider.enable(editor as never, { force: true });
    await flush();
    await flush();

    const seqBefore = surface._decorationRequestSeq;

    // Simulate inserting a newline after line 0.
    (editor.document as { lineCount: number }).lineCount = 3;
    const change = {
      range: { start: { line: 0 }, end: { line: 0 } },
      text: '\n',
    } as unknown as import('vscode').TextDocumentContentChangeEvent;

    const shifted = surface._shiftRenderStateForEdit(editor, [change]);
    assert.strictEqual(shifted, true, '_shiftRenderStateForEdit must return true for a valid edit');
    assert.ok(
      surface._decorationRequestSeq > seqBefore,
      `seq must increase after shift; before=${seqBefore} after=${surface._decorationRequestSeq}`
    );

    provider.dispose();
  });

  it('in-flight updateDecorations that resolves after shift bails, not overwrites shifted state', async () => {
    const { provider, editor, calls, surface, resolveSecondBlame } = makeSetup();

    // Let the first enable settle so _renderState is populated.
    provider.enable(editor as never, { force: true });
    await flush();
    await flush();

    // Start a second blame fetch (via refresh).
    // updateDecorations runs synchronously until its first await
    // (resolveBlameRepo), capturing mySeq before suspending.
    const refreshP = provider.refresh();
    // Capture the seq that updateDecorations locked in.
    const seqAfterRefresh = surface._decorationRequestSeq;

    calls.length = 0; // clear earlier calls

    // Synchronously shift: inserts a line BEFORE any microtask drains.
    // With the fix, this increments seq beyond mySeq so the in-flight
    // updateDecorations will bail when it eventually resumes.
    (editor.document as { lineCount: number }).lineCount = 3;
    const change = {
      range: { start: { line: 1 }, end: { line: 1 } },
      text: '\n',
    } as unknown as import('vscode').TextDocumentContentChangeEvent;
    surface._shiftRenderStateForEdit(editor, [change]);

    assert.ok(
      surface._decorationRequestSeq > seqAfterRefresh,
      'shift must advance seq past the refresh token'
    );

    // Mark how many setDecorations calls the shift produced.
    const shiftCallCount = calls.length;
    assert.ok(shiftCallCount > 0, 'shift must call setDecorations synchronously');

    // Resolve the second blame so updateDecorations can resume and reach
    // the seq guard.
    resolveSecondBlame();
    await refreshP;
    await flush();
    await flush();

    // The stale updateDecorations must have bailed at the seq check and NOT
    // called setDecorations again (which would overwrite the shifted state).
    assert.strictEqual(
      calls.length,
      shiftCallCount,
      'stale in-flight updateDecorations must NOT call setDecorations after shift'
    );

    provider.dispose();
  });
});

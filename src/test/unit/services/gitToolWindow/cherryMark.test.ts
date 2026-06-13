/**
 * Unit tests for — Highlight already-cherry-picked commits.
 *
 * Two test surfaces:
 *
 *  1. `GitService.getCherryMarks` — line-parsing of
 *     `git log --cherry-mark --left-right --pretty=format:%H %m` output.
 *     We swap in a fake GitCli so the tests don't actually spawn git, and
 *     assert the returned Map matches the expected shape for representative
 *     fixtures.
 *
 *  2. `GitToolWindowProvider.setCherryPickedHashes` — state accessor
 *     contract (set / clear / get via `getExtendedLogState`).
 */

/*
 * Stub factories synthesise gitCli / IGitService implementations whose
 * member signatures return `Promise<T>`; no-await stub bodies are
 * intentional here.
 */

import '../../../setup';
import * as assert from 'assert';
import type { CherryMark, ICommit, IRepository } from '../../../../git-core/interfaces/IGitService';
import { GitService } from '../../../../git-core/GitService';
import { Uri } from '../../../mocks/vscode';

// ─── GitService.getCherryMarks ───────────────────────────────────────────────

describe('GitService.getCherryMarks', () => {
  function mkRepo(): IRepository {
    return {
      rootUri: Uri.file('/repo'),
      state: 'idle',
      head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    };
  }

  interface GitCliLike {
    exec: (
      args: string[],
      options?: unknown
    ) => Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }>;
  }

  /**
   * Build a GitService with an injected fake GitCli. The GitService
   * constructor stores the cli on a private field; we reach in directly
   * because the class was designed for this kind of test injection.
   */
  function mkGitServiceWith(cli: GitCliLike): GitService {
    const svc = new GitService();
    (svc as unknown as { _gitCli: GitCliLike })._gitCli = cli;
    return svc;
  }

  it('parses --cherry-mark output into a Map<hash, mark>', async () => {
    const cli: GitCliLike = {
      exec: async (args) => {
        // Verify we built the expected argv.
        // Refs follow `--end-of-options`.
        assert.deepStrictEqual(args, [
          'log',
          '--cherry-mark',
          '--left-right',
          '--pretty=format:%H %m',
          '--end-of-options',
          'HEAD...origin/main',
        ]);
        return {
          exitCode: 0,
          stderr: '',
          combined: '',
          stdout: [
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa =',
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb <',
            'cccccccccccccccccccccccccccccccccccccccc >',
            'dddddddddddddddddddddddddddddddddddddddd +',
            'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee -',
          ].join('\n'),
        };
      },
    };
    const svc = mkGitServiceWith(cli);
    const marks = await svc.getCherryMarks(mkRepo(), 'origin/main');

    const expected: Array<[string, CherryMark]> = [
      ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '='],
      ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '<'],
      ['cccccccccccccccccccccccccccccccccccccccc', '>'],
      ['dddddddddddddddddddddddddddddddddddddddd', '+'],
      ['eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '-'],
    ];
    for (const [hash, mark] of expected) {
      assert.strictEqual(marks.get(hash), mark, `hash ${hash} should have mark ${mark}`);
    }
    assert.strictEqual(marks.size, 5);
  });

  it('returns an empty map when git exits with a non-zero code', async () => {
    const cli: GitCliLike = {
      exec: async () => ({ exitCode: 128, stderr: 'fatal', stdout: '', combined: '' }),
    };
    const svc = mkGitServiceWith(cli);
    const marks = await svc.getCherryMarks(mkRepo(), 'origin/main');
    assert.strictEqual(marks.size, 0);
  });

  it('returns an empty map when the cli throws', async () => {
    const cli: GitCliLike = {
      exec: async () => {
        throw new Error('boom');
      },
    };
    const svc = mkGitServiceWith(cli);
    const marks = await svc.getCherryMarks(mkRepo(), 'origin/main');
    assert.strictEqual(marks.size, 0);
  });

  it('returns an empty map when baseRef is empty', async () => {
    // baseRef='' should short-circuit before any cli call; the fake below
    // would throw if it were invoked.
    const cli: GitCliLike = {
      exec: async () => {
        throw new Error('should not be called');
      },
    };
    const svc = mkGitServiceWith(cli);
    const marks = await svc.getCherryMarks(mkRepo(), '');
    assert.strictEqual(marks.size, 0);
  });

  it('skips malformed lines (wrong hash length, missing mark) without throwing', async () => {
    const cli: GitCliLike = {
      exec: async () => ({
        exitCode: 0,
        stderr: '',
        combined: '',
        stdout: [
          'badhash =', // too short
          '', // empty line (will be filtered)
          'abcdefabcdefabcdefabcdefabcdefabcdefabcd ?', // unknown mark
          'abcdefabcdefabcdefabcdefabcdefabcdefabcd', // missing mark entirely
          // one valid row
          'abcdefabcdefabcdefabcdefabcdefabcdefabcd =',
          // trailing CRLF on the valid row shouldn't break parsing
          '1234567890123456789012345678901234567890 =\r',
        ].join('\n'),
      }),
    };
    const svc = mkGitServiceWith(cli);
    const marks = await svc.getCherryMarks(mkRepo(), 'origin/main');
    assert.strictEqual(marks.get('abcdefabcdefabcdefabcdefabcdefabcdefabcd'), '=');
    assert.strictEqual(marks.get('1234567890123456789012345678901234567890'), '=');
    assert.strictEqual(marks.size, 2);
  });

  it('handles trailing whitespace / CRLF line endings cleanly', async () => {
    const cli: GitCliLike = {
      exec: async () => ({
        exitCode: 0,
        stderr: '',
        combined: '',
        stdout:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa =\r\n' +
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb =\r\n',
      }),
    };
    const svc = mkGitServiceWith(cli);
    const marks = await svc.getCherryMarks(mkRepo(), 'origin/main');
    assert.strictEqual(marks.size, 2);
  });
});

// ─── GitToolWindowProvider state accessor ────────────────────────────────────

describe('GitToolWindowProvider.setCherryPickedHashes', () => {
  // Construction of the real provider needs an `extensionUri` + optional
  // workspaceState. Our mock `Uri.file` returns a usable object. No
  // `resolveWebviewView` is called — setCherryPickedHashes is pure state.
  it('stores the hashes + baseRef and surfaces them via getExtendedLogState', async () => {
    const { GitToolWindowProvider } =
      await import('../../../../git-core/gitToolWindow/GitToolWindowProvider');
    const provider = new GitToolWindowProvider(Uri.file('/ext'));
    const set = new Set(['aaa', 'bbb', 'ccc']);
    provider.setCherryPickedHashes(set, 'origin/main');
    const state = provider.getExtendedLogState();
    assert.strictEqual(state.cherryPickedHashes?.size, 3);
    assert.ok(state.cherryPickedHashes?.has('aaa'));
    assert.strictEqual(state.cherryPickBaseRef, 'origin/main');
    provider.dispose?.();
  });

  it('clears the state when called with an empty Set', async () => {
    const { GitToolWindowProvider } =
      await import('../../../../git-core/gitToolWindow/GitToolWindowProvider');
    const provider = new GitToolWindowProvider(Uri.file('/ext'));
    provider.setCherryPickedHashes(new Set(['aaa']), 'origin/main');
    provider.setCherryPickedHashes(new Set(), undefined);
    const state = provider.getExtendedLogState();
    assert.strictEqual(state.cherryPickedHashes, undefined);
    provider.dispose?.();
  });

  it('clears the state when called with undefined', async () => {
    const { GitToolWindowProvider } =
      await import('../../../../git-core/gitToolWindow/GitToolWindowProvider');
    const provider = new GitToolWindowProvider(Uri.file('/ext'));
    provider.setCherryPickedHashes(new Set(['aaa']), 'origin/main');
    provider.setCherryPickedHashes(undefined);
    const state = provider.getExtendedLogState();
    assert.strictEqual(state.cherryPickedHashes, undefined);
    provider.dispose?.();
  });

  // A smoke-test helper type so the ICommit reference above doesn't get
  // tree-shaken and the CherryMark import gets exercised (keeps the linter
  // happy about unused imports when the TS config is strict).
  it('type test — CherryMark and ICommit exports are wired', () => {
    const mark: CherryMark = '=';
    assert.strictEqual(mark, '=');
    const _commit: Partial<ICommit> = { hash: 'a', shortHash: 'a' };
    assert.strictEqual(_commit.hash, 'a');
  });
});

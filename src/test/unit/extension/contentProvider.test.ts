/**
 * Regression tests for the `intellig-git:` URI content provider (task #92, A1).
 *
 * Senior retro of Change A flagged a pre-existing bug newly reachable through
 * BranchComparisonView: producers across the codebase encode the ref with
 * `encodeURIComponent(ref)`, but the provider used to read `uri.query` raw.
 * A ref containing `/` (e.g. `origin/main`) round-tripped as `origin%2Fmain`,
 * which `git show` cannot resolve.
 *
 * These tests exercise the exported helper `provideGitShowContent` directly
 * — the production provider body is a thin closure that calls into it —
 * and assert that the `git show` invocation's revision arg is `origin/main`
 * (decoded), not `origin%2Fmain` (raw).
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */

import * as assert from 'assert';
import { provideGitShowContent } from '../../../extension';
import { GitService } from '../../../git-core/GitService';
import { IRepository } from '../../../git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

/**
 * Mock GitCli that captures every `exec` call so tests can inspect the exact
 * argv sent to `git` — in particular, whether the revision:path arg is
 * URL-decoded as the provider contract requires.
 */
class CapturingGitCli {
  public executed: { args: string[]; options: unknown }[] = [];
  private _stdout: string;
  private _exitCode: number;

  private _onCommandExecuted = {
    event: (): { dispose: () => void } => ({ dispose: (): void => {} }),
  };

  constructor(opts: { stdout?: string; exitCode?: number } = {}) {
    this._stdout = opts.stdout ?? '';
    this._exitCode = opts.exitCode ?? 0;
  }

  get onCommandExecuted(): () => { dispose: () => void } {
    return this._onCommandExecuted.event;
  }

  async exec(
    args: string[],
    options: { cwd?: string; throwOnError?: boolean } = {}
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    this.executed.push({ args: [...args], options });
    return { exitCode: this._exitCode, stdout: this._stdout, stderr: '', combined: this._stdout };
  }

  async getRepositoryRoot(path: string): Promise<string | undefined> {
    return path;
  }

  dispose(): void {}
}

/**
 * Fabricate a `vscode.Uri`-shaped object with `path` / `query` set exactly
 * as the production `intellig-git:` producer would emit them. The test mock
 * for `Uri.parse` does not actually parse the string, so we build the Uri
 * instance directly via `Uri.file` + `.with({ query })`.
 */
function buildIntelligGitUri(filePath: string, rawQuery: string): any {
  return Uri.file(filePath).with({ query: rawQuery });
}

describe('intellig-git: content provider — URI ref decoding (task #92)', () => {
  let gitService: GitService;
  let mockGitCli: CapturingGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    gitService = new GitService();
    mockGitCli = new CapturingGitCli({ stdout: 'file contents at ref\n' });
    (gitService as any)._gitCli = mockGitCli;

    const rootPath = '/test/repo';
    mockRepo = {
      rootUri: Uri.file(rootPath),
      state: 'idle',
      head: {
        name: 'refs/heads/main',
        commit: 'abc123',
        upstream: { remote: 'origin', name: 'main' },
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };

    // Pre-seed the GitService cache so `resolveRepo` and `getRepository`
    // resolve without touching disk. `getCachedRepository` checks TTL.
    (gitService as any)._repositories.set(rootPath, {
      repository: mockRepo,
      lastUpdated: Date.now(),
    });
  });

  afterEach(() => {
    gitService.dispose();
  });

  it('decodes `origin%2Fmain` in uri.query back to `origin/main` before invoking git show', async () => {
    // This is the regression case. `encodeURIComponent('origin/main')` is
    // `'origin%2Fmain'`, which is what every producer in the codebase puts
    // in the URI query. If the provider reads `uri.query` raw, the git show
    // arg is `origin%2Fmain:src/foo.ts` — a revision git cannot resolve.
    const uri = buildIntelligGitUri('/test/repo/src/foo.ts', encodeURIComponent('origin/main'));

    const content = await provideGitShowContent(uri, gitService, [{ uri: Uri.file('/test/repo') }]);

    assert.strictEqual(content, 'file contents at ref\n');
    assert.strictEqual(mockGitCli.executed.length, 1);
    const lastExec = mockGitCli.executed[0];
    assert.deepStrictEqual(lastExec.args, ['show', 'origin/main:/test/repo/src/foo.ts']);

    // Defensive: the forbidden shape must NOT appear anywhere in the argv.
    for (const arg of lastExec.args) {
      assert.ok(
        !arg.includes('%2F'),
        `git show received URL-encoded ref; expected decoded form. arg: ${arg}`
      );
    }
  });

  it('handles a raw commit-hash ref identically (no % escape in input)', async () => {
    // Commit hashes have no reserved characters, so encoded and decoded
    // forms are identical. This test confirms the decode step is idempotent
    // for that common case — i.e. the fix does not regress the hash path.
    const uri = buildIntelligGitUri('/test/repo/src/foo.ts', encodeURIComponent('abc1234'));

    await provideGitShowContent(uri, gitService, [{ uri: Uri.file('/test/repo') }]);

    assert.strictEqual(mockGitCli.executed.length, 1);
    assert.deepStrictEqual(mockGitCli.executed[0].args, ['show', 'abc1234:/test/repo/src/foo.ts']);
  });

  it('decodes a feature-branch ref with multiple `/` segments', async () => {
    // `feature/user/nested` has two slashes; both must round-trip.
    const uri = buildIntelligGitUri(
      '/test/repo/src/foo.ts',
      encodeURIComponent('feature/user/nested')
    );

    await provideGitShowContent(uri, gitService, [{ uri: Uri.file('/test/repo') }]);

    assert.strictEqual(mockGitCli.executed.length, 1);
    assert.deepStrictEqual(mockGitCli.executed[0].args, [
      'show',
      'feature/user/nested:/test/repo/src/foo.ts',
    ]);
  });

  it('throws when uri.query is empty (no ref supplied)', async () => {
    const uri = buildIntelligGitUri('/test/repo/src/foo.ts', '');

    await assert.rejects(
      () => provideGitShowContent(uri, gitService, [{ uri: Uri.file('/test/repo') }]),
      /No git ref specified/
    );
  });

  it('wraps malformed percent-encoded refs in a friendly error (task #103 A2)', async () => {
    // `%GG` is not a valid percent-escape, so `decodeURIComponent` throws
    // `URIError: URI malformed`. Pre-fix, that raw URIError bubbled up and
    // obscured the contract violation; post-fix, the provider wraps it in
    // a friendly `Error` that names both the scheme and the offending query
    // so logs and error handlers point at the producer bug, not the decode.
    const uri = buildIntelligGitUri('/test/repo/src/foo.ts', '%GG');

    await assert.rejects(
      () => provideGitShowContent(uri, gitService, [{ uri: Uri.file('/test/repo') }]),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'must be a plain Error, not a URIError');
        assert.strictEqual(
          err.constructor.name,
          'Error',
          'must not be the raw URIError from the platform decodeURIComponent'
        );
        assert.match(err.message, /Malformed ref in intellig-git URI/);
        assert.match(err.message, /%GG/);
        // Task #106 P1: original URIError must be preserved as the cause so
        // future debugging has the platform root cause, not just our wrapper.
        assert.ok(err.cause, 'error should carry original cause');
        assert.ok(err.cause instanceof Error, 'cause should be an Error');
        assert.strictEqual(err.cause.name, 'URIError', 'cause should be URIError');
        return true;
      }
    );
  });
});

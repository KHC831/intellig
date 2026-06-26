/**
 * Regression tests for the `intellig-git:` URI content provider.
 *
 * Producers across the codebase encode the ref with `encodeURIComponent(ref)`,
 * so the provider must decode `uri.query` rather than reading it raw. A ref
 * containing `/` (e.g. `origin/main`) otherwise round-trips as `origin%2Fmain`,
 * which `git show` cannot resolve.
 *
 * These tests exercise the exported helper `provideGitShowContent` directly
 * — the production provider body is a thin closure that calls into it —
 * and assert that the `git show` invocation's revision arg is `origin/main`
 * (decoded), not `origin%2Fmain` (raw).
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */

import * as assert from 'assert';
import { provideGitShowContent } from '../../../src/extension';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
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
  private _stderr: string;

  private _onCommandExecuted = {
    event: (): { dispose: () => void } => ({ dispose: (): void => {} }),
  };

  constructor(opts: { stdout?: string; exitCode?: number; stderr?: string } = {}) {
    this._stdout = opts.stdout ?? '';
    this._exitCode = opts.exitCode ?? 0;
    this._stderr = opts.stderr ?? '';
  }

  get onCommandExecuted(): () => { dispose: () => void } {
    return this._onCommandExecuted.event;
  }

  async exec(
    args: string[],
    options: { cwd?: string; throwOnError?: boolean } = {}
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    this.executed.push({ args: [...args], options });
    return {
      exitCode: this._exitCode,
      stdout: this._stdout,
      stderr: this._stderr,
      combined: this._stderr || this._stdout,
    };
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
    assert.deepStrictEqual(lastExec.args, [
      'show',
      '--end-of-options',
      'origin/main:/test/repo/src/foo.ts',
    ]);

    // Defensive: the forbidden shape must NOT appear anywhere in the argv.
    for (const arg of lastExec.args) {
      assert.ok(
        !arg.includes('%2F'),
        `git show received URL-encoded ref; expected decoded form. arg: ${arg}`
      );
    }
  });

  it('returns an empty doc for a path absent at the revision (newly-added file)', async () => {
    (gitService as any)._gitCli = new CapturingGitCli({
      exitCode: 128,
      stderr: "fatal: path 'src/new.ts' does not exist in 'HEAD'",
    });
    const uri = buildIntelligGitUri('/test/repo/src/new.ts', encodeURIComponent('HEAD'));
    const content = await provideGitShowContent(uri, gitService, [{ uri: Uri.file('/test/repo') }]);
    assert.strictEqual(content, '', 'a path absent at the revision renders as an empty addition');
  });

  it('throws on a non-absence git failure instead of masking it as an empty file', async () => {
    (gitService as any)._gitCli = new CapturingGitCli({
      exitCode: 128,
      stderr: 'error: object file abc is empty or corrupt',
    });
    const uri = buildIntelligGitUri('/test/repo/src/foo.ts', encodeURIComponent('HEAD'));
    await assert.rejects(
      () => provideGitShowContent(uri, gitService, [{ uri: Uri.file('/test/repo') }]),
      /git show failed/,
      'a real git error must surface, not render as an empty file'
    );
  });

  it('handles a raw commit-hash ref identically (no % escape in input)', async () => {
    // Commit hashes have no reserved characters, so encoded and decoded
    // forms are identical. This test confirms the decode step is idempotent
    // for that common case — i.e. the fix does not regress the hash path.
    const uri = buildIntelligGitUri('/test/repo/src/foo.ts', encodeURIComponent('abc1234'));

    await provideGitShowContent(uri, gitService, [{ uri: Uri.file('/test/repo') }]);

    assert.strictEqual(mockGitCli.executed.length, 1);
    assert.deepStrictEqual(mockGitCli.executed[0].args, [
      'show',
      '--end-of-options',
      'abc1234:/test/repo/src/foo.ts',
    ]);
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
      '--end-of-options',
      'feature/user/nested:/test/repo/src/foo.ts',
    ]);
  });

  it('treats a legacy URI whose ref is literally `ref` as legacy, not structured', async () => {
    // Regression: the legacy form is `encodeURIComponent(ref)` — a single
    // keyless token. For a branch/tag literally named `ref` that token is
    // `ref`, and `new URLSearchParams('ref').get('ref')` is `''` (not null).
    // A one-key discriminator misread it as the structured form and threw
    // "No git ref specified". The two-key check (ref AND repoRoot) must keep
    // it on the legacy path: `git show ref:<path>`, repo via the legacy chain.
    const uri = buildIntelligGitUri('/test/repo/src/foo.ts', encodeURIComponent('ref'));

    const content = await provideGitShowContent(uri, gitService, [{ uri: Uri.file('/test/repo') }]);

    assert.strictEqual(content, 'file contents at ref\n');
    assert.strictEqual(mockGitCli.executed.length, 1);
    assert.deepStrictEqual(mockGitCli.executed[0].args, [
      'show',
      '--end-of-options',
      'ref:/test/repo/src/foo.ts',
    ]);
  });

  it('throws when uri.query is empty (no ref supplied)', async () => {
    const uri = buildIntelligGitUri('/test/repo/src/foo.ts', '');

    await assert.rejects(
      () => provideGitShowContent(uri, gitService, [{ uri: Uri.file('/test/repo') }]),
      /No git ref specified/
    );
  });

  it('resolves the repo from an encoded repoRoot when filePath is repo-relative', async () => {
    // The explorer diff commands emit `ref=<ref>&repoRoot=<absRoot>` with a
    // REPO-root-relative path. Seed a SECOND repo so the provider's single-repo
    // fallback cannot apply, and point the workspace-folder fallback at that
    // OTHER repo: only honoring the encoded repoRoot resolves the right root.
    // (Ignoring repoRoot would fall through to the workspace folder and run
    // `git show` under `/test/other` — the wrong repo.)
    const otherRoot = '/test/other';
    (gitService as any)._repositories.set(otherRoot, {
      repository: { ...mockRepo, rootUri: Uri.file(otherRoot) },
      lastUpdated: Date.now(),
    });

    const uri = buildIntelligGitUri(
      'src/foo.ts',
      `ref=HEAD&repoRoot=${encodeURIComponent('/test/repo')}`
    );

    const content = await provideGitShowContent(uri, gitService, [{ uri: Uri.file(otherRoot) }]);

    assert.strictEqual(content, 'file contents at ref\n');
    assert.strictEqual(mockGitCli.executed.length, 1);
    assert.deepStrictEqual(mockGitCli.executed[0].args, [
      'show',
      '--end-of-options',
      'HEAD:src/foo.ts',
    ]);
    assert.strictEqual(
      (mockGitCli.executed[0].options as { cwd?: string }).cwd,
      '/test/repo',
      'git show must run under the encoded repoRoot, not the workspace-folder fallback'
    );
  });

  it('decodes a `/`-containing branch ref in the structured query form', async () => {
    const uri = buildIntelligGitUri(
      'src/foo.ts',
      `ref=${encodeURIComponent('origin/main')}&repoRoot=${encodeURIComponent('/test/repo')}`
    );

    await provideGitShowContent(uri, gitService, []);

    assert.deepStrictEqual(mockGitCli.executed[0].args, [
      'show',
      '--end-of-options',
      'origin/main:src/foo.ts',
    ]);
  });

  // [HIGH] argv injection — the `ref` is repo/producer-controlled (a malicious
  // clone can hand-author `refs/tags/--output=…` in packed-refs, reachable via
  // any `intellig-git:?ref=` opener / Compare-with-Branch). Routed bare, a ref
  // starting with `-` lands as the LEADING positional after `show` and git
  // parses it as a flag (`git show --output=<file> …` writes out-of-repo files).
  // The rev:path token MUST ride behind `--end-of-options` so git can never
  // treat it as an option.
  describe('argv-injection: --end-of-options precedes the rev:path token', () => {
    it('splices --end-of-options before the rev:path token for a benign ref', async () => {
      const uri = buildIntelligGitUri('/test/repo/src/foo.ts', encodeURIComponent('origin/main'));

      await provideGitShowContent(uri, gitService, [{ uri: Uri.file('/test/repo') }]);

      const argv = mockGitCli.executed[0].args;
      const eooIdx = argv.indexOf('--end-of-options');
      assert.ok(eooIdx > 0, `expected --end-of-options in argv, got ${JSON.stringify(argv)}`);
      const revIdx = argv.indexOf('origin/main:/test/repo/src/foo.ts', eooIdx);
      assert.ok(
        revIdx > eooIdx,
        `rev:path token must follow --end-of-options; got ${JSON.stringify(argv)}`
      );
    });

    it('treats a `--output=`-style ref as a REV, never as a git flag', async () => {
      // The exploit payload: a ref named `--output=/tmp/pwned`. Without the
      // separator git would honor it as `git show --output=/tmp/pwned …` and
      // write an attacker-chosen out-of-repo file. With the fix it lands after
      // `--end-of-options`, so git treats it strictly as a (bad) revision.
      const evilRef = '--output=/tmp/pwned';
      const uri = buildIntelligGitUri('/test/repo/src/foo.ts', encodeURIComponent(evilRef));

      await provideGitShowContent(uri, gitService, [{ uri: Uri.file('/test/repo') }]);

      const argv = mockGitCli.executed[0].args;
      const eooIdx = argv.indexOf('--end-of-options');
      assert.ok(eooIdx > 0, `expected --end-of-options in argv, got ${JSON.stringify(argv)}`);
      // The payload must NOT appear ahead of the separator (where git would
      // parse it as a flag). It rides as the rev:path token AFTER the separator.
      for (let i = 1; i < eooIdx; i++) {
        assert.ok(
          !argv[i].startsWith('--output'),
          `--output payload landed as a flag before --end-of-options: ${JSON.stringify(argv)}`
        );
      }
      const revIdx = argv.indexOf(`${evilRef}:/test/repo/src/foo.ts`, eooIdx);
      assert.ok(
        revIdx > eooIdx,
        `evil ref must ride as a rev after --end-of-options; got ${JSON.stringify(argv)}`
      );
    });

    it('rejects a filePath containing `:` (would re-split the rev:path token)', async () => {
      // The token is `${ref}:${filePath}`. A `:` inside filePath makes the
      // rev:path meaning ambiguous; assert it before exec rather than handing
      // git a confusing token. No in-tree producer emits a colon-bearing path
      // (all go through repoRelativePath), so this never false-rejects.
      const uri = buildIntelligGitUri('/test/repo/src/ev:il.ts', encodeURIComponent('HEAD'));

      await assert.rejects(
        () => provideGitShowContent(uri, gitService, [{ uri: Uri.file('/test/repo') }]),
        /file path/i
      );
      assert.strictEqual(mockGitCli.executed.length, 0, 'must not exec git for an invalid path');
    });
  });

  it('wraps malformed percent-encoded refs in a friendly error (task #103 A2)', async () => {
    // `%GG` is not a valid percent-escape, so `decodeURIComponent` throws
    // `URIError: URI malformed`. The provider wraps it in a friendly `Error`
    // that names both the scheme and the offending query so logs and error
    // handlers point at the producer bug, not the decode — rather than letting
    // the raw URIError bubble up and obscure the contract violation.
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
        // Original URIError must be preserved as the cause so
        // future debugging has the platform root cause, not just our wrapper.
        assert.ok(err.cause, 'error should carry original cause');
        assert.ok(err.cause instanceof Error, 'cause should be an Error');
        assert.strictEqual(err.cause.name, 'URIError', 'cause should be URIError');
        return true;
      }
    );
  });
});

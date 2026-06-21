/**
 * Property: the `intellig-git:` content-provider sink (`provideGitShowContent`)
 * MUST splice `--end-of-options` ahead of the `<ref>:<path>` token for ANY ref,
 * so a repo/producer-controlled ref can never be parsed by git as a flag.
 *
 * Bug class [HIGH]: a ref like `--output=/tmp/pwned` (authorable in a hostile
 * clone's packed-refs as `refs/tags/--output=…`, reachable via any
 * `intellig-git:?ref=` opener) lands as the LEADING positional after `git
 * show`, so git honors it as a flag → arbitrary out-of-repo file write.
 *
 * This pins the SINK end-to-end — distinct from gitArgInjection.property.test.ts
 * which exercises `buildGitArgs` in isolation and could not see this sink (the
 * exact blind spot that let the HIGH ship).
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';
import { provideGitShowContent } from '../../src/extension';
import { GitService } from '../../src/git-core/GitService';
import { IRepository } from '../../src/git-core/interfaces/IGitService';
import { Uri } from '../mocks/vscode';

class CapturingGitCli {
  public executed: { args: string[]; options: unknown }[] = [];
  private _onCommandExecuted = {
    event: (): { dispose: () => void } => ({ dispose: (): void => {} }),
  };
  get onCommandExecuted(): () => { dispose: () => void } {
    return this._onCommandExecuted.event;
  }
  async exec(
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    this.executed.push({ args: [...args], options: {} });
    return { exitCode: 0, stdout: 'content\n', stderr: '', combined: 'content\n' };
  }
  async getRepositoryRoot(path: string): Promise<string | undefined> {
    return path;
  }
  dispose(): void {}
}

// Flag-shaped regression seeds pinned alongside a broad alphabet so the case
// re-runs deterministically every CI run (not just on random discovery).
const PINNED_EVIL_REFS = [
  '--output=/tmp/pwned',
  '--upload-pack=evil',
  '--end-of-options',
  '-rev',
  '-',
  '--',
];

const refArb = fc.oneof(
  fc.constantFrom(...PINNED_EVIL_REFS),
  fc.stringOf(fc.constantFrom(...'abcXYZ0189-_./:=@~^+'.split('')), { minLength: 1, maxLength: 30 })
);

describe('content-provider sink — argv injection property', () => {
  function freshService(): { svc: GitService; cli: CapturingGitCli } {
    const svc = new GitService();
    const cli = new CapturingGitCli();
    (svc as any)._gitCli = cli;
    const rootPath = '/test/repo';
    const repo = {
      rootUri: Uri.file(rootPath),
      state: 'idle',
      head: { name: 'refs/heads/main', commit: 'abc123', ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    } as unknown as IRepository;
    (svc as any)._repositories.set(rootPath, { repository: repo, lastUpdated: Date.now() });
    return { svc, cli };
  }

  it('any ref rides as a rev:path token AFTER --end-of-options (never a flag)', async () => {
    await fc.assert(
      fc.asyncProperty(refArb, async (ref) => {
        const { svc, cli } = freshService();
        try {
          const query = `ref=${encodeURIComponent(ref)}&repoRoot=${encodeURIComponent('/test/repo')}`;
          const uri = Uri.file('src/foo.ts').with({ query });

          await provideGitShowContent(uri as any, svc, []);

          assert.strictEqual(cli.executed.length, 1);
          const argv = cli.executed[0].args;
          const eooIdx = argv.indexOf('--end-of-options');
          assert.ok(
            eooIdx > 0,
            `--end-of-options must be present; ref=${JSON.stringify(ref)} argv=${JSON.stringify(argv)}`
          );
          // The rev:path token rides strictly after the separator.
          const revIdx = argv.indexOf(`${ref}:src/foo.ts`, eooIdx);
          assert.ok(
            revIdx > eooIdx,
            `rev:path must follow --end-of-options; ref=${JSON.stringify(ref)} argv=${JSON.stringify(argv)}`
          );
          // Nothing user-derived sits ahead of the separator (only `show`).
          for (let i = 1; i < eooIdx; i++) {
            assert.ok(
              !argv[i].includes(ref),
              `ref leaked ahead of --end-of-options; argv=${JSON.stringify(argv)}`
            );
          }
        } finally {
          svc.dispose();
        }
      }),
      { numRuns: 300 }
    );
  });
});

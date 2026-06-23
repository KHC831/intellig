/**
 * F slice — "Get version" / load a file's content at a selected revision.
 *
 * Mirrors IntelliJ's file-history "Get" path: `GitFileRevision.loadContent`
 * delegates to `GitFileUtils.getFileContent`
 * (git4idea/backend/src/util/GitFileUtils.kt), which runs
 * `git cat-file -p <rev>:<path>` to materialise the blob. We use the
 * equivalent `git show <rev>:<path>` (the form already used by the
 * `intellig-git:` content provider). The rev+path are spliced as a single
 * positional `<rev>:<path>` token behind `--end-of-options` so a hostile ref
 * like `--upload-pack=evil` can never land as a flag.
 */

import '../../setup';
import * as assert from 'assert';
import { DiffOps } from '../../../src/git-core/ops/DiffOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';

function makeOps(opts: { exitCode?: number; stdout?: string } = {}): {
  ops: DiffOps;
  calls: string[][];
} {
  const calls: string[][] = [];
  const gitCli = {
    exec: async (args: string[]) => {
      calls.push(args);
      return { exitCode: opts.exitCode ?? 0, stdout: opts.stdout ?? '', stderr: '', combined: '' };
    },
  };
  const ctx = {
    gitCli,
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return { ops: new DiffOps(ctx), calls };
}

const repo = { rootUri: { fsPath: '/repo' } } as unknown as IRepository;

describe('DiffOps.getFileAtRevision — get version at revision (F)', () => {
  it('builds a `git show <rev>:<path>` argv with the spec as one positional token', async () => {
    const { ops, calls } = makeOps({ stdout: 'file contents' });
    await ops.getFileAtRevision(repo, 'src/foo.ts', 'abc123');
    const args = calls[0];
    assert.strictEqual(args[0], 'show', 'subcommand is show');
    assert.ok(
      args.includes('abc123:src/foo.ts'),
      `expected a single <rev>:<path> token, got: ${JSON.stringify(args)}`
    );
  });

  it('inserts --end-of-options so a hostile ref cannot be parsed as a flag', async () => {
    const { ops, calls } = makeOps();
    await ops.getFileAtRevision(repo, 'src/foo.ts', '--upload-pack=evil');
    const args = calls[0];
    const eoo = args.indexOf('--end-of-options');
    const spec = args.indexOf('--upload-pack=evil:src/foo.ts');
    assert.ok(eoo !== -1, '--end-of-options must be present');
    assert.ok(spec !== -1, 'rev:path spec must be present');
    assert.ok(eoo < spec, '--end-of-options must precede the rev:path spec');
  });

  it('returns the file content from stdout on success', async () => {
    const { ops } = makeOps({ stdout: 'line1\nline2\n' });
    const result = await ops.getFileAtRevision(repo, 'src/foo.ts', 'abc123');
    assert.ok(result.isOk());
    assert.strictEqual(result._unsafeUnwrap(), 'line1\nline2\n');
  });

  it('returns an empty string when the file does not exist at that revision', async () => {
    const { ops } = makeOps({ exitCode: 128, stdout: '' });
    const result = await ops.getFileAtRevision(repo, 'src/ghost.ts', 'abc123');
    assert.ok(result.isOk(), 'a non-zero exit (missing file) is the expected domain absence');
    assert.strictEqual(result._unsafeUnwrap(), '');
  });

  it('runs against the repository root', async () => {
    const { ops } = makeOps();
    let seenCwd: string | undefined;
    const gitCli = {
      exec: async (_args: string[], options: { cwd?: string }) => {
        seenCwd = options.cwd;
        return { exitCode: 0, stdout: '', stderr: '', combined: '' };
      },
    };
    const ctx = {
      gitCli,
      invalidateCache: () => undefined,
      fireDidFetch: () => undefined,
    } as unknown as IGitOpsContext;
    const op = new DiffOps(ctx);
    await op.getFileAtRevision(repo, 'src/foo.ts', 'abc123');
    assert.strictEqual(seenCwd, '/repo');
    void ops;
  });
});

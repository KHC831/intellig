/**
 * StagingOps hunk-patch path quoting.
 *
 * `generateHunkPatch` / `generateLinesPatch` feed a hand-built unified diff to
 * `git apply` over stdin. git's own `git apply` name parser treats a TAB as a
 * field delimiter and a NEWLINE as a line delimiter, so a raw `--- a/<path>`
 * header on a file whose name contains a tab/newline (or other control/quote/
 * backslash/non-ASCII byte) makes git misparse the header → it stages the WRONG
 * file or rejects the patch. The fix mirrors git's own quoting: C-style
 * double-quote the `a/`|`b/` name when it contains a special byte, otherwise
 * emit it bare (with a trailing tab on the `---`/`+++` lines when an unquoted
 * name contains a space). These specs pin the emitted header bytes AND
 * round-trip real `git apply` on hostile names.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { StagingOps } from '../../../src/git-core/ops/StagingOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { createGitCli, GitCli } from '../../../src/git-core/gitCli';
import { IRepository, IHunk } from '../../../src/git-core/interfaces/IGitService';

interface ExecCall {
  args: string[];
  input?: string;
}

interface ScriptedResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Mock-exec context that records calls and replays scripted responses. */
function makeMockOps(script: ScriptedResult[] = []): { ops: StagingOps; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const responses = [...script];
  const gitCli = {
    exec: async (args: string[], options?: { input?: string }) => {
      calls.push({ args, input: options?.input });
      return responses.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const ctx = {
    gitCli,
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return { ops: new StagingOps(ctx), calls };
}

/** Real-git context backed by a live GitCli for round-trip assertions. */
function makeRealOps(): { ops: StagingOps; cli: GitCli } {
  const cli = createGitCli();
  const ctx = {
    gitCli: cli,
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return { ops: new StagingOps(ctx), cli };
}

const repo = (root: string): IRepository =>
  ({ rootUri: { fsPath: root } }) as unknown as IRepository;

/** A two-line hunk that turns "line1\nline2\n" into "line1\nMODIFIED\n". */
function modifyHunk(): IHunk {
  return {
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    header: '@@ -1,2 +1,2 @@',
    lines: [
      { type: 'context', content: 'line1', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'delete', content: 'line2', oldLineNumber: 2 },
      { type: 'add', content: 'MODIFIED', newLineNumber: 2 },
    ],
  };
}

/** Header (first three) lines of the patch captured from a stageHunk call. */
async function headerFor(filePath: string): Promise<string[]> {
  const { ops, calls } = makeMockOps();
  await ops.stageHunk(repo('/repo'), filePath, modifyHunk());
  const patch = calls[0].input ?? '';
  return patch.split('\n').slice(0, 3);
}

describe('StagingOps — hunk patch path quoting (Item 1)', () => {
  it('emits bare a/ b/ headers for a plain ASCII path (no quoting, no tab)', async () => {
    const [diff, minus, plus] = await headerFor('src/file.txt');
    assert.strictEqual(diff, 'diff --git a/src/file.txt b/src/file.txt');
    assert.strictEqual(minus, '--- a/src/file.txt');
    assert.strictEqual(plus, '+++ b/src/file.txt');
  });

  it('appends a trailing tab to ---/+++ for an unquoted path containing a space', async () => {
    // git leaves a space-only path unquoted but tab-delimits the ---/+++ name
    // so the parser knows where the filename ends.
    const [diff, minus, plus] = await headerFor('my file.txt');
    assert.strictEqual(diff, 'diff --git a/my file.txt b/my file.txt');
    assert.strictEqual(minus, '--- a/my file.txt\t');
    assert.strictEqual(plus, '+++ b/my file.txt\t');
  });

  it('C-style quotes a path containing a tab (git apply treats tab as a delimiter)', async () => {
    const [diff, minus, plus] = await headerFor('tab\tname.txt');
    assert.strictEqual(diff, 'diff --git "a/tab\\tname.txt" "b/tab\\tname.txt"');
    assert.strictEqual(minus, '--- "a/tab\\tname.txt"');
    assert.strictEqual(plus, '+++ "b/tab\\tname.txt"');
  });

  it('C-style quotes a path containing a newline', async () => {
    const [diff, minus, plus] = await headerFor('ab\ncd.txt');
    assert.strictEqual(diff, 'diff --git "a/ab\\ncd.txt" "b/ab\\ncd.txt"');
    assert.strictEqual(minus, '--- "a/ab\\ncd.txt"');
    assert.strictEqual(plus, '+++ "b/ab\\ncd.txt"');
  });

  it('escapes embedded double quote and backslash inside the quoted name', async () => {
    const [diff] = await headerFor('qu"o\\te.txt');
    assert.strictEqual(diff, 'diff --git "a/qu\\"o\\\\te.txt" "b/qu\\"o\\\\te.txt"');
  });

  it('octal-escapes non-ASCII bytes the way git does (é → \\303\\251)', async () => {
    const [diff, minus, plus] = await headerFor('wéird.txt');
    assert.strictEqual(diff, 'diff --git "a/w\\303\\251ird.txt" "b/w\\303\\251ird.txt"');
    assert.strictEqual(minus, '--- "a/w\\303\\251ird.txt"');
    assert.strictEqual(plus, '+++ "b/w\\303\\251ird.txt"');
  });

  it('quotes the path on the line-level (generateLinesPatch) generator too', async () => {
    const { ops, calls } = makeMockOps();
    await ops.stageLines(repo('/repo'), 'tab\tname.txt', [2], modifyHunk());
    const header = (calls[0].input ?? '').split('\n').slice(0, 3);
    assert.strictEqual(header[0], 'diff --git "a/tab\\tname.txt" "b/tab\\tname.txt"');
    assert.strictEqual(header[1], '--- "a/tab\\tname.txt"');
    assert.strictEqual(header[2], '+++ "b/tab\\tname.txt"');
  });

  describe('round-trips real git apply on hostile filenames', () => {
    let tmp: string;
    let realCli: GitCli;

    function git(cwd: string, ...args: string[]): string {
      return execFileSync('git', args, { cwd, encoding: 'utf8' });
    }

    function seed(fileName: string): void {
      git(tmp, 'init', '-q');
      git(tmp, 'config', 'user.email', 'a@b.c');
      git(tmp, 'config', 'user.name', 't');
      fs.writeFileSync(path.join(tmp, fileName), 'line1\nline2\n');
      git(tmp, 'add', '-A');
      git(tmp, 'commit', '-qm', 'init');
      fs.writeFileSync(path.join(tmp, fileName), 'line1\nMODIFIED\n');
    }

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-staging-patch-'));
    });

    afterEach(() => {
      realCli?.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('stages the correct bytes for a filename containing a tab', async () => {
      const fileName = 'tab\tname.txt';
      seed(fileName);
      const { ops, cli } = makeRealOps();
      realCli = cli;
      await ops.stageHunk(repo(tmp), fileName, modifyHunk());
      // `git show :<path>` reads the staged (index) blob — must be the modified
      // content, proving git apply parsed the quoted header to the right file.
      const staged = git(tmp, 'show', `:${fileName}`);
      assert.strictEqual(staged, 'line1\nMODIFIED\n');
    });

    it('stages the correct bytes for a filename containing a newline', async () => {
      const fileName = 'ab\ncd.txt';
      seed(fileName);
      const { ops, cli } = makeRealOps();
      realCli = cli;
      await ops.stageHunk(repo(tmp), fileName, modifyHunk());
      const staged = git(tmp, 'show', `:${fileName}`);
      assert.strictEqual(staged, 'line1\nMODIFIED\n');
    });
  });
});

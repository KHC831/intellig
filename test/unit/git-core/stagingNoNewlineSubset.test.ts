/**
 * Line-subset staging at the EOF of a no-trailing-newline file.
 *
 * The whole-hunk path serializes `noNewline` correctly; the line-subset
 * transform (unselected delete → context) rebuilt the IDiffLine and dropped
 * the flag. Two failure shapes: the emitted context claims a trailing
 * newline the index blob doesn't have (git apply rejects), or the staged
 * blob silently gains one. git itself never emits context for a kept
 * no-newline line followed by additions — it emits a `-old` + marker +
 * `+old` re-add pair — so the subset builder must do the same when a
 * selected add lands after the kept EOF line.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { StagingOps } from '../../../src/git-core/ops/StagingOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { createGitCli } from '../../../src/git-core/gitCli';
import { parseHunks } from '../../../src/git-core/gitParser';
import { IRepository, IHunk } from '../../../src/git-core/interfaces/IGitService';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

interface ExecCall {
  args: string[];
  input?: string;
}

function makeMockOps(): { ops: StagingOps; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const gitCli = {
    exec: async (args: string[], options?: { input?: string }) => {
      calls.push({ args, input: options?.input });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const ctx = {
    gitCli,
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return { ops: new StagingOps(ctx), calls };
}

const repo = (root: string): IRepository =>
  ({ rootUri: { fsPath: root } }) as unknown as IRepository;

describe('StagingOps — line-subset staging at a no-newline EOF', () => {
  it('preserves the no-newline flag when an unselected EOF delete becomes context', async () => {
    // Base "x\nmid\nlast"(noNL) → worktree "X\nmid\nlast!"(noNL). The user
    // stages only the x→X pair; the EOF pair stays unselected, so `last`
    // must come back as CONTEXT that still carries the no-newline marker.
    const hunk: IHunk = {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      header: '@@ -1,3 +1,3 @@',
      lines: [
        { type: 'delete', content: 'x', oldLineNumber: 1 },
        { type: 'add', content: 'X', newLineNumber: 1 },
        { type: 'context', content: 'mid', oldLineNumber: 2, newLineNumber: 2 },
        { type: 'delete', content: 'last', oldLineNumber: 3, noNewline: true },
        { type: 'add', content: 'last!', newLineNumber: 3, noNewline: true },
      ],
    };
    const { ops, calls } = makeMockOps();
    await ops
      .stageLines(
        repo('/repo'),
        'f.txt',
        { addLines: new Set([1]), deleteLines: new Set([1]) },
        hunk
      )
      .match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
    const lines = (calls[0].input ?? '').split('\n');
    const ctxIdx = lines.indexOf(' last');
    assert.ok(ctxIdx > 0, `kept EOF line emitted as context; patch was:\n${calls[0].input}`);
    assert.strictEqual(
      lines[ctxIdx + 1],
      '\\ No newline at end of file',
      'the context line must keep the no-newline marker'
    );
  });

  it('re-adds a kept no-newline EOF line when a selected add follows it', async () => {
    // Base "keep\nlast"(noNL) → worktree appended NEW: git's own diff shape
    // is `-last` + marker + `+last` + `+NEW`. Selecting ONLY `+NEW` cannot
    // emit `last` as no-newline context followed by an add (invalid patch) —
    // it must re-emit the delete/re-add pair.
    const hunk: IHunk = {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 3,
      header: '@@ -1,2 +1,3 @@',
      lines: [
        { type: 'context', content: 'keep', oldLineNumber: 1, newLineNumber: 1 },
        { type: 'delete', content: 'last', oldLineNumber: 2, noNewline: true },
        { type: 'add', content: 'last', newLineNumber: 2 },
        { type: 'add', content: 'NEW', newLineNumber: 3 },
      ],
    };
    const { ops, calls } = makeMockOps();
    await ops
      .stageLines(repo('/repo'), 'f.txt', { addLines: new Set([3]), deleteLines: new Set() }, hunk)
      .match(
        () => undefined,
        (e) => {
          throw e;
        }
      );
    const patch = calls[0].input ?? '';
    const lines = patch.split('\n');
    const delIdx = lines.indexOf('-last');
    assert.ok(delIdx > 0, `EOF line re-emitted as delete; patch was:\n${patch}`);
    assert.strictEqual(lines[delIdx + 1], '\\ No newline at end of file');
    assert.strictEqual(lines[delIdx + 2], '+last', 're-added with a newline');
    assert.strictEqual(lines[delIdx + 3], '+NEW');
    assert.ok(!lines.includes(' last'), 'must not emit the EOF line as context');
  });

  it('REAL GIT: a subset patch against a no-newline blob applies and preserves the EOF shape', async function () {
    this.timeout(20000);
    const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'nonewline-subset-'));
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    try {
      git('init', '-q');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      fs.writeFileSync(path.join(root, 'f.txt'), 'x\nmid\nlast'); // no trailing newline
      git('add', 'f.txt');
      git('commit', '-qm', 'base');
      fs.writeFileSync(path.join(root, 'f.txt'), 'X\nmid\nlast!'); // still no trailing newline

      const diff = git('diff', '--', 'f.txt');
      const hunks = parseHunks(diff.split('\n'));
      assert.strictEqual(hunks.length, 1, 'one hunk expected');

      const cli = createGitCli();
      const ctx = {
        gitCli: cli,
        invalidateCache: () => undefined,
        fireDidFetch: () => undefined,
      } as unknown as IGitOpsContext;
      const ops = new StagingOps(ctx);
      await ops
        .stageLines(
          repo(root),
          'f.txt',
          { addLines: new Set([1]), deleteLines: new Set([1]) },
          hunks[0]
        )
        .match(
          () => undefined,
          (e) => {
            throw e;
          }
        );

      const staged = git('show', ':f.txt');
      assert.strictEqual(staged, 'X\nmid\nlast', 'x→X staged; EOF stays newline-less');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

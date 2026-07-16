import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { GitCli } from '../../../src/git-core/gitCli';
import {
  readAutostashSha,
  beginAutostashWatch,
  finishAutostashWatch,
  withAutostashParked,
} from '../../../src/git-core/rebaseAutostash';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const CWD = '/repo';
const MARKER_SHA = 'a'.repeat(40);
const TIP_A = 'b'.repeat(40);
const TIP_B = 'c'.repeat(40);

/**
 * GitCli stub scripted by verb: `rev-parse --verify refs/stash` walks
 * `tips` (one entry per call, last repeats; undefined = no stash ref);
 * `stash list --format=%H` returns `listShas`. Any other exec throws when
 * `faulty` is set, exercising the never-throws contract.
 */
function makeCli(opts: {
  tips?: Array<string | undefined>;
  listShas?: string[];
  faulty?: boolean;
}): GitCli {
  let tipCall = 0;
  return {
    exec: async (args: string[]) => {
      if (opts.faulty) {
        throw new Error('spawn failed');
      }
      if (args[0] === 'rev-parse' && args.includes('refs/stash')) {
        const tips = opts.tips ?? [];
        const tip = tips[Math.min(tipCall, tips.length - 1)];
        tipCall++;
        return tip === undefined
          ? { exitCode: 1, stdout: '', stderr: '', combined: '' }
          : { exitCode: 0, stdout: `${tip}\n`, stderr: '', combined: '' };
      }
      if (args[0] === 'stash' && args[1] === 'list') {
        const out = (opts.listShas ?? []).join('\n') + '\n';
        return { exitCode: 0, stdout: out, stderr: '', combined: out };
      }
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
  } as unknown as GitCli;
}

describe('rebaseAutostash — parked-autostash detection', () => {
  describe('finishAutostashWatch (marker existed at begin — continue/abort sites)', () => {
    it('true when the marker SHA appears in the stash list after the op (git parked it)', async () => {
      const cli = makeCli({ listShas: [MARKER_SHA] });
      const parked = await finishAutostashWatch(cli, CWD, {
        markerSha: MARKER_SHA,
        stashTip: undefined,
      });
      assert.strictEqual(parked, true);
    });

    it('false when the marker SHA is gone (git applied it cleanly)', async () => {
      const cli = makeCli({ listShas: ['d'.repeat(40)] });
      const parked = await finishAutostashWatch(cli, CWD, {
        markerSha: MARKER_SHA,
        stashTip: undefined,
      });
      assert.strictEqual(parked, false);
    });
  });

  describe('finishAutostashWatch (no marker at begin — the executeRebase case)', () => {
    it('true when the refs/stash tip changed during the op', async () => {
      const cli = makeCli({ tips: [TIP_B] });
      const parked = await finishAutostashWatch(cli, CWD, {
        markerSha: undefined,
        stashTip: TIP_A,
      });
      assert.strictEqual(parked, true);
    });

    it('false when the refs/stash tip is unchanged', async () => {
      const cli = makeCli({ tips: [TIP_A] });
      const parked = await finishAutostashWatch(cli, CWD, {
        markerSha: undefined,
        stashTip: TIP_A,
      });
      assert.strictEqual(parked, false);
    });

    it('false when no stash ref exists before or after', async () => {
      const cli = makeCli({ tips: [undefined] });
      const parked = await finishAutostashWatch(cli, CWD, {
        markerSha: undefined,
        stashTip: undefined,
      });
      assert.strictEqual(parked, false);
    });

    it('true when a stash appeared where none existed (parked from empty)', async () => {
      const cli = makeCli({ tips: [TIP_A] });
      const parked = await finishAutostashWatch(cli, CWD, {
        markerSha: undefined,
        stashTip: undefined,
      });
      assert.strictEqual(parked, true);
    });
  });

  describe('never-throws contract', () => {
    it('begin returns an empty token on a detection fault', async () => {
      const token = await beginAutostashWatch(makeCli({ faulty: true }), CWD);
      assert.deepStrictEqual(token, { markerSha: undefined, stashTip: undefined });
    });

    it('finish returns false on a detection fault', async () => {
      const parked = await finishAutostashWatch(makeCli({ faulty: true }), CWD, {
        markerSha: MARKER_SHA,
        stashTip: undefined,
      });
      assert.strictEqual(parked, false);
    });
  });

  describe('withAutostashParked', () => {
    it('runs the op and reports the parked flag alongside its result', async () => {
      const cli = makeCli({ tips: [TIP_A, TIP_B] });
      const { result, autostashParked } = await withAutostashParked(cli, CWD, async () => 42);
      assert.strictEqual(result, 42);
      assert.strictEqual(autostashParked, true);
    });

    it('propagates an op throw without swallowing it', async () => {
      const cli = makeCli({ tips: [TIP_A] });
      await assert.rejects(
        withAutostashParked(cli, CWD, async () => {
          throw new Error('op exploded');
        }),
        /op exploded/
      );
    });
  });

  describe('readAutostashSha (marker file, worktree-correct)', () => {
    let scratch: string;

    beforeEach(() => {
      scratch = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'autostash-marker-'));
    });

    afterEach(() => {
      fs.rmSync(scratch, { recursive: true, force: true });
    });

    it('reads the SHA from .git/rebase-merge/autostash in a normal checkout', () => {
      const markerDir = path.join(scratch, '.git', 'rebase-merge');
      fs.mkdirSync(markerDir, { recursive: true });
      fs.writeFileSync(path.join(markerDir, 'autostash'), `${MARKER_SHA}\n`);
      assert.strictEqual(readAutostashSha(scratch), MARKER_SHA);
    });

    it('returns undefined when no marker exists', () => {
      fs.mkdirSync(path.join(scratch, '.git'), { recursive: true });
      assert.strictEqual(readAutostashSha(scratch), undefined);
    });

    it('follows the .git pointer FILE of a linked worktree to the real git dir', function () {
      // Real `git worktree add` fixture: `<worktree>/.git` is a pointer file,
      // so a raw path join would miss the marker under the main repo's
      // .git/worktrees/<name>/.
      this.timeout(20_000);
      const main = path.join(scratch, 'main');
      fs.mkdirSync(main, { recursive: true });
      const git = (args: string, cwd: string): void => {
        execSync(`git ${args}`, { cwd, stdio: 'ignore' });
      };
      git('init -b main', main);
      git('config user.name t', main);
      git('config user.email t@t', main);
      git('config commit.gpgsign false', main);
      fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
      git('add a.txt', main);
      git('commit -m a', main);
      const wt = path.join(scratch, 'wt');
      git(`worktree add ${JSON.stringify(wt)} -b side`, main);

      const realGitDir = fs
        .readFileSync(path.join(wt, '.git'), 'utf8')
        .match(/^gitdir:\s*(.+?)\s*$/m)![1];
      const markerDir = path.join(realGitDir, 'rebase-merge');
      fs.mkdirSync(markerDir, { recursive: true });
      fs.writeFileSync(path.join(markerDir, 'autostash'), `${MARKER_SHA}\n`);

      assert.strictEqual(readAutostashSha(wt), MARKER_SHA);
    });
  });
});

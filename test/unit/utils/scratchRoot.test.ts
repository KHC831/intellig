/**
 * The scratch base, this process's own root inside it, and the sweep that
 * reclaims abandoned roots before and after a run.
 *
 * The sweep runs in EVERY mocha process on the checkout, and lanes overlap, so
 * these pin what it must not touch as firmly as what it must.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  SCRATCH_BASE,
  SCRATCH_ROOT,
  cleanScratchRoot,
  dropOwnScratchRoot,
  __pidIsAliveForTest,
} from '../../helpers/scratchRoot';

describe('scratch root', () => {
  it('SCRATCH_BASE is the gitignored workspace-notes/tmp inside this repo', () => {
    assert.strictEqual(SCRATCH_BASE, path.resolve(__dirname, '../../../workspace-notes/tmp'));
  });

  it('this process owns a subdirectory named for its pid', () => {
    assert.strictEqual(SCRATCH_ROOT, path.join(SCRATCH_BASE, String(process.pid)));
  });

  it('refuses to sweep a directory that is not a workspace-notes/tmp', () => {
    assert.throws(() => cleanScratchRoot('/tmp/somewhere-else'), /refusing to sweep/);
  });

  // The fixtures below use a base of their own: sweeping the real one would be
  // the very race these tests exist to pin.
  function fixtureBase(): string {
    const dir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'sweep-'));
    const base = path.join(dir, 'workspace-notes', 'tmp');
    fs.mkdirSync(base, { recursive: true });
    return base;
  }

  it('reclaims a root whose owning process is gone', () => {
    const base = fixtureBase();
    // Pid 1 exists; a very high pid almost certainly does not. Assert the
    // premise rather than trusting it, so this cannot pass for the wrong reason.
    const deadPid = '4194303';
    let dead = false;
    try {
      process.kill(Number(deadPid), 0);
    } catch {
      dead = true;
    }
    assert.ok(dead, 'the fixture pid must not be a live process');
    fs.mkdirSync(path.join(base, deadPid));
    fs.writeFileSync(path.join(base, deadPid, 'leaked.txt'), 'x');

    cleanScratchRoot(base, undefined, path.join(base, '999999'));

    assert.ok(!fs.existsSync(path.join(base, deadPid)), 'an abandoned root is reclaimed');
  });

  it('leaves a root whose owning process is still alive', () => {
    const base = fixtureBase();
    const livePid = String(process.pid);
    fs.mkdirSync(path.join(base, livePid), { recursive: true });
    fs.writeFileSync(path.join(base, livePid, 'live.txt'), 'x');

    cleanScratchRoot(base, undefined, path.join(base, '999999'));

    assert.ok(
      fs.existsSync(path.join(base, livePid, 'live.txt')),
      "another lane's live fixture must survive the sweep"
    );
  });

  it('reclaims a long-abandoned root even while that pid is alive', () => {
    // Pids are recycled: a leaked root can be adopted by an unrelated
    // long-lived process, and liveness alone would leave it there forever.
    const base = fixtureBase();
    const livePid = String(process.pid);
    const dir = path.join(base, livePid);
    fs.mkdirSync(dir, { recursive: true });
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(dir, longAgo, longAgo);

    cleanScratchRoot(base, undefined, path.join(base, '999999'));

    assert.ok(!fs.existsSync(dir), 'a day-old root is reclaimed whatever owns that pid now');
  });

  it('keeps a freshly-touched root belonging to a live pid', () => {
    // The negative control for the rule above: the age fallback must not reach
    // a lane that is running right now.
    const base = fixtureBase();
    const dir = path.join(base, String(process.pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'live.txt'), 'x');

    cleanScratchRoot(base, undefined, path.join(base, '999999'));

    assert.ok(fs.existsSync(path.join(dir, 'live.txt')), "a running lane's fixture survives");
  });

  it('reclaims an entry not named for a pid', () => {
    const base = fixtureBase();
    fs.mkdirSync(path.join(base, 'legacy-leak'), { recursive: true });

    cleanScratchRoot(base, undefined, path.join(base, '999999'));

    assert.ok(!fs.existsSync(path.join(base, 'legacy-leak')), 'a pre-layout leak is reclaimed');
  });

  it('creates this run its own empty root', () => {
    const base = fixtureBase();
    const own = path.join(base, '999999');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'stale.txt'), 'x');

    cleanScratchRoot(base, undefined, own);

    assert.ok(fs.existsSync(own), 'the run gets a root');
    assert.deepStrictEqual(fs.readdirSync(own), [], 'and it starts empty');
  });

  it('teardown drops only this run’s root', () => {
    const base = fixtureBase();
    const own = path.join(base, '999999');
    const other = path.join(base, String(process.pid));
    fs.mkdirSync(own, { recursive: true });
    fs.mkdirSync(other, { recursive: true });

    dropOwnScratchRoot(own);

    assert.ok(!fs.existsSync(own), 'own root goes');
    assert.ok(fs.existsSync(other), "another lane's root stays");
  });

  it('refuses to remove a target whose parent is not workspace-notes/tmp', () => {
    // Calling dropOwnScratchRoot with `own` set to the BASE itself (exactly
    // what its default becomes if someone "simplifies" SCRATCH_ROOT to
    // SCRATCH_BASE) must not silently empty every concurrent lane's
    // fixtures — it must refuse, the same way cleanScratchRoot already
    // refuses a non-workspace-notes/tmp base.
    const base = fixtureBase();
    const other = path.join(base, String(process.pid));
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'live.txt'), 'x');

    assert.throws(() => dropOwnScratchRoot(base), /refusing to remove/);
    assert.ok(
      fs.existsSync(path.join(other, 'live.txt')),
      "a concurrent lane's fixtures must survive the refusal"
    );
  });

  it('retries once on a concurrent-write errno', () => {
    const base = fixtureBase();
    fs.mkdirSync(path.join(base, 'legacy'), { recursive: true });
    let calls = 0;
    const flaky = (target: string): void => {
      calls += 1;
      if (calls === 1) {
        const e = new Error('busy') as NodeJS.ErrnoException;
        e.code = 'ENOTEMPTY';
        throw e;
      }
      fs.rmSync(target, { recursive: true, force: true });
    };

    cleanScratchRoot(base, flaky, path.join(base, '999999'));

    assert.ok(calls >= 2, 'the transient failure was retried');
  });

  it('propagates a non-transient failure', () => {
    const base = fixtureBase();
    fs.mkdirSync(path.join(base, 'legacy'), { recursive: true });
    const denied = (): void => {
      const e = new Error('nope') as NodeJS.ErrnoException;
      e.code = 'EACCES';
      throw e;
    };

    assert.throws(() => cleanScratchRoot(base, denied, path.join(base, '999999')), /nope/);
  });

  describe('pidIsAlive', () => {
    it('treats EPERM as alive (the pid exists, owned by someone else)', () => {
      const eperm = (): never => {
        const e = new Error('perm') as NodeJS.ErrnoException;
        e.code = 'EPERM';
        throw e;
      };
      assert.strictEqual(__pidIsAliveForTest(1, eperm), true);
    });

    it('treats ESRCH (no such process) as dead', () => {
      const esrch = (): never => {
        const e = new Error('no such process') as NodeJS.ErrnoException;
        e.code = 'ESRCH';
        throw e;
      };
      assert.strictEqual(__pidIsAliveForTest(4194303, esrch), false);
    });

    it('treats a successful signal-0 as alive', () => {
      assert.strictEqual(
        __pidIsAliveForTest(process.pid, () => {}),
        true
      );
    });
  });
});

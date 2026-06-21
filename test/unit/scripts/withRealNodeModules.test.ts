/**
 * Unit tests for `scripts/lib/with-real-node-modules.sh`.
 *
 * Why this helper exists: in a `git worktree`, `node_modules` is a
 * symlink to the primary checkout's install. `vsce ls` (used by the
 * vsix structural guard) runs `npm list --production --depth=99999`,
 * which rejects a symlinked `node_modules` root — every dependency is
 * reported `extraneous` (ELSPROBLEMS), so vsce exits 1 and the guard
 * could not run. The helper materialises a copy-on-write clone of the
 * symlink target as a real `node_modules`, runs the wrapped command so
 * npm reconciles the install natively, then restores the symlink. In a
 * normal checkout (real `node_modules`) it is a transparent
 * pass-through.
 *
 * These specs pin the contract the guard relies on:
 *  - symlinked `node_modules` is presented to the command as a REAL
 *    directory carrying the target's contents (faithful listing);
 *  - the original symlink is restored afterwards;
 *  - the wrapped command's exit code is propagated verbatim, so a real
 *    failure is never masked (the guard keeps its teeth);
 *  - a real `node_modules` is left untouched (pass-through).
 */

import '../../setup';
import * as assert from 'assert';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'lib', 'with-real-node-modules.sh');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runHelper(cwd: string, command: string[]): RunResult {
  const r = spawnSync('bash', [SCRIPT, ...command], { cwd, encoding: 'utf8' });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Probe that reports whether `./node_modules` is a symlink and echoes a marker file. */
const PROBE = [
  'bash',
  '-c',
  'if [ -L node_modules ]; then echo KIND=SYMLINK; else echo KIND=REALDIR; fi; cat node_modules/marker.txt',
];

/** Lists transient swap artefacts the helper must clean up (clones, backups, lock). */
function strayArtefacts(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter(
      (n) =>
        n.startsWith('node_modules.real.') ||
        n.startsWith('node_modules.link.') ||
        n === 'node_modules.swap.lock'
    );
}

/** Resolves once `predicate()` is true or rejects after `timeoutMs`. */
function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('waitUntil timed out'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('scripts/lib/with-real-node-modules.sh — symlink-tolerant node_modules wrapper', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'with-real-nm-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Builds `<tmp>/<repo>` with a symlinked node_modules -> a real target dir. */
  function symlinkedRepo(): { repo: string; target: string } {
    const target = path.join(tmp, 'shared_node_modules');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'marker.txt'), 'CLONED_CONTENT\n');
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.symlinkSync(target, path.join(repo, 'node_modules'));
    return { repo, target };
  }

  /** Builds `<tmp>/<repo>` with a real (non-symlink) node_modules. */
  function realRepo(): { repo: string } {
    const repo = path.join(tmp, 'repo');
    const nm = path.join(repo, 'node_modules');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'marker.txt'), 'NATIVE_CONTENT\n');
    return { repo };
  }

  it('presents a symlinked node_modules to the command as a REAL directory', () => {
    const { repo } = symlinkedRepo();
    const r = runHelper(repo, PROBE);
    assert.strictEqual(r.status, 0, `expected 0; got ${r.status}\n${r.stderr}`);
    assert.match(r.stdout, /KIND=REALDIR/, 'command should see a real node_modules, not a symlink');
  });

  it('exposes the symlink target contents in the materialised node_modules', () => {
    const { repo } = symlinkedRepo();
    const r = runHelper(repo, PROBE);
    assert.match(r.stdout, /CLONED_CONTENT/, 'cloned node_modules must carry the target contents');
  });

  it('restores the original symlink after the command finishes', () => {
    const { repo, target } = symlinkedRepo();
    runHelper(repo, PROBE);
    const nm = path.join(repo, 'node_modules');
    assert.ok(fs.lstatSync(nm).isSymbolicLink(), 'node_modules must be a symlink again');
    assert.strictEqual(
      fs.realpathSync(nm),
      fs.realpathSync(target),
      'symlink must point back at the target'
    );
  });

  it('leaves no transient swap directories behind on success', () => {
    const { repo } = symlinkedRepo();
    runHelper(repo, PROBE);
    assert.deepStrictEqual(
      strayArtefacts(repo),
      [],
      'transient clone/backup dirs must be cleaned up'
    );
  });

  it('propagates the wrapped command exit code so real failures are never masked', () => {
    const { repo } = symlinkedRepo();
    const r = runHelper(repo, ['bash', '-c', 'exit 7']);
    assert.strictEqual(r.status, 7, `helper must surface the command's exit code; got ${r.status}`);
  });

  it('restores the symlink even when the wrapped command fails', () => {
    const { repo, target } = symlinkedRepo();
    runHelper(repo, ['bash', '-c', 'exit 3']);
    const nm = path.join(repo, 'node_modules');
    assert.ok(
      fs.lstatSync(nm).isSymbolicLink(),
      'node_modules must be a symlink again after failure'
    );
    assert.strictEqual(fs.realpathSync(nm), fs.realpathSync(target));
    assert.deepStrictEqual(strayArtefacts(repo), [], 'no transient dirs after a failed command');
  });

  it('passes through unchanged when node_modules is already a real directory', () => {
    const { repo } = realRepo();
    const before = fs.statSync(path.join(repo, 'node_modules')).ino;
    const r = runHelper(repo, PROBE);
    assert.strictEqual(r.status, 0, `expected 0; got ${r.status}\n${r.stderr}`);
    assert.match(r.stdout, /KIND=REALDIR/);
    assert.match(r.stdout, /NATIVE_CONTENT/);
    const after = fs.statSync(path.join(repo, 'node_modules')).ino;
    assert.strictEqual(
      after,
      before,
      'a real node_modules must be left byte-for-byte untouched (same inode)'
    );
    assert.ok(!fs.lstatSync(path.join(repo, 'node_modules')).isSymbolicLink());
  });

  it('forwards the wrapped command stdout verbatim (no helper noise on stdout)', () => {
    const { repo } = symlinkedRepo();
    const r = runHelper(repo, ['bash', '-c', 'echo ONLY_THIS_LINE']);
    assert.strictEqual(
      r.stdout.trim(),
      'ONLY_THIS_LINE',
      `helper diagnostics must go to stderr, not stdout; got: ${JSON.stringify(r.stdout)}`
    );
  });

  it('exits 2 with a usage message when no command is supplied', () => {
    const { repo } = symlinkedRepo();
    const r = runHelper(repo, []);
    assert.strictEqual(r.status, 2, `expected 2; got ${r.status}\n${r.stdout}`);
    assert.match(r.stderr, /usage: with-real-node-modules\.sh/);
  });

  it('fails with a clear message when node_modules is a dangling symlink', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    // Points at a target that does not exist — cannot be cloned.
    fs.symlinkSync(path.join(tmp, 'no-such-target'), path.join(repo, 'node_modules'));
    const r = runHelper(repo, PROBE);
    assert.strictEqual(r.status, 1, `expected 1; got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /dangling symlink/, 'must explain the dangling-symlink condition');
    // The symlink is left as-is (we never moved it).
    assert.ok(fs.lstatSync(path.join(repo, 'node_modules')).isSymbolicLink());
    assert.deepStrictEqual(strayArtefacts(repo), []);
  });

  it('restores the symlink when the wrapped command is killed by SIGTERM mid-run', async function () {
    // Core safety claim: a signal interrupt restores the symlink. Spawn
    // the helper detached (its own process group) wrapping a long sleep,
    // wait until the swap has happened, then SIGTERM the whole group.
    this.timeout(20000);
    const { repo, target } = symlinkedRepo();
    const nm = path.join(repo, 'node_modules');

    const child = spawn('bash', [SCRIPT, 'sleep', '30'], {
      cwd: repo,
      detached: true,
      stdio: 'ignore',
    });
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));

    // Wait until the helper has swapped a real clone into place.
    await waitUntil(() => !fs.lstatSync(nm).isSymbolicLink());

    // SIGTERM the process group (negative pid) so the sleep dies and the
    // helper's trap runs.
    process.kill(-child.pid!, 'SIGTERM');
    await exited;

    assert.ok(
      fs.lstatSync(nm).isSymbolicLink(),
      'node_modules must be a symlink again after SIGTERM'
    );
    assert.strictEqual(
      fs.realpathSync(nm),
      fs.realpathSync(target),
      'symlink must point back at the target'
    );
    assert.deepStrictEqual(
      strayArtefacts(repo),
      [],
      'no transient clone/backup/lock left after a signal'
    );
  });

  it('self-heals a crashed prior swap: restores the symlink from an orphaned backup', () => {
    // Reproduce the post-SIGKILL fingerprint: node_modules is a detached
    // real clone (the prior run never restored), plus an orphaned
    // node_modules.link.* backup symlink pointing at the true target.
    const target = path.join(tmp, 'shared_node_modules');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'marker.txt'), 'FRESH_TARGET\n');

    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const staleClone = path.join(repo, 'node_modules');
    fs.mkdirSync(staleClone, { recursive: true });
    fs.writeFileSync(path.join(staleClone, 'marker.txt'), 'STALE_CLONE\n');
    fs.symlinkSync(target, path.join(repo, 'node_modules.link.99999'));

    const r = runHelper(repo, PROBE);

    assert.strictEqual(r.status, 0, `expected 0; got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /interrupted mid-swap/, 'must loud-warn about the recovery');
    // The run must scan the FRESH target, never the stale clone.
    assert.match(r.stdout, /FRESH_TARGET/);
    assert.doesNotMatch(r.stdout, /STALE_CLONE/, 'must not silently scan the stale clone');
    // End state: the symlink is restored and all residue is gone.
    const nm = path.join(repo, 'node_modules');
    assert.ok(fs.lstatSync(nm).isSymbolicLink(), 'node_modules must be a symlink again');
    assert.strictEqual(fs.realpathSync(nm), fs.realpathSync(target));
    assert.deepStrictEqual(
      strayArtefacts(repo),
      [],
      'orphaned backup + stale clone must be cleared'
    );
  });
});

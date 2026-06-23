/**
 * Regression: `GitService.getRepository(uri)` must resolve a FILE path to its
 * owning repository.
 *
 * The bug (root cause of the merge-view "No repository found" error + silently
 * broken line-status/blame-command): `getCachedRepository` is exact-key by repo
 * ROOT, so a file path always missed the cache; the discovery fallback then ran
 * `git rev-parse --show-toplevel` with `cwd` set to the FILE, which `spawn`
 * rejects with ENOTDIR — so `getRepository(fileUri)` returned `undefined` for
 * any file that wasn't itself a cached repo-root key.
 *
 * Fix: ancestor-match the file against already-known repositories first (no
 * subprocess), and when a `rev-parse` IS needed, use a DIRECTORY cwd (the
 * file's parent), never the file itself.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService } from '../../../src/git-core/GitService';
import { Uri } from '../../mocks/vscode';

class RecordingGitCli {
  /** Every cwd passed to getRepositoryRoot — used to assert none is a file. */
  public rootCwds: string[] = [];

  async exec(): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }

  async getRepositoryRoot(p: string): Promise<string | undefined> {
    this.rootCwds.push(p);
    // Emulate git: a file cwd is invalid. Only a directory resolves.
    let dir = p;
    try {
      if (!fs.statSync(p).isDirectory()) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    // Walk up to the temp repo root marker (.git dir present).
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        return fs.realpathSync.native(dir);
      }
      dir = path.dirname(dir);
    }
    return undefined;
  }

  dispose(): void {}
}

describe('GitService.getRepository resolves a file path to its repo', () => {
  let gitService: GitService;
  let cli: RecordingGitCli;
  let tmpRoot: string;

  beforeEach(() => {
    gitService = new GitService();
    cli = new RecordingGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = cli;
    tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-repofile-')));
    fs.mkdirSync(path.join(tmpRoot, '.git'));
    fs.mkdirSync(path.join(tmpRoot, 'src'));
    fs.writeFileSync(path.join(tmpRoot, 'src', 'foo.ts'), 'x', 'utf8');
  });

  afterEach(() => {
    gitService.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('resolves a file inside an already-discovered repo without spawning git for the file path', async () => {
    // Discover the repo via its root dir (the normal activation path).
    const repo = await gitService.getRepository(Uri.file(tmpRoot));
    assert.ok(repo, 'repo should be discovered from its root dir');

    cli.rootCwds = [];
    const fileUri = Uri.file(path.join(tmpRoot, 'src', 'foo.ts'));
    const resolved = await gitService.getRepository(fileUri);

    assert.ok(resolved, 'getRepository must resolve a file inside the repo');
    assert.strictEqual(resolved?.rootUri.fsPath, repo?.rootUri.fsPath, 'same repo instance');
    // Ancestor match should short-circuit before any subprocess.
    assert.strictEqual(
      cli.rootCwds.length,
      0,
      'a file inside a known repo must resolve via ancestor match, not a git spawn'
    );
  });

  it('never passes a file path as the git cwd when discovery IS needed', async () => {
    // No prior discovery: force the rev-parse path for a file in an unknown repo.
    const fileUri = Uri.file(path.join(tmpRoot, 'src', 'foo.ts'));
    const resolved = await gitService.getRepository(fileUri);

    assert.ok(resolved, 'getRepository must discover the repo for an uncached file');
    assert.strictEqual(resolved?.rootUri.fsPath, tmpRoot, 'resolves to the temp repo root');
    for (const cwd of cli.rootCwds) {
      assert.ok(fs.statSync(cwd).isDirectory(), `git cwd must be a directory, got file: ${cwd}`);
    }
  });
});

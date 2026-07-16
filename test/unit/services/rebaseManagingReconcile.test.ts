import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { RebaseService } from '../../../src/git-core/RebaseService';
import { IRebaseSession } from '../../../src/git-core/interfaces/IRebaseService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import * as vscode from 'vscode';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

/**
 * Reaches the private session map to seed post-planning session states
 * (`conflict` / `in-progress`) that the public API only produces mid-flight
 * with a live git subprocess. The suite asserts the `isManagingRebase`
 * reconciliation contract: a session whose git backing is gone must be
 * self-cleared, which no public entry point can drive deterministically.
 */
interface RebaseServiceSessionTestSurface {
  _sessions: Map<string, IRebaseSession>;
}

function makeRepo(rootPath: string): IRepository {
  return {
    rootUri: vscode.Uri.file(rootPath),
    state: 'idle',
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

function makeSession(status: IRebaseSession['status']): IRebaseSession {
  return {
    onto: 'abc123',
    originalBranch: 'main',
    commits: [{ hash: 'def456', message: 'commit', action: 'pick' }],
    currentStep: 0,
    status,
  };
}

describe('RebaseService.isManagingRebase — session/git-state reconciliation', () => {
  let service: RebaseService;
  let scratchDir: string;

  beforeEach(() => {
    service = new RebaseService();
    scratchDir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'managing-reconcile-'));
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  function seed(repo: IRepository, status: IRebaseSession['status']): void {
    (service as unknown as RebaseServiceSessionTestSurface)._sessions.set(
      repo.rootUri.fsPath,
      makeSession(status)
    );
  }

  for (const status of ['conflict', 'in-progress', 'paused'] as const) {
    it(`clears a '${status}' session with no on-disk rebase and reports false`, () => {
      const repo = makeRepo(scratchDir);
      seed(repo, status);

      assert.strictEqual(
        service.isManagingRebase(repo),
        false,
        `a '${status}' session without git backing is a phantom — must reconcile to false`
      );
      assert.strictEqual(
        (service as unknown as RebaseServiceSessionTestSurface)._sessions.size,
        0,
        'the phantom session must be cleared, not just reported false'
      );
    });
  }

  it('fires the session-change event when reconciliation clears a phantom', () => {
    const repo = makeRepo(scratchDir);
    seed(repo, 'conflict');

    const fired: Array<IRebaseSession | undefined> = [];
    const sub = service.onDidChangeRebaseSession((s) => fired.push(s));
    try {
      service.isManagingRebase(repo);
    } finally {
      sub.dispose();
    }
    assert.deepStrictEqual(fired, [undefined], 'listeners must observe the cleared session');
  });

  it("keeps a 'planning' session (no git backing by design) and reports true", () => {
    const repo = makeRepo(scratchDir);
    seed(repo, 'planning');

    assert.strictEqual(service.isManagingRebase(repo), true);
    assert.strictEqual(
      (service as unknown as RebaseServiceSessionTestSurface)._sessions.size,
      1,
      'a planning session must survive reconciliation'
    );
  });

  it('keeps a paused-conflict session while the rebase IS in progress on disk', () => {
    const repo = makeRepo(scratchDir);
    fs.mkdirSync(path.join(scratchDir, '.git', 'rebase-merge'), { recursive: true });
    seed(repo, 'conflict');

    assert.strictEqual(service.isManagingRebase(repo), true);
    assert.strictEqual(
      (service as unknown as RebaseServiceSessionTestSurface)._sessions.size,
      1,
      'a live paused rebase is still managed — suppression of the generic warning holds'
    );
  });

  it('reports false untouched when no session exists', () => {
    const repo = makeRepo(scratchDir);
    assert.strictEqual(service.isManagingRebase(repo), false);
  });
});

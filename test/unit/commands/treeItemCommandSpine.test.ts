/**
 * The tree-item command spine scope — the wrapper that carries the invariants
 * the 31 branch/tag context-menu handlers used to hand-roll (and, twice now,
 * forget): tolerance of an UNDEFINED clicked item (the tree can refresh under
 * the click), target extraction (branch / tag / detached-HEAD) with
 * accepts-filtering, repo resolution (item's own repo, then the tree's
 * current repo), a sanitized failure-toast backstop, and opt-in tree refresh.
 *
 * A handler on this scope CANNOT crash on a missing item, act on the wrong
 * target kind, resolve the wrong repo in a multi-repo tree, or leak a raw
 * git error.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  registerTreeItemCommand,
  IClickedTreeItem,
  ITreeItemCommandDeps,
  TreeItemTarget,
} from '../../../src/commands/registration/commandSpine';
import type { IBranch, IRepository, ITag } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';
import type { IWorktreeEntry } from '../../../src/git-core/ops/WorktreeOps';

type Handler = (...args: unknown[]) => unknown;

const REPO_A = { rootUri: Uri.file('/a') } as unknown as IRepository;
const REPO_B = { rootUri: Uri.file('/b') } as unknown as IRepository;
const BRANCH: IBranch = { name: 'feature/x', type: 'local' } as IBranch;
const TAG: ITag = { name: 'v1.0.0', commit: 'c'.repeat(40), isAnnotated: true };

function item(over: Partial<IClickedTreeItem>): IClickedTreeItem {
  return { getDetachedHeadSha: () => undefined, ...over };
}

describe('tree-item command spine', () => {
  const handlers = new Map<string, Handler>();
  const originalRegister = vscode.commands.registerCommand;
  const win = vscode.window as unknown as Record<string, unknown>;
  let originalError: unknown;
  let errors: string[];
  let refreshes: number;
  let runs: Array<{ repo: IRepository; target: TreeItemTarget }>;
  let batches: Array<ReadonlyArray<{ repo: IRepository; target: TreeItemTarget }>>;

  const deps: ITreeItemCommandDeps = {
    getRepository: () => REPO_A,
    refresh: () => {
      refreshes += 1;
    },
  };

  beforeEach(() => {
    errors = [];
    refreshes = 0;
    runs = [];
    batches = [];
    handlers.clear();
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = (
      id: string,
      cb: Handler
    ): { dispose: () => void } => {
      handlers.set(id, cb);
      return { dispose: () => {} };
    };
    originalError = win.showErrorMessage;
    win.showErrorMessage = async (m: string): Promise<undefined> => {
      errors.push(m);
      return undefined;
    };
  });

  afterEach(() => {
    (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = originalRegister;
    win.showErrorMessage = originalError;
  });

  function register(over?: {
    accepts?: ReadonlyArray<TreeItemTarget['kind']>;
    refreshOnSuccess?: boolean;
    throwing?: boolean;
  }): Handler {
    registerTreeItemCommand(deps, {
      id: 'intellig.test.treeOp',
      failureTitle: 'Failed to tree-op',
      accepts: over?.accepts ?? ['branch'],
      refreshOnSuccess: over?.refreshOnSuccess,
      run: async (args) => {
        runs.push({ repo: args.repo, target: args.target });
        batches.push(args.batch.map((e) => ({ repo: e.repo, target: e.target })));
        if (over?.throwing) {
          throw new Error("fatal: unable to access 'https://x:ghp_LEAKED123@github.com/o/r.git/'");
        }
      },
    });
    const handler = handlers.get('intellig.test.treeOp');
    assert.ok(handler, 'command registered');
    return handler;
  }

  it('an undefined item is a silent no-op — never a crash, never a run', async () => {
    const handler = register();
    await handler(undefined);
    assert.deepStrictEqual(runs, []);
    assert.deepStrictEqual(errors, []);
  });

  it('extracts a branch target and prefers the item-carried repo (multi-repo tree)', async () => {
    const handler = register();
    await handler(item({ branch: BRANCH, repository: REPO_B }));
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].repo, REPO_B);
    assert.deepStrictEqual(runs[0].target, { kind: 'branch', branch: BRANCH });
  });

  it('falls back to the tree provider repo when the item carries none', async () => {
    const handler = register();
    await handler(item({ branch: BRANCH }));
    assert.strictEqual(runs[0].repo, REPO_A);
  });

  it('does not run when no repo can be resolved', async () => {
    const noRepoDeps: ITreeItemCommandDeps = { getRepository: () => undefined, refresh: () => {} };
    registerTreeItemCommand(noRepoDeps, {
      id: 'intellig.test.noRepo',
      failureTitle: 'Failed',
      accepts: ['branch'],
      run: async (args) => {
        runs.push({ repo: args.repo, target: args.target });
      },
    });
    await handlers.get('intellig.test.noRepo')!(item({ branch: BRANCH }));
    assert.deepStrictEqual(runs, []);
  });

  it('filters targets the command does not accept (tag clicked on a branch-only op)', async () => {
    const handler = register({ accepts: ['branch'] });
    await handler(item({ tag: TAG }));
    assert.deepStrictEqual(runs, []);
    assert.deepStrictEqual(errors, []);
  });

  it('extracts a tag target for tag commands', async () => {
    const handler = register({ accepts: ['tag'] });
    await handler(item({ tag: TAG }));
    assert.deepStrictEqual(runs[0].target, { kind: 'tag', tag: TAG });
  });

  it('extracts the detached-HEAD SHA when the command accepts it', async () => {
    const handler = register({ accepts: ['branch', 'detached'] });
    await handler(item({ getDetachedHeadSha: () => 'd'.repeat(40) }));
    assert.deepStrictEqual(runs[0].target, { kind: 'detached', sha: 'd'.repeat(40) });
  });

  it('surfaces a thrown run as ONE sanitized failure toast', async () => {
    const handler = register({ throwing: true });
    await handler(item({ branch: BRANCH }));
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /Failed to tree-op/);
    assert.ok(!errors[0].includes('ghp_LEAKED123'), 'credential must be redacted');
  });

  it('refreshOnSuccess refreshes after a clean run and NOT after a throw', async () => {
    const ok = register({ refreshOnSuccess: true });
    await ok(item({ branch: BRANCH }));
    assert.strictEqual(refreshes, 1);

    handlers.clear();
    runs = [];
    const bad = register({ refreshOnSuccess: true, throwing: true });
    await bad(item({ branch: BRANCH }));
    assert.strictEqual(refreshes, 1, 'no refresh after a failed run');
  });

  // ── Multi-select batches (canSelectMany trees pass the selection as arg 2) ──

  it('a single click without a selection yields a batch of exactly the clicked target', async () => {
    const handler = register();
    await handler(item({ branch: BRANCH }));
    assert.strictEqual(batches.length, 1);
    assert.deepStrictEqual(batches[0], [
      { repo: REPO_A, target: { kind: 'branch', branch: BRANCH } },
    ]);
  });

  it('a selection containing the clicked item yields one run with the whole batch, clicked first', async () => {
    const other: IBranch = { name: 'feature/y', type: 'local' } as IBranch;
    const third: IBranch = { name: 'feature/z', type: 'local' } as IBranch;
    const clicked = item({ branch: other, repository: REPO_B });
    const handler = register();
    await handler(clicked, [item({ branch: BRANCH }), clicked, item({ branch: third })]);
    assert.strictEqual(runs.length, 1, 'the run fires ONCE for the whole selection');
    assert.strictEqual(batches[0].length, 3);
    assert.deepStrictEqual(batches[0][0], {
      repo: REPO_B,
      target: { kind: 'branch', branch: other },
    });
    assert.deepStrictEqual(
      batches[0].slice(1).map((e) => (e.target as { branch: IBranch }).branch.name),
      ['feature/x', 'feature/z']
    );
  });

  it('batch entries resolve their OWN repos (multi-repo selection)', async () => {
    const other: IBranch = { name: 'feature/y', type: 'local' } as IBranch;
    const clicked = item({ branch: BRANCH });
    const handler = register();
    await handler(clicked, [clicked, item({ branch: other, repository: REPO_B })]);
    assert.deepStrictEqual(
      batches[0].map((e) => e.repo),
      [REPO_A, REPO_B]
    );
  });

  it('drops selection entries whose target kind the command does not accept', async () => {
    const clicked = item({ branch: BRANCH });
    const handler = register({ accepts: ['branch'] });
    await handler(clicked, [clicked, item({ tag: TAG }), item({})]);
    assert.strictEqual(batches[0].length, 1);
  });

  it('a stale selection NOT containing the clicked item collapses to the clicked target', async () => {
    const other: IBranch = { name: 'feature/y', type: 'local' } as IBranch;
    const handler = register();
    await handler(item({ branch: BRANCH }), [item({ branch: other })]);
    assert.deepStrictEqual(batches[0], [
      { repo: REPO_A, target: { kind: 'branch', branch: BRANCH } },
    ]);
  });

  it('duplicate selection entries dedupe by target identity within a repo', async () => {
    const clicked = item({ branch: BRANCH });
    const dupe = item({ branch: { name: 'feature/x', type: 'local' } as IBranch });
    const handler = register();
    await handler(clicked, [clicked, dupe]);
    assert.strictEqual(batches[0].length, 1);
  });

  it('extracts a worktree target for worktree commands, and only for them', async () => {
    const worktree = { path: '/wt/one', isMain: false } as IWorktreeEntry;
    const handler = register({ accepts: ['worktree'] });
    await handler(item({ worktree, repository: REPO_B }));
    assert.deepStrictEqual(runs[0], { repo: REPO_B, target: { kind: 'worktree', worktree } });

    runs = [];
    await register({ accepts: ['branch'] })(item({ worktree }));
    assert.deepStrictEqual(runs, [], 'a branch command ignores a worktree row');
  });

  it('dedupes selected worktrees by path', async () => {
    const one = item({ worktree: { path: '/wt/one' } as IWorktreeEntry });
    const again = item({ worktree: { path: '/wt/one' } as IWorktreeEntry });
    const two = item({ worktree: { path: '/wt/two' } as IWorktreeEntry });
    await register({ accepts: ['worktree'] })(one, [one, again, two]);
    assert.deepStrictEqual(
      batches[0].map((e) => (e.target as { worktree: IWorktreeEntry }).worktree.path),
      ['/wt/one', '/wt/two']
    );
  });
});

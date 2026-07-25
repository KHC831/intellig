/**
 * Every branch-menu ref operation that can end in conflicts must route its
 * outcome the same way: success toast, conflicts to the Resolve Conflicts
 * dialog (warning toast only when no service is wired), non-conflict failure
 * to an error toast carrying git's reason.
 *
 * Two families are pinned here. The merge / cherry-pick family covers four
 * sites (branch and tag, each way); the checkout-and-rebase family covers the
 * three routes that command takes — straight through, after Stash & Switch,
 * and after Force Checkout. Every site grew its own copy of the ladder, so
 * this suite pins them against one table each: it characterizes the behaviour
 * BEFORE the copies collapse into shared routers, and stays afterwards as the
 * fence. A site that drifts — wrong `operation`, a swallowed reason, a
 * conflict arm that dead-ends in a toast while a dialog is wired — fails here.
 */

import '../../setup';
import * as assert from 'assert';
import { errAsync, okAsync } from 'neverthrow';
import { driveBranchMenuCommand } from '../../typed/branchMenuDriver';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import type {
  IBranch,
  IGitService,
  IRepository,
  ITag,
} from '../../../src/git-core/interfaces/IGitService';
import type { IConflictResolutionService } from '../../../src/conflicts/interfaces/IConflictResolutionService';
import { CommandFailedError } from '../../../src/git-core/errors';
import { Uri } from '../../mocks/vscode';
import {
  installErrorMessageTracker,
  installInfoMessageTracker,
  installWarningMessageTracker,
  restoreMessageFunctions,
  writableWindow,
} from '../../typed/windowStub';

/** What git reports back from `mergeBranch` / `cherryPick`. */
interface IOpOutcome {
  success: boolean;
  conflicts?: string[];
  failureReason?: string;
}

interface IDialogCall {
  conflicts: Array<{ path: string; resolved: boolean }>;
  options: { operation: string; target?: string; canAbort?: boolean; canContinue?: boolean };
}

const REPO: IRepository = {
  rootUri: Uri.file('/test-repo'),
  state: 'idle',
  head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
  remotes: [],
  submodules: [],
};

function provider(): BranchTreeProvider {
  return { getRepository: () => REPO, refresh: () => {} } as unknown as BranchTreeProvider;
}

function branchItem(name: string): BranchTreeItem {
  const branch: IBranch = { name, type: 'remote', commit: 'abc1234', isHead: false };
  return new BranchTreeItem(name, 0, 'remote-branch', branch, undefined, false);
}

function localBranchItem(name: string): BranchTreeItem {
  const branch: IBranch = { name, type: 'local', commit: 'abc1234', isHead: false };
  return new BranchTreeItem(name, 0, 'local-branch', branch, undefined, false);
}

function tagItem(name: string): BranchTreeItem {
  const tag: ITag = { name, commit: 'abc1234', isAnnotated: true };
  return new BranchTreeItem(name, 0, 'tag', undefined, tag, false);
}

/**
 * A git service that answers both ref operations with `outcome`. The
 * cherry-pick picker reads `getLog`, so one commit is always on offer.
 */
function service(outcome: IOpOutcome): IGitService {
  return {
    mergeBranch: () => Promise.resolve(outcome),
    cherryPick: () => okAsync(outcome),
    getLog: () =>
      Promise.resolve([
        {
          hash: 'abc1234def',
          shortHash: 'abc1234',
          message: 'a commit',
          author: { name: 'A', email: 'a@example.com' },
          authorDate: new Date(0),
        },
      ]),
    reloadRepository: (repo: IRepository) => Promise.resolve(repo),
  } as unknown as IGitService;
}

/** The four sites, each reduced to what differs: the click and the wording. */
interface ISite {
  readonly label: string;
  readonly commandId: string;
  readonly item: () => BranchTreeItem;
  /** `operation` the Resolve Conflicts dialog must be opened with. */
  readonly operation: 'merge' | 'cherryPick';
  /** Ref the dialog must be told about — a branch name or a tag name. */
  readonly target: string;
  readonly successToast: string;
  /** Wording of the no-service fallback warning. */
  readonly conflictToast: RegExp;
  /** Wording of the non-conflict failure toast, minus git's reason. */
  readonly failureToast: RegExp;
}

const SITES: readonly ISite[] = [
  {
    label: 'branch cherry-pick',
    commandId: 'intellig.remoteBranch.cherryPickCommits',
    item: () => branchItem('origin/feature'),
    operation: 'cherryPick',
    target: 'origin/feature',
    successToast: 'Cherry-picked 1 commit(s) successfully',
    conflictToast: /^Cherry-pick conflicts in 2 file\(s\)\. Please resolve conflicts\.$/,
    failureToast: /^Failed to cherry-pick: /,
  },
  {
    label: 'tag cherry-pick',
    commandId: 'intellig.tag.cherryPick',
    item: () => tagItem('v1.0.0'),
    operation: 'cherryPick',
    target: 'v1.0.0',
    successToast: "Cherry-picked tag 'v1.0.0' successfully",
    conflictToast: /^Cherry-pick conflicts in 2 file\(s\)\. Please resolve conflicts\.$/,
    failureToast: /^Failed to cherry-pick: /,
  },
  {
    label: 'branch merge',
    commandId: 'intellig.branch.mergeIntoCurrent',
    item: () => branchItem('origin/feature'),
    operation: 'merge',
    target: 'origin/feature',
    successToast: "Merged 'origin/feature' successfully",
    conflictToast: /^Merge conflicts in 2 file\(s\)\. Please resolve conflicts\.$/,
    failureToast: /^Failed to merge 'origin\/feature': /,
  },
  {
    label: 'tag merge',
    commandId: 'intellig.tag.mergeIntoCurrent',
    item: () => tagItem('v1.0.0'),
    operation: 'merge',
    target: 'v1.0.0',
    successToast: "Merged 'v1.0.0' successfully",
    conflictToast: /^Merge conflicts in 2 file\(s\)\. Please resolve conflicts\.$/,
    failureToast: /^Failed to merge 'v1.0.0': /,
  },
];

const CONFLICTS: IOpOutcome = { success: false, conflicts: ['src/a.ts', 'src/b.ts'] };

/** Records every dialog handoff so a site that skips it is visible. */
function recordingConflictService(calls: IDialogCall[]): IConflictResolutionService {
  return {
    openResolveConflictsDialog: (
      _repo: IRepository,
      conflicts: Array<{ path: string; resolved: boolean }>,
      options: { operation: string; target?: string; canAbort?: boolean; canContinue?: boolean }
    ) => {
      calls.push({ conflicts, options });
      return Promise.resolve();
    },
  } as unknown as IConflictResolutionService;
}

describe('branch menu: ref-operation outcome routing', () => {
  beforeEach(() => {
    // The branch cherry-pick site picks commits before it runs; every other
    // site ignores this.
    writableWindow().showQuickPick = (items: unknown[]) => Promise.resolve(items);
  });

  afterEach(() => restoreMessageFunctions());

  for (const site of SITES) {
    describe(site.label, () => {
      it('reports success in an information toast', async () => {
        const info = installInfoMessageTracker();
        const cmds = new BranchContextMenuCommands(service({ success: true }), provider());

        await driveBranchMenuCommand(cmds, site.commandId, site.item());

        assert.deepStrictEqual(
          info.calls.map((c) => c.message),
          [site.successToast]
        );
      });

      it('hands conflicts to the Resolve Conflicts dialog when the service is wired', async () => {
        const warn = installWarningMessageTracker();
        const calls: IDialogCall[] = [];
        const cmds = new BranchContextMenuCommands(
          service(CONFLICTS),
          provider(),
          recordingConflictService(calls)
        );

        await driveBranchMenuCommand(cmds, site.commandId, site.item());

        assert.strictEqual(calls.length, 1, 'conflicts must open the dialog exactly once');
        assert.strictEqual(calls[0].options.operation, site.operation);
        assert.strictEqual(calls[0].options.target, site.target);
        assert.deepStrictEqual(
          calls[0].conflicts,
          CONFLICTS.conflicts?.map((path) => ({ path, resolved: false }))
        );
        // Both ops leave the sequencer mid-operation, so the dialog must offer
        // continue and abort — the reason a dead-end toast was wrong here.
        assert.strictEqual(calls[0].options.canContinue, true);
        assert.strictEqual(calls[0].options.canAbort, true);
        assert.strictEqual(
          warn.calls.length,
          0,
          'the dialog replaces the toast — showing both is double-reporting'
        );
      });

      it('falls back to a warning toast when no conflict service is wired', async () => {
        const warn = installWarningMessageTracker();
        const cmds = new BranchContextMenuCommands(service(CONFLICTS), provider());

        await driveBranchMenuCommand(cmds, site.commandId, site.item());

        assert.strictEqual(warn.calls.length, 1);
        assert.match(warn.calls[0].message, site.conflictToast);
      });

      it("surfaces git's reason on a non-conflict failure", async () => {
        const err = installErrorMessageTracker();
        const cmds = new BranchContextMenuCommands(
          service({ success: false, failureReason: 'refusing to merge unrelated histories' }),
          provider()
        );

        await driveBranchMenuCommand(cmds, site.commandId, site.item());

        assert.strictEqual(err.calls.length, 1);
        assert.match(err.calls[0].message, site.failureToast);
        assert.ok(
          err.calls[0].message.includes('refusing to merge unrelated histories'),
          `the toast must carry git's reason, got: "${err.calls[0].message}"`
        );
      });

      it('falls back to a named reason when git said nothing', async () => {
        const err = installErrorMessageTracker();
        const cmds = new BranchContextMenuCommands(service({ success: false }), provider());

        await driveBranchMenuCommand(cmds, site.commandId, site.item());

        assert.strictEqual(err.calls.length, 1);
        assert.match(err.calls[0].message, site.failureToast);
        assert.ok(
          err.calls[0].message.includes('unknown error (no output from git)'),
          `a silent git failure must still say something, got: "${err.calls[0].message}"`
        );
      });
    });
  }
});

/** Rebase results carry a continuability flag the merge/cherry-pick ones don't. */
interface IRebaseOutcome extends IOpOutcome {
  rebaseInProgress?: boolean;
}

/** The dirty-tree error that opens the Stash & Switch / Force Checkout prompt. */
const DIRTY_TREE = new CommandFailedError(
  1,
  '',
  'Your local changes would be overwritten by checkout'
);

/**
 * A git service for `checkoutAndRebase`. `dirtyFirstCheckout` makes the first
 * checkout fail the way a dirty tree does, which is what sends the command
 * down its Stash & Switch / Force Checkout routes.
 */
function checkoutService(outcome: IRebaseOutcome, dirtyFirstCheckout: boolean): IGitService {
  let checkouts = 0;
  return {
    checkout: () => {
      checkouts += 1;
      return dirtyFirstCheckout && checkouts === 1 ? errAsync(DIRTY_TREE) : okAsync(undefined);
    },
    rebaseBranch: () => Promise.resolve(outcome),
    stash: () => okAsync(undefined),
    stashList: () => Promise.resolve([{ index: 0, hash: 'stash1', message: 'auto' }]),
    stashPop: () => okAsync(undefined),
    reloadRepository: (repo: IRepository) => Promise.resolve(repo),
  } as unknown as IGitService;
}

/** The three routes `checkoutAndRebase` can take to the same rebase. */
interface IRebaseRoute {
  readonly label: string;
  /** Answer to the dirty-tree prompt, or undefined when the tree is clean. */
  readonly choice?: string;
  readonly successToast: string;
}

const REBASE_ROUTES: readonly IRebaseRoute[] = [
  {
    label: 'clean tree',
    successToast: "Checked out 'feature/x' and rebased onto 'main'",
  },
  {
    label: 'after Stash & Switch',
    choice: 'Stash & Switch',
    successToast: "Stashed changes, checked out 'feature/x' and rebased onto 'main'",
  },
  {
    label: 'after Force Checkout',
    choice: 'Force Checkout',
    successToast: "Force checked out 'feature/x' and rebased onto 'main'",
  },
];

const REBASE_CONFLICTS: IRebaseOutcome = {
  success: false,
  conflicts: ['src/a.ts'],
  rebaseInProgress: true,
};

describe('branch menu: checkout-and-rebase outcome routing', () => {
  afterEach(() => restoreMessageFunctions());

  for (const route of REBASE_ROUTES) {
    describe(route.label, () => {
      /** Drive the command down this route with the given rebase result. */
      async function run(
        outcome: IRebaseOutcome,
        conflictService?: IConflictResolutionService
      ): Promise<void> {
        installWarningMessageTracker(route.choice);
        const cmds = new BranchContextMenuCommands(
          checkoutService(outcome, route.choice !== undefined),
          provider(),
          conflictService
        );
        await driveBranchMenuCommand(
          cmds,
          'intellig.branch.checkoutAndRebase',
          localBranchItem('feature/x')
        );
      }

      it('reports success in an information toast', async () => {
        const info = installInfoMessageTracker();

        await run({ success: true });

        assert.deepStrictEqual(
          info.calls.map((c) => c.message),
          [route.successToast]
        );
      });

      it('hands conflicts to the Resolve Conflicts dialog as a rebase', async () => {
        const calls: IDialogCall[] = [];

        await run(REBASE_CONFLICTS, recordingConflictService(calls));

        assert.strictEqual(calls.length, 1, 'conflicts must open the dialog exactly once');
        // 'rebase' is what tells the resolver ours and theirs are reversed —
        // mislabelling it hands the user the wrong side of every conflict.
        assert.strictEqual(calls[0].options.operation, 'rebase');
        assert.strictEqual(calls[0].options.target, 'main');
        assert.strictEqual(calls[0].options.canContinue, true);
      });

      it("surfaces git's reason on a non-conflict failure", async () => {
        const err = installErrorMessageTracker();

        await run({ success: false, failureReason: 'cannot rebase: you have unstaged changes' });

        assert.strictEqual(err.calls.length, 1);
        assert.match(err.calls[0].message, /^Failed to rebase onto 'main': /);
        assert.ok(
          err.calls[0].message.includes('cannot rebase: you have unstaged changes'),
          `the toast must carry git's reason, got: "${err.calls[0].message}"`
        );
      });

      it('falls back to a named reason when git said nothing', async () => {
        const err = installErrorMessageTracker();

        await run({ success: false });

        assert.strictEqual(err.calls.length, 1);
        assert.ok(
          err.calls[0].message.includes('unknown error (no output from git)'),
          `a silent git failure must still say something, got: "${err.calls[0].message}"`
        );
      });
    });
  }
});

describe('branch menu: rebase-current-onto outcome routing', () => {
  afterEach(() => restoreMessageFunctions());

  /** No dialog opener wired, so the command takes its inline rebase path. */
  async function run(
    outcome: IRebaseOutcome,
    conflictService?: IConflictResolutionService
  ): Promise<void> {
    const gitService = {
      rebaseBranch: () => Promise.resolve(outcome),
      reloadRepository: (repo: IRepository) => Promise.resolve(repo),
    } as unknown as IGitService;
    const cmds = new BranchContextMenuCommands(gitService, provider(), conflictService);
    await driveBranchMenuCommand(
      cmds,
      'intellig.branch.rebaseCurrentOnto',
      localBranchItem('feature/x')
    );
  }

  it('reports success in an information toast', async () => {
    const info = installInfoMessageTracker();

    await run({ success: true });

    assert.deepStrictEqual(
      info.calls.map((c) => c.message),
      ["Rebased onto 'feature/x' successfully"]
    );
  });

  it('hands conflicts to the Resolve Conflicts dialog as a rebase', async () => {
    const calls: IDialogCall[] = [];

    await run(REBASE_CONFLICTS, recordingConflictService(calls));

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].options.operation, 'rebase');
    assert.strictEqual(calls[0].options.target, 'feature/x');
  });

  it("surfaces git's reason on a non-conflict failure", async () => {
    const err = installErrorMessageTracker();

    await run({ success: false, failureReason: 'cannot rebase: you have unstaged changes' });

    assert.strictEqual(err.calls.length, 1);
    assert.match(err.calls[0].message, /^Failed to rebase onto 'feature\/x': /);
    assert.ok(err.calls[0].message.includes('cannot rebase: you have unstaged changes'));
  });

  it('falls back to a named reason when git said nothing', async () => {
    const err = installErrorMessageTracker();

    await run({ success: false });

    assert.strictEqual(err.calls.length, 1);
    assert.ok(err.calls[0].message.includes('unknown error (no output from git)'));
  });
});

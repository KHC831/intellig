/**
 * Untracked-overwrite checkout arm — git4idea GitCheckoutOperation parity.
 *
 * The reference distinguishes two "would be overwritten" arms
 * (GitCheckoutOperation.java:181-190): TRACKED local changes get the smart
 * checkout offer (stash → checkout → unstash), while UNTRACKED files are a
 * fatal error listing the files (GitUntrackedFilesOverwrittenByOperationDetector)
 * — a stash without `--include-untracked` cannot move them, so offering
 * Stash & Switch on that arm is a guaranteed retry loop.
 */

import '../../setup';
import { driveBranchMenuCommand } from '../../typed/branchMenuDriver';
import { errAsync, okAsync } from 'neverthrow';
import * as assert from 'assert';
import { BranchContextMenuCommands } from '../../../src/branches/BranchContextMenuCommands';
import { parseUntrackedOverwriteFiles } from '../../../src/git-core/gitProse';
import { BranchTreeItem, BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';
import { IBranch, IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';
import {
  installErrorMessageTracker,
  installWarningMessageTracker,
  restoreMessageFunctions,
} from '../../typed/windowStub';

const NEW_FORM =
  'error: The following untracked working tree files would be overwritten by checkout:\n' +
  '\tsrc/generated.ts\n' +
  '\tdocs/out.md\n' +
  'Please move or remove them before you switch branches.\n' +
  'Aborting';

const OLD_FORM =
  "error: Untracked working tree file 'src/generated.ts' would be overwritten by checkout.";

const TRACKED_FORM =
  'error: Your local changes to the following files would be overwritten by checkout:\n' +
  '\tsrc/app.ts\n' +
  'Please commit your changes or stash them before you switch branches.\n' +
  'Aborting';

describe('parseUntrackedOverwriteFiles', () => {
  it('parses the modern multi-file form with its file list', () => {
    const files = parseUntrackedOverwriteFiles(NEW_FORM);
    assert.deepStrictEqual(files, ['src/generated.ts', 'docs/out.md']);
  });

  it('parses the legacy single-file form', () => {
    const files = parseUntrackedOverwriteFiles(OLD_FORM);
    assert.deepStrictEqual(files, ['src/generated.ts']);
  });

  it('returns null for the TRACKED local-changes form (smart checkout stays offered)', () => {
    assert.strictEqual(parseUntrackedOverwriteFiles(TRACKED_FORM), null);
  });

  it('returns null for unrelated errors', () => {
    assert.strictEqual(parseUntrackedOverwriteFiles('fatal: not a git repository'), null);
  });
});

// ─── Handler wiring ───────────────────────────────────────────────────────────

interface RecordingGitService extends IGitService {
  _stashCalls: number;
  _checkoutCalls: number;
}

function makeService(checkoutError: string): RecordingGitService {
  const service = {
    _stashCalls: 0,
    _checkoutCalls: 0,
    checkout(this: RecordingGitService) {
      this._checkoutCalls += 1;
      return errAsync(new Error(checkoutError));
    },
    stash(this: RecordingGitService) {
      this._stashCalls += 1;
      return okAsync(undefined);
    },
    stashList: async () => [],
    reloadRepository: async (repo: IRepository) => repo,
  } as unknown as RecordingGitService;
  return service;
}

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

function makeProvider(repo: IRepository): BranchTreeProvider {
  return {
    getRepository: () => repo,
    refresh: () => {},
  } as unknown as BranchTreeProvider;
}

function branchItem(name: string): BranchTreeItem {
  const branch: IBranch = { name, type: 'local', commit: 'abc1234', isHead: false };
  return new BranchTreeItem(name, 0, 'local-branch', branch, undefined, false);
}

describe('checkout untracked-overwrite arm — fatal file list, no Stash & Switch', () => {
  afterEach(() => restoreMessageFunctions());

  it('does NOT offer Stash & Switch when untracked files block the checkout', async () => {
    const repo = makeRepo();
    const service = makeService(NEW_FORM);
    // If the Stash & Switch dialog WERE shown, this tracker would accept it
    // and the handler would stash + retry — the retry-loop bug.
    const warn = installWarningMessageTracker('Stash & Switch');
    const err = installErrorMessageTracker();
    const cmds = new BranchContextMenuCommands(service, makeProvider(repo));

    await driveBranchMenuCommand(cmds, 'intellig.branch.checkout', branchItem('feature'));

    assert.strictEqual(
      service._stashCalls,
      0,
      'must not stash — stash cannot move untracked files'
    );
    assert.strictEqual(service._checkoutCalls, 1, 'no blind retry');
    assert.strictEqual(
      warn.calls.filter((c) => /Stash & Switch/.test(JSON.stringify(c))).length,
      0,
      'the Stash & Switch offer must not appear on the untracked arm'
    );
    const all = err.calls.map((c) => c.message).join(' | ');
    assert.ok(
      /untracked/i.test(all) && /src\/generated\.ts/.test(all),
      `fatal error must name the untracked files; got: ${all}`
    );
  });

  it('still offers Stash & Switch for TRACKED dirty-tree errors', async () => {
    const repo = makeRepo();
    const service = makeService(TRACKED_FORM);
    const warn = installWarningMessageTracker();
    installErrorMessageTracker();
    const cmds = new BranchContextMenuCommands(service, makeProvider(repo));

    await driveBranchMenuCommand(cmds, 'intellig.branch.checkout', branchItem('feature'));

    assert.strictEqual(warn.calls.length, 1, 'tracked arm keeps the smart-checkout offer');
  });
});

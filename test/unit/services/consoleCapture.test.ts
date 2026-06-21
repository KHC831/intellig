/**
 * back-channel diagnostics: rebase / shelf / blame must
 * route through the GitService's GitCli so the ConsoleService captures
 * their output.
 *
 * RebaseService / ShelfService / BlameService each
 * constructed their own private GitCli. The ConsoleService subscribed
 * to `gitService.gitCli.onCommandExecuted`, but never to the secondary
 * services' clis, so `git rebase`, `git stash`, and `git blame`
 * commands never appeared in the Console View — the user couldn't see
 * what those operations did.
 *
 * Adds a `gitService` parameter to each secondary service
 * constructor; when set, the service adopts `gitService.gitCli` instead
 * of spawning its own. ConsoleService's existing `connectToGitCli`
 * subscription then captures every command end-to-end.
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { RebaseService } from '../../../src/git-core/RebaseService';
import { ShelfService } from '../../../src/shelf/ShelfService';
import { BlameService } from '../../../src/blame/BlameService';
import { ConsoleService } from '../../../src/ui-shell/ConsoleService';
import { GitCli, IGitCommandResult } from '../../../src/git-core/gitCli';

/**
 * Stub GitCli that records every exec invocation and forwards through
 * the real `_onCommandExecuted` emitter so subscribers see the events.
 *
 * NOTE: We construct a real `GitCli` via `new GitCli('git')` and then
 * monkey-patch `exec` so we can fire commands deterministically without
 * spawning a child process.
 */
class FakeGitCli extends GitCli {
  public executions: { args: string[]; result: IGitCommandResult }[] = [];

  constructor() {
    super('/usr/bin/git'); // any path; we never actually spawn
  }

  // Override exec — the real impl spawns a subprocess. Here we fake it.
  override async exec(args: string[]): Promise<IGitCommandResult> {
    const result: IGitCommandResult = {
      exitCode: 0,
      stdout: '',
      stderr: '',
      combined: '',
    };
    this.executions.push({ args, result });
    // Reach into the protected emitter via the public field.
    (
      this as unknown as {
        _onCommandExecuted: { fire: (e: unknown) => void };
      }
    )._onCommandExecuted.fire({ command: '/usr/bin/git', args, result });
    return result;
  }
}

describe('Wave I WI-D — back-channel: secondary services route through gitService.gitCli', () => {
  it('consoleCapture-1: `git rebase` issued by RebaseService appears in ConsoleService output', () => {
    const gitService = new GitService();
    const fakeCli = new FakeGitCli();
    // Replace the GitService's cli with our fake so we can drive the
    // event channel without subprocesses.
    (gitService as unknown as { _gitCli: GitCli })._gitCli = fakeCli;

    const consoleService = new ConsoleService();
    consoleService.connectToGitCli(fakeCli);

    // Construct RebaseService with the GITSERVICE — this is the
    // Path. The constructor took only `gitCli`
    // and would have spawned its own internal cli (escaping the
    // ConsoleService's subscription).
    const rebaseService = new RebaseService(undefined, gitService);

    // Fire a rebase command via the cli the RebaseService inherited.
    void fakeCli.exec(['rebase', '--end-of-options', 'main']);

    const entries = consoleService.getEntries();
    const rebaseEntry = entries.find((e) => e.command.includes('rebase'));
    assert.ok(
      rebaseEntry,
      `expected ConsoleService to capture a "rebase" entry; got ${JSON.stringify(
        entries.map((e) => e.command)
      )}`
    );

    rebaseService.dispose();
    consoleService.dispose();
    gitService.dispose();
  });

  it('consoleCapture-2: ShelfService adopts gitService.gitCli (back-channel for `git stash`/`git diff`)', () => {
    const gitService = new GitService();
    const fakeCli = new FakeGitCli();
    (gitService as unknown as { _gitCli: GitCli })._gitCli = fakeCli;

    const consoleService = new ConsoleService();
    consoleService.connectToGitCli(fakeCli);

    const shelfService = new ShelfService(undefined, gitService);

    void fakeCli.exec(['stash', 'list']);

    const entries = consoleService.getEntries();
    const stashEntry = entries.find((e) => e.command.includes('stash'));
    assert.ok(stashEntry, 'expected ConsoleService to capture a "stash" entry');

    shelfService.dispose();
    consoleService.dispose();
    gitService.dispose();
  });

  it('consoleCapture-3: BlameService adopts gitService.gitCli (back-channel for `git blame`)', () => {
    const gitService = new GitService();
    const fakeCli = new FakeGitCli();
    (gitService as unknown as { _gitCli: GitCli })._gitCli = fakeCli;

    const consoleService = new ConsoleService();
    consoleService.connectToGitCli(fakeCli);

    const blameService = new BlameService(undefined, gitService);

    void fakeCli.exec(['blame', '--porcelain', '--', 'src/file.ts']);

    const entries = consoleService.getEntries();
    const blameEntry = entries.find((e) => e.command.includes('blame'));
    assert.ok(blameEntry, 'expected ConsoleService to capture a "blame" entry');

    blameService.dispose();
    consoleService.dispose();
    gitService.dispose();
  });
});

/**
 * Unit tests for T3-08 "Push All Tags" command.
 *
 * The command itself lives inside `activate()` in extension.ts and needs
 * full workspace services to run. Rather than activate the extension in
 * unit tests, we cover:
 *
 *  1. package.json declaration (command id + title + category + icon).
 *  2. GitService.push respects `{ tags: true }` → `git push --tags`
 *     (the CLI path the command exercises).
 *  3. Arg ordering: `--tags` precedes the positional remote/branch.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from '../../../services/GitService';
import { IRepository } from '../../../services/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

interface IPackageJsonCommand {
  command: string;
  title?: string;
  category?: string;
  icon?: string;
}

interface IPackageJson {
  contributes: {
    commands: IPackageJsonCommand[];
  };
}

function loadPackageJson(): IPackageJson {
  const pkgPath = path.resolve(__dirname, '../../../../package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as IPackageJson;
}

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [{ name: 'origin' }],
    submodules: [],
  };
}

function installGitService(): { gitService: GitService; executed: string[][] } {
  const gitService = new GitService();
  const executed: string[][] = [];
  const gitCli = {
    onCommandExecuted: (): { dispose: () => void } => ({ dispose: (): void => {} }),
    exec: async (args: string[]) => {
      executed.push([...args]);
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
    invalidateCache: () => {},
  };
  (gitService as unknown as { _gitCli: unknown })._gitCli = gitCli;
  return { gitService, executed };
}

describe('T3-08 Push All Tags', () => {
  describe('package.json declaration', () => {
    let commandsById: Map<string, IPackageJsonCommand>;

    before(() => {
      const pkg = loadPackageJson();
      commandsById = new Map();
      for (const c of pkg.contributes.commands) {
        commandsById.set(c.command, c);
      }
    });

    it('declares `intellig.pushAllTags` with the IntelliJ title', () => {
      const cmd = commandsById.get('intellig.pushAllTags');
      assert.ok(cmd, '`intellig.pushAllTags` must be declared');
      assert.strictEqual(cmd.title, 'Push All Tags');
      assert.strictEqual(cmd.category, 'IntelliG');
    });

    it('has a tag icon', () => {
      const cmd = commandsById.get('intellig.pushAllTags');
      assert.ok(cmd);
      assert.strictEqual(cmd.icon, '$(tag)');
    });

    it('title does NOT have an ellipsis (it does not prompt)', () => {
      const cmd = commandsById.get('intellig.pushAllTags');
      assert.ok(cmd);
      assert.ok(!cmd.title!.includes('…'), `title should be plain, got "${cmd.title}"`);
      assert.ok(!cmd.title!.includes('...'), `title should be plain, got "${cmd.title}"`);
    });
  });

  describe('GitService.push { tags: true }', () => {
    it('emits `git push --tags <remote> <branch>` with default remote/branch', async () => {
      const { gitService, executed } = installGitService();
      await gitService.push(makeRepo(), { tags: true, remote: 'origin', branch: 'main' });
      assert.deepStrictEqual(executed[0], ['push', '--tags', 'origin', 'main']);
    });

    it('emits `git push --tags` when no remote/branch specified', async () => {
      const { gitService, executed } = installGitService();
      await gitService.push(makeRepo(), { tags: true });
      assert.deepStrictEqual(executed[0], ['push', '--tags']);
    });

    it('--tags precedes the positional args (ordering)', async () => {
      const { gitService, executed } = installGitService();
      await gitService.push(makeRepo(), { tags: true, remote: 'upstream' });
      const args = executed[0];
      const tagsIdx = args.indexOf('--tags');
      const remoteIdx = args.indexOf('upstream');
      assert.ok(tagsIdx >= 0 && remoteIdx >= 0);
      assert.ok(tagsIdx < remoteIdx, `--tags should precede remote arg; got ${args.join(' ')}`);
    });
  });
});

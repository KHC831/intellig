/**
 * Real-git coverage for the CRLF check-in warning's gitattributes exclusion
 * (gatherCheckinContext / CheckinChecks.ts). The mock-argv suite
 * (checkinChecks.test.ts) exercises `readAttributedPaths` against a fixture
 * `git check-attr` that answers whatever the fixture is told to; this spec
 * runs real git so a wrapped `check-attr` argument (which git echoes back
 * verbatim, unlike a pathspec-filtering subcommand) cannot hide behind a
 * fixture that launders the wire format.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { gatherCheckinContext } from '../../../src/commits/CheckinChecks';
import { createGitCli } from '../../../src/git-core/gitCli';
import type {
  IGitService,
  IRepository,
  IFileStatus,
} from '../../../src/git-core/interfaces/IGitService';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(prefix: string): string {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, prefix));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
  return root;
}

describe('gatherCheckinContext — CRLF gitattributes exclusion (real git)', () => {
  it('does not warn on a CRLF file whose text/crlf attribute is specified via * text=auto', async () => {
    const root = initRepo('crlf-attr-');
    fs.writeFileSync(path.join(root, '.gitattributes'), '* text=auto\n');
    fs.writeFileSync(path.join(root, 'crlf.txt'), 'a\r\nb\r\n');
    git(root, 'add', '.gitattributes', 'crlf.txt');
    git(root, 'commit', '-q', '-m', 'seed');
    // core.autocrlf left unset (the repo-level config above only sets it to
    // 'false', which the CRLF check treats the same as unset — not normalizing).

    const gitService: IGitService = {
      getStatus: async (): Promise<IFileStatus[]> => [
        { path: 'crlf.txt', indexStatus: 'M', workTreeStatus: ' ' } as IFileStatus,
      ],
      gitCli: createGitCli(),
    } as unknown as IGitService;
    const repo = { rootUri: vscode.Uri.file(root) } as IRepository;

    const ctx = await gatherCheckinContext(gitService, repo, ['crlf.txt']);
    const file = ctx.files.find((f) => f.path === 'crlf.txt');
    assert.ok(file, 'crlf.txt must be in the checked-in file list');
    assert.strictEqual(
      file.hasCrlf,
      false,
      'a CRLF file whose text/crlf attribute is specified must not warn (git4idea GitCrlfProblemsDetector parity)'
    );
  });

  it('still warns on a CRLF file with no matching gitattributes rule', async () => {
    const root = initRepo('crlf-noattr-');
    fs.writeFileSync(path.join(root, 'crlf.txt'), 'a\r\nb\r\n');
    git(root, 'add', 'crlf.txt');
    git(root, 'commit', '-q', '-m', 'seed');

    const gitService: IGitService = {
      getStatus: async (): Promise<IFileStatus[]> => [
        { path: 'crlf.txt', indexStatus: 'M', workTreeStatus: ' ' } as IFileStatus,
      ],
      gitCli: createGitCli(),
    } as unknown as IGitService;
    const repo = { rootUri: vscode.Uri.file(root) } as IRepository;

    const ctx = await gatherCheckinContext(gitService, repo, ['crlf.txt']);
    const file = ctx.files.find((f) => f.path === 'crlf.txt');
    assert.ok(file);
    assert.strictEqual(file.hasCrlf, true, 'an unattributed CRLF file must still warn');
  });
});

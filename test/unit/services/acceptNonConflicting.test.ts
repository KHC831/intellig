/**
 * Behavioral tests for "Accept non-conflicting changes from both sides".
 *
 * Mirrors IntelliJ `ApplyNonConflictsAction` /
 * `MergeThreesideViewer.applyNonConflictedChanges`
 * (platform/diff-impl/src/com/intellij/diff/merge): of all three-way changes,
 * resolve only those that are NOT true conflicts — i.e. the regions exactly one
 * side touched — taking that side, and leave the regions both sides changed for
 * the user. We delegate the actual three-way text merge to git's own
 * `git merge-file`, which auto-applies one-sided hunks and re-emits conflict
 * markers for two-sided ones.
 */

import '../../setup';
import * as assert from 'assert';
import { okAsync } from 'neverthrow';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import {
  ConflictResolutionService,
  mergeNonConflictingText,
} from '../../../src/conflicts/ConflictResolutionService';
import { createGitCli } from '../../../src/git-core/gitCli';
import {
  IGitService,
  IRepository,
  IFileStatus,
} from '../../../src/git-core/interfaces/IGitService';
import { IGitCommandResult } from '../../../src/git-core/gitCli';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Create a temp repo whose `feature.txt` is left mid-merge with:
 *  - a non-overlapping change on OUR side (top line)
 *  - a non-overlapping change on THEIR side (bottom line)
 *  - one true conflict (both sides changed the middle line differently)
 */
function makeConflictedRepo(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-b1-'));
  git(root, 'init', '-q', '-b', 'mainline');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');

  const base = ['top', 'b', 'c', 'd', 'middle', 'f', 'g', 'h', 'bottom', ''].join('\n');
  fs.writeFileSync(path.join(root, 'feature.txt'), base);
  git(root, 'add', 'feature.txt');
  git(root, 'commit', '-q', '-m', 'base');

  git(root, 'checkout', '-q', '-b', 'theirs');
  const theirs = ['top', 'b', 'c', 'd', 'middle-THEIRS', 'f', 'g', 'h', 'bottom-THEIRS', ''].join(
    '\n'
  );
  fs.writeFileSync(path.join(root, 'feature.txt'), theirs);
  git(root, 'commit', '-q', '-am', 'theirs');

  git(root, 'checkout', '-q', 'mainline');
  const ours = ['top-OURS', 'b', 'c', 'd', 'middle-OURS', 'f', 'g', 'h', 'bottom', ''].join('\n');
  fs.writeFileSync(path.join(root, 'feature.txt'), ours);
  git(root, 'commit', '-q', '-am', 'ours');

  // Produce the conflict; merge exits non-zero, which execFileSync throws on —
  // swallow because the conflicted state is exactly what we want.
  try {
    git(root, 'merge', 'theirs');
  } catch {
    // expected — merge left conflict markers
  }

  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Service backed by a real GitCli + a real working tree; getStatus/stage are real-ish. */
function makeService(root: string): {
  service: ConflictResolutionService;
  staged: string[];
} {
  const cli = createGitCli();
  const staged: string[] = [];

  const gitService = {
    gitCli: cli,
    getStatus: async (): Promise<IFileStatus[]> => {
      // Parse real porcelain so the modify/delete routing reads true X/Y codes.
      const out = git(root, 'status', '--porcelain');
      return out
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => ({
          path: l.slice(3),
          indexStatus: l[0],
          workTreeStatus: l[1],
        })) as IFileStatus[];
    },
    stage: (_repo: IRepository, paths: string[]) => {
      git(root, 'add', '--', ...paths);
      staged.push(...paths);
      return okAsync(undefined);
    },
    onDidChangeRepository: new vscode.EventEmitter<IRepository>().event,
  } as unknown as IGitService;

  return { service: new ConflictResolutionService(gitService), staged };
}

describe('ConflictResolutionService.acceptNonConflictingChanges() — real git', () => {
  it('applies both non-overlapping changes and leaves the true conflict unresolved', async () => {
    const { root, cleanup } = makeConflictedRepo();
    try {
      const { service, staged } = makeService(root);
      const repo: IRepository = {
        rootUri: vscode.Uri.file(root),
        state: 'merging',
        remotes: [],
        submodules: [],
      } as unknown as IRepository;

      const result = await service.acceptNonConflictingChanges(repo, 'feature.txt');
      assert.strictEqual(result.success, true, result.error);
      // A true conflict remains, so the file is not fully resolved and the
      // caller is told how many hunks are left (drives the feedback toast).
      assert.strictEqual(result.fullyResolved, false);
      assert.strictEqual(result.remainingHunks, 1);

      const merged = fs.readFileSync(path.join(root, 'feature.txt'), 'utf8');
      // Non-overlapping changes auto-applied from each side.
      assert.ok(merged.includes('top-OURS'), 'ours-only top change applied');
      assert.ok(merged.includes('bottom-THEIRS'), 'theirs-only bottom change applied');
      // True conflict is preserved (still has markers, both variants present).
      assert.ok(merged.includes('<<<<<<<'), 'true conflict markers preserved');
      assert.ok(merged.includes('middle-OURS') && merged.includes('middle-THEIRS'));

      // File stays unresolved (NOT staged) because a true conflict remains.
      assert.ok(!staged.includes('feature.txt'), 'must not stage while a conflict remains');
      const stillUnmerged = await service.getConflictedFiles(repo);
      assert.ok(
        stillUnmerged.some((c) => c.path === 'feature.txt'),
        'file must remain in the unmerged set'
      );

      service.dispose();
    } finally {
      cleanup();
    }
  });
});

describe('ConflictResolutionService.acceptNonConflictingChanges() — feedback fields', () => {
  it('reports remainingHunks > 0 for an add/add conflict (the silent no-op case)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-anc-aa-'));
    try {
      git(root, 'init', '-q', '-b', 'mainline');
      git(root, 'config', 'user.email', 'test@example.com');
      git(root, 'config', 'user.name', 'Test');
      git(root, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
      git(root, 'add', 'seed.txt');
      git(root, 'commit', '-q', '-m', 'seed');
      git(root, 'checkout', '-q', '-b', 'theirs');
      fs.writeFileSync(path.join(root, 'new.txt'), 'a\nTHEIRS\nc\n');
      git(root, 'add', 'new.txt');
      git(root, 'commit', '-q', '-m', 't');
      git(root, 'checkout', '-q', 'mainline');
      fs.writeFileSync(path.join(root, 'new.txt'), 'a\nOURS\nc\n');
      git(root, 'add', 'new.txt');
      git(root, 'commit', '-q', '-m', 'o');
      try {
        git(root, 'merge', 'theirs');
      } catch {
        /* expected */
      }

      const { service, staged } = makeService(root);
      const repo: IRepository = {
        rootUri: vscode.Uri.file(root),
        state: 'merging',
        remotes: [],
        submodules: [],
      } as unknown as IRepository;

      const result = await service.acceptNonConflictingChanges(repo, 'new.txt');
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.fullyResolved, false, 'add/add stays conflicted');
      assert.ok((result.remainingHunks ?? 0) >= 1, 'must report at least one remaining hunk');
      assert.ok(!staged.includes('new.txt'), 'must not stage while a conflict remains');
      service.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores a marker-laden synthetic stage-1 base (add/add injected by the merge editor)', async () => {
    const { ensureSyntheticMergeBase } = await import('../../../src/conflicts/syntheticMergeBase');
    const { createGitCli } = await import('../../../src/git-core/gitCli');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-anc-synthbase-'));
    try {
      git(root, 'init', '-q', '-b', 'mainline');
      git(root, 'config', 'user.email', 'test@example.com');
      git(root, 'config', 'user.name', 'Test');
      git(root, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
      git(root, 'add', 'seed.txt');
      git(root, 'commit', '-q', '-m', 'seed');
      git(root, 'checkout', '-q', '-b', 'theirs');
      fs.writeFileSync(path.join(root, 'new.txt'), 'a\nTHEIRS\nc\n');
      git(root, 'add', 'new.txt');
      git(root, 'commit', '-q', '-m', 't');
      git(root, 'checkout', '-q', 'mainline');
      fs.writeFileSync(path.join(root, 'new.txt'), 'a\nOURS\nc\n');
      git(root, 'add', 'new.txt');
      git(root, 'commit', '-q', '-m', 'o');
      try {
        git(root, 'merge', 'theirs');
      } catch {
        /* expected add/add */
      }

      // Simulate the merge editor having injected a synthetic (marker-laden)
      // stage-1 base, then run Apply Non-Conflicting.
      await ensureSyntheticMergeBase(createGitCli(), root, 'new.txt');
      assert.match(git(root, 'show', ':1:new.txt'), /<{7}/, 'precondition: stage-1 has markers');

      const { service } = makeService(root);
      const repo: IRepository = {
        rootUri: vscode.Uri.file(root),
        state: 'merging',
        remotes: [],
        submodules: [],
      } as unknown as IRepository;

      const result = await service.acceptNonConflictingChanges(repo, 'new.txt');
      assert.strictEqual(result.success, true, result.error);

      // The written file must NOT contain nested/doubled conflict markers — the
      // marker-laden base was rejected and an empty base used instead.
      const merged = fs.readFileSync(path.join(root, 'new.txt'), 'utf8');
      const starts = (merged.match(/^<{7}/gm) || []).length;
      const ends = (merged.match(/^>{7}/gm) || []).length;
      assert.strictEqual(starts, ends, 'balanced markers, no nesting');
      assert.ok(starts <= 1, 'at most one conflict hunk, not a doubly-marked mess');
      service.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT empty a real base whose content happens to contain marker-like lines', async () => {
    // Regression: a modify/modify conflict whose genuine common ancestor has
    // lines like `<<<<<<<`/`>>>>>>>` (a doc about conflicts, ASCII art) must keep
    // that real base — emptying it would spuriously re-conflict one-sided hunks.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-anc-markerbase-'));
    try {
      git(root, 'init', '-q', '-b', 'mainline');
      git(root, 'config', 'user.email', 'test@example.com');
      git(root, 'config', 'user.name', 'Test');
      git(root, 'config', 'commit.gpgsign', 'false');

      // Base file legitimately contains conflict-marker-like CONTENT lines.
      const base = ['TOP', 'mid', '<<<<<<< literal', 'keep', '>>>>>>> literal', 'end', ''].join(
        '\n'
      );
      fs.writeFileSync(path.join(root, 'f.txt'), base);
      git(root, 'add', 'f.txt');
      git(root, 'commit', '-q', '-m', 'base');

      git(root, 'checkout', '-q', '-b', 'theirs');
      // theirs changes only `mid` (the true conflict); leaves TOP alone.
      fs.writeFileSync(
        path.join(root, 'f.txt'),
        ['TOP', 'mid-THEIRS', '<<<<<<< literal', 'keep', '>>>>>>> literal', 'end', ''].join('\n')
      );
      git(root, 'commit', '-q', '-am', 'theirs');

      git(root, 'checkout', '-q', 'mainline');
      // ours changes TOP (one-sided) AND mid (the true conflict).
      fs.writeFileSync(
        path.join(root, 'f.txt'),
        ['TOP-OURS', 'mid-OURS', '<<<<<<< literal', 'keep', '>>>>>>> literal', 'end', ''].join('\n')
      );
      git(root, 'commit', '-q', '-am', 'ours');

      try {
        git(root, 'merge', 'theirs');
      } catch {
        /* expected */
      }

      const { service } = makeService(root);
      const repo: IRepository = {
        rootUri: vscode.Uri.file(root),
        state: 'merging',
        remotes: [],
        submodules: [],
      } as unknown as IRepository;

      const result = await service.acceptNonConflictingChanges(repo, 'f.txt');
      assert.strictEqual(result.success, true, result.error);
      // With the REAL base the one-sided TOP change auto-applies and exactly one
      // true conflict (mid) remains. Emptying the base would re-conflict TOP too,
      // giving remainingHunks === 2.
      assert.strictEqual(result.remainingHunks, 1, 'one-sided TOP must apply; only mid conflicts');
      const merged = fs.readFileSync(path.join(root, 'f.txt'), 'utf8');
      assert.ok(merged.includes('TOP-OURS'), 'one-sided TOP change applied (base not emptied)');
      assert.ok(
        merged.includes('mid-OURS') && merged.includes('mid-THEIRS'),
        'true mid conflict preserved'
      );
      service.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports fullyResolved + remainingHunks 0 and stages when only one-sided changes exist', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-anc-clean-'));
    try {
      git(root, 'init', '-q', '-b', 'mainline');
      git(root, 'config', 'user.email', 'test@example.com');
      git(root, 'config', 'user.name', 'Test');
      git(root, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(root, 'f.txt'), 'top\nb\nc\nd\nbottom\n');
      git(root, 'add', 'f.txt');
      git(root, 'commit', '-q', '-m', 'base');
      git(root, 'checkout', '-q', '-b', 'theirs');
      fs.writeFileSync(path.join(root, 'f.txt'), 'top\nb\nc\nd\nbottom-THEIRS\n');
      git(root, 'commit', '-q', '-am', 't');
      git(root, 'checkout', '-q', 'mainline');
      fs.writeFileSync(path.join(root, 'f.txt'), 'top-OURS\nb\nc\nd\nbottom\n');
      git(root, 'commit', '-q', '-am', 'o');
      try {
        git(root, 'merge', 'theirs');
      } catch {
        /* expected — but only one-sided hunks, fully auto-mergeable */
      }

      const { service, staged } = makeService(root);
      const repo: IRepository = {
        rootUri: vscode.Uri.file(root),
        state: 'merging',
        remotes: [],
        submodules: [],
      } as unknown as IRepository;

      const result = await service.acceptNonConflictingChanges(repo, 'f.txt');
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.fullyResolved, true, 'no true conflict → fully resolved');
      assert.strictEqual(result.remainingHunks, 0);
      assert.ok(staged.includes('f.txt'), 'fully merged file must be staged');
      service.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mergeNonConflictingText() — git merge-file three-way', () => {
  const cli = createGitCli();

  it('auto-merges non-overlapping changes with no conflict', async () => {
    const base = ['top', 'b', 'c', 'd', 'bottom', ''].join('\n');
    const ours = ['top-OURS', 'b', 'c', 'd', 'bottom', ''].join('\n');
    const theirs = ['top', 'b', 'c', 'd', 'bottom-THEIRS', ''].join('\n');

    const r = await mergeNonConflictingText(cli, base, ours, theirs);
    assert.strictEqual(r.hasConflicts, false);
    assert.strictEqual(r.conflictCount, 0, 'clean merge reports zero conflict hunks');
    assert.ok(r.content.includes('top-OURS') && r.content.includes('bottom-THEIRS'));
    assert.ok(!r.content.includes('<<<<<<<'));
  });

  it('keeps conflict markers when both sides change the same region', async () => {
    const base = ['top', 'b', 'middle', 'd', 'bottom', ''].join('\n');
    const ours = ['top', 'b', 'middle-OURS', 'd', 'bottom', ''].join('\n');
    const theirs = ['top', 'b', 'middle-THEIRS', 'd', 'bottom', ''].join('\n');

    const r = await mergeNonConflictingText(cli, base, ours, theirs);
    assert.strictEqual(r.hasConflicts, true);
    assert.strictEqual(r.conflictCount, 1, 'exact conflict-hunk count from git merge-file');
    assert.ok(r.content.includes('<<<<<<<'));
    assert.ok(r.content.includes('middle-OURS') && r.content.includes('middle-THEIRS'));
  });

  it('counts two well-separated conflict regions as conflictCount 2', async () => {
    // Enough unchanged context between the two changes that git keeps them as
    // two distinct hunks (close-together changes collapse into one).
    const mid = ['1', '2', '3', '4', '5', '6', '7', '8'];
    const base = ['a1', ...mid, 'c1', ''].join('\n');
    const ours = ['a1-O', ...mid, 'c1-O', ''].join('\n');
    const theirs = ['a1-T', ...mid, 'c1-T', ''].join('\n');

    const r = await mergeNonConflictingText(cli, base, ours, theirs);
    assert.strictEqual(r.hasConflicts, true);
    assert.strictEqual(r.conflictCount, 2, 'two disjoint conflicts → exit code 2');
  });
});

describe('acceptNonConflictingChanges() — modify/delete routing (mock)', () => {
  function makeMockService(statusRow: IFileStatus): {
    service: ConflictResolutionService;
    calls: string[][];
    staged: string[];
  } {
    const calls: string[][] = [];
    const staged: string[] = [];
    const mockGitCli = {
      exec: (args: string[]): Promise<IGitCommandResult> => {
        calls.push(args);
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      },
    };
    const gitService = {
      gitCli: mockGitCli,
      getStatus: (): Promise<IFileStatus[]> => Promise.resolve([statusRow]),
      stage: (_r: IRepository, p: string[]): Promise<void> => {
        staged.push(...p);
        return Promise.resolve();
      },
      onDidChangeRepository: new vscode.EventEmitter<IRepository>().event,
    } as unknown as IGitService;
    return { service: new ConflictResolutionService(gitService), calls, staged };
  }

  const repo: IRepository = {
    rootUri: vscode.Uri.file('/mock/repo'),
    state: 'merging',
    remotes: [],
    submodules: [],
  } as unknown as IRepository;

  it('skips a modify/delete conflict (ours-deleted, DU) without merging or staging', async () => {
    const { service, calls, staged } = makeMockService({
      path: 'gone.txt',
      indexStatus: 'D',
      workTreeStatus: 'U',
    } as IFileStatus);

    const result = await service.acceptNonConflictingChanges(repo, 'gone.txt');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.fullyResolved, false, 'delete/modify is a whole-file conflict');
    assert.ok(!calls.some((a) => a[0] === 'show' || a[0] === 'merge-file'));
    assert.ok(!staged.includes('gone.txt'));
    service.dispose();
  });

  it('skips a modify/delete conflict (theirs-deleted, UD)', async () => {
    const { service, calls, staged } = makeMockService({
      path: 'gone.txt',
      indexStatus: 'U',
      workTreeStatus: 'D',
    } as IFileStatus);

    const result = await service.acceptNonConflictingChanges(repo, 'gone.txt');
    assert.strictEqual(result.success, true);
    assert.ok(!calls.some((a) => a[0] === 'show' || a[0] === 'merge-file'));
    assert.ok(!staged.includes('gone.txt'));
    service.dispose();
  });
});

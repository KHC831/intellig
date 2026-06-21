/**
 * Unit tests for the `resolveRepo` / `selectRepo` helper.
 *
 * `selectRepo` is the pure, dependency-injected core — these tests exercise
 * it directly with hand-rolled deps so we can simulate every branch of the
 * resolution chain without a VS Code host.
 *
 * Coverage:
 *   - 0 repos → undefined + error toast (unless silent)
 *   - 1 repo → returned directly, no prompt
 *   - hintRepo set and open → returned without prompt
 *   - hintRepo set but closed (not in `repositories`) → falls through
 *   - hintRepoPath matches a repo root → returned, deepest-match wins
 *   - config.defaultRepo basename match → returned without prompt
 *   - config.defaultRepo path match → returned without prompt
 *   - config.defaultRepo no match → falls through
 *   - preferActive with editor in repo A → returns A without prompt
 *   - preferActive with no active editor / outside any repo → falls through
 *   - multi-repo no hint → QuickPick shown with every repo
 *   - QuickPick cancel → undefined, no error toast
 *   - findRepoContainingPath / basenameOf / normalizePath behaviour
 */

/*
 * `showQuickPick` stubs synthesise a function whose contract is
 * `ISelectRepoDeps.showQuickPick: (...) => Thenable<T | undefined>` —
 * returning a Promise requires the `async` marker; bodies are synchronous
 * here.
 */

import '../../setup';
import * as assert from 'assert';
import { Uri } from '../../mocks/vscode';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import {
  basenameOf,
  findRepoContainingPath,
  normalizePath,
  selectRepo,
  type IRepoPickItem,
  type ISelectRepoDeps,
} from '../../../src/utils/resolveRepo';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mkRepo(fsPath: string): IRepository {
  return {
    rootUri: Uri.file(fsPath),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

interface Harness {
  errors: string[];
  pickRequested: IRepoPickItem[][];
  deps: ISelectRepoDeps;
}

function mkDeps(input: {
  repositories: IRepository[];
  defaultRepo?: string;
  activeEditorFsPath?: string;
  /** If provided, the QuickPick auto-resolves to this repo; if 'cancel', returns undefined. */
  pickChoice?: IRepository | 'cancel';
}): Harness {
  const errors: string[] = [];
  const pickRequested: IRepoPickItem[][] = [];
  return {
    errors,
    pickRequested,
    deps: {
      repositories: input.repositories,
      defaultRepo: input.defaultRepo ?? '',
      activeEditorFsPath: input.activeEditorFsPath,
      showQuickPick: async (items: IRepoPickItem[]): Promise<IRepoPickItem | undefined> => {
        pickRequested.push(items);
        if (input.pickChoice === 'cancel' || input.pickChoice === undefined) {
          return undefined;
        }
        const match = items.find((i) => i.repo === input.pickChoice);
        return match;
      },
      showErrorMessage: (m) => errors.push(m),
    },
  };
}

// ─── 0 repos ──────────────────────────────────────────────────────────────────

describe('resolveRepo — 0 repos', () => {
  it('returns undefined and shows an error toast', async () => {
    const h = mkDeps({ repositories: [] });
    const result = await selectRepo(h.deps);
    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(h.errors, ['No Git repository found']);
    assert.strictEqual(h.pickRequested.length, 0);
  });

  it('respects the `silent` flag and skips the error toast', async () => {
    const h = mkDeps({ repositories: [] });
    const result = await selectRepo(h.deps, { silent: true });
    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(h.errors, []);
  });
});

// ─── 1 repo ───────────────────────────────────────────────────────────────────

describe('resolveRepo — 1 repo', () => {
  it('returns the sole repo without prompting', async () => {
    const repo = mkRepo('/workspace/a');
    const h = mkDeps({ repositories: [repo] });
    const result = await selectRepo(h.deps);
    assert.strictEqual(result, repo);
    assert.strictEqual(h.pickRequested.length, 0);
    assert.strictEqual(h.errors.length, 0);
  });
});

// ─── hintRepo ─────────────────────────────────────────────────────────────────

describe('resolveRepo — hintRepo', () => {
  it('returns the hinted repo when it is still open', async () => {
    const a = mkRepo('/workspace/a');
    const b = mkRepo('/workspace/b');
    const h = mkDeps({ repositories: [a, b] });
    const result = await selectRepo(h.deps, { hintRepo: b });
    assert.strictEqual(result, b);
    assert.strictEqual(h.pickRequested.length, 0);
  });

  it('falls through to the next step when the hinted repo is no longer open', async () => {
    const a = mkRepo('/workspace/a');
    const b = mkRepo('/workspace/b');
    const closed = mkRepo('/workspace/closed');
    // closed is not included in `repositories`.
    const h = mkDeps({
      repositories: [a, b],
      pickChoice: b,
    });
    const result = await selectRepo(h.deps, { hintRepo: closed });
    assert.strictEqual(result, b);
    // QuickPick was invoked because the hint was stale and nothing else
    // narrowed the choice.
    assert.strictEqual(h.pickRequested.length, 1);
  });
});

// ─── hintRepoPath ─────────────────────────────────────────────────────────────

describe('resolveRepo — hintRepoPath', () => {
  it('returns the repo whose root is an ancestor of the path', async () => {
    const a = mkRepo('/workspace/a');
    const b = mkRepo('/workspace/b');
    const h = mkDeps({ repositories: [a, b] });
    const result = await selectRepo(h.deps, {
      hintRepoPath: '/workspace/b/src/foo.ts',
    });
    assert.strictEqual(result, b);
  });

  it('falls through when no repo root is an ancestor of the path', async () => {
    const a = mkRepo('/workspace/a');
    const b = mkRepo('/workspace/b');
    const h = mkDeps({
      repositories: [a, b],
      pickChoice: a,
    });
    const result = await selectRepo(h.deps, {
      hintRepoPath: '/other/root/file.ts',
    });
    assert.strictEqual(result, a);
    assert.strictEqual(h.pickRequested.length, 1);
  });

  it('picks the DEEPEST matching repo when roots are nested', async () => {
    const outer = mkRepo('/workspace');
    const inner = mkRepo('/workspace/nested');
    const h = mkDeps({ repositories: [outer, inner] });
    const result = await selectRepo(h.deps, {
      hintRepoPath: '/workspace/nested/src/foo.ts',
    });
    assert.strictEqual(result, inner, 'deepest-ancestor match should win');
  });
});

// ─── defaultRepo config ───────────────────────────────────────────────────────

describe('resolveRepo — defaultRepo config', () => {
  it('returns the repo whose absolute path matches the config value', async () => {
    const a = mkRepo('/workspace/a');
    const b = mkRepo('/workspace/b');
    const h = mkDeps({
      repositories: [a, b],
      defaultRepo: '/workspace/b',
    });
    const result = await selectRepo(h.deps);
    assert.strictEqual(result, b);
    assert.strictEqual(h.pickRequested.length, 0);
  });

  it('returns the repo whose basename matches the config value', async () => {
    const a = mkRepo('/workspace/alpha');
    const b = mkRepo('/workspace/beta');
    const h = mkDeps({
      repositories: [a, b],
      defaultRepo: 'beta',
    });
    const result = await selectRepo(h.deps);
    assert.strictEqual(result, b);
  });

  it('falls through when the config value matches nothing', async () => {
    const a = mkRepo('/workspace/a');
    const b = mkRepo('/workspace/b');
    const h = mkDeps({
      repositories: [a, b],
      defaultRepo: 'nope',
      pickChoice: b,
    });
    const result = await selectRepo(h.deps);
    assert.strictEqual(result, b, 'should have reached the picker');
    assert.strictEqual(h.pickRequested.length, 1);
  });

  it('ignores whitespace-only config values', async () => {
    const a = mkRepo('/workspace/a');
    const h = mkDeps({
      repositories: [a],
      defaultRepo: '   ',
    });
    const result = await selectRepo(h.deps);
    assert.strictEqual(result, a);
  });
});

// ─── preferActive ─────────────────────────────────────────────────────────────

describe('resolveRepo — preferActive', () => {
  it('returns the repo owning the active editor when preferActive is true', async () => {
    const a = mkRepo('/workspace/a');
    const b = mkRepo('/workspace/b');
    const h = mkDeps({
      repositories: [a, b],
      activeEditorFsPath: '/workspace/a/src/foo.ts',
    });
    const result = await selectRepo(h.deps, { preferActive: true });
    assert.strictEqual(result, a);
    assert.strictEqual(h.pickRequested.length, 0);
  });

  it('does NOT use the active editor when preferActive is false', async () => {
    const a = mkRepo('/workspace/a');
    const b = mkRepo('/workspace/b');
    const h = mkDeps({
      repositories: [a, b],
      activeEditorFsPath: '/workspace/a/src/foo.ts',
      pickChoice: b,
    });
    const result = await selectRepo(h.deps);
    assert.strictEqual(result, b, 'without preferActive, picker should run');
    assert.strictEqual(h.pickRequested.length, 1);
  });

  it('falls through when no active editor is set', async () => {
    const a = mkRepo('/workspace/a');
    const b = mkRepo('/workspace/b');
    const h = mkDeps({
      repositories: [a, b],
      activeEditorFsPath: undefined,
      pickChoice: a,
    });
    const result = await selectRepo(h.deps, { preferActive: true });
    assert.strictEqual(result, a);
    assert.strictEqual(h.pickRequested.length, 1);
  });

  it('falls through when the active file is outside every open repo', async () => {
    const a = mkRepo('/workspace/a');
    const b = mkRepo('/workspace/b');
    const h = mkDeps({
      repositories: [a, b],
      activeEditorFsPath: '/tmp/scratch.ts',
      pickChoice: a,
    });
    const result = await selectRepo(h.deps, { preferActive: true });
    assert.strictEqual(result, a);
    assert.strictEqual(h.pickRequested.length, 1);
  });
});

// ─── Multi-repo picker ────────────────────────────────────────────────────────

describe('resolveRepo — multi-repo picker', () => {
  it('shows a QuickPick with every open repo when no hint narrows the choice', async () => {
    const a = mkRepo('/workspace/a');
    const b = mkRepo('/workspace/b');
    const c = mkRepo('/workspace/c');
    const h = mkDeps({
      repositories: [a, b, c],
      pickChoice: c,
    });
    const result = await selectRepo(h.deps);
    assert.strictEqual(result, c);
    assert.strictEqual(h.pickRequested.length, 1);
    const items = h.pickRequested[0];
    assert.strictEqual(items.length, 3);
    assert.deepStrictEqual(
      items.map((i) => i.repo),
      [a, b, c]
    );
    assert.deepStrictEqual(items.map((i) => i.label).sort(), ['a', 'b', 'c']);
  });

  it('returns undefined without an error toast when the user cancels', async () => {
    const a = mkRepo('/workspace/a');
    const b = mkRepo('/workspace/b');
    const h = mkDeps({
      repositories: [a, b],
      pickChoice: 'cancel',
    });
    const result = await selectRepo(h.deps);
    assert.strictEqual(result, undefined);
    assert.strictEqual(h.pickRequested.length, 1);
    assert.deepStrictEqual(h.errors, [], 'cancelling is not an error');
  });

  it('honors a custom picker title/placeholder when provided', async () => {
    const a = mkRepo('/workspace/a');
    const b = mkRepo('/workspace/b');
    let receivedTitle: string | undefined;
    let receivedPlaceholder: string | undefined;
    const deps: ISelectRepoDeps = {
      repositories: [a, b],
      defaultRepo: '',
      activeEditorFsPath: undefined,
      showQuickPick: async (_items, title, placeholder) => {
        receivedTitle = title;
        receivedPlaceholder = placeholder;
        return undefined;
      },
      showErrorMessage: () => {},
    };
    await selectRepo(deps, {
      pickerTitle: 'Commit — Choose Repository',
      pickerPlaceholder: 'Select a repository to commit to',
    });
    assert.strictEqual(receivedTitle, 'Commit — Choose Repository');
    assert.strictEqual(receivedPlaceholder, 'Select a repository to commit to');
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

describe('resolveRepo — helpers', () => {
  it('normalizePath strips trailing slashes and unifies separators', () => {
    assert.strictEqual(normalizePath('/a/b/'), '/a/b');
    assert.strictEqual(normalizePath('C:\\foo\\bar\\'), 'C:/foo/bar');
    assert.strictEqual(normalizePath(''), '');
    assert.strictEqual(normalizePath('/'), '/');
  });

  it('basenameOf returns the last segment', () => {
    assert.strictEqual(basenameOf('/workspace/a'), 'a');
    assert.strictEqual(basenameOf('/workspace/a/'), 'a');
    assert.strictEqual(basenameOf('C:\\foo\\bar'), 'bar');
    assert.strictEqual(basenameOf(''), '');
  });

  it('findRepoContainingPath returns undefined when nothing matches', () => {
    const a = mkRepo('/workspace/a');
    const match = findRepoContainingPath([a], '/elsewhere/file.ts');
    assert.strictEqual(match, undefined);
  });

  it('findRepoContainingPath matches exact-root paths', () => {
    const a = mkRepo('/workspace/a');
    const match = findRepoContainingPath([a], '/workspace/a');
    assert.strictEqual(match, a);
  });
});

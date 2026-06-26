/**
 * Unit coverage for resolveBlameRepo — the blame providers' repo resolver.
 *
 * Uses REAL temp directories so `canonicalizeFsPath` (fs.realpathSync.native)
 * exercises the platform's actual path canonicalization — including the macOS
 * `/var` → `/private/var` symlink that broke the first version of this resolver
 * (a string/normalize compare missed it; a realpath compare matches). Runs
 * unchanged on Linux/macOS/Windows because every path is built with the OS
 * separator via the real filesystem.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveBlameRepo } from '../../../src/blame/resolveBlameRepo';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

function repoAt(rootPath: string): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: 'idle',
    head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

function mockGitService(opts: {
  repositories: IRepository[];
  getRepositoryResult?: IRepository | undefined;
}): { service: IGitService; getRepositoryCalls: number } {
  let getRepositoryCalls = 0;
  const service = {
    getRepositories: () => opts.repositories,
    getRepository: (_uri: unknown) => {
      getRepositoryCalls++;
      return Promise.resolve(opts.getRepositoryResult);
    },
  } as unknown as IGitService;
  return {
    service,
    get getRepositoryCalls() {
      return getRepositoryCalls;
    },
  } as { service: IGitService; getRepositoryCalls: number };
}

describe('resolveBlameRepo', () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-resolveblame-'));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('matches an open repo by canonicalized ancestor path (handles symlinked tmp roots)', async () => {
    const root = path.join(base, 'repo');
    fs.mkdirSync(root);
    const file = path.join(root, 'src', 'a.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');

    const mock = mockGitService({ repositories: [repoAt(root)], getRepositoryResult: undefined });
    const resolved = await resolveBlameRepo(mock.service, Uri.file(file) as never);

    assert.ok(resolved, 'must resolve the open repo for a file under its root');
    assert.strictEqual(resolved.rootUri.fsPath, Uri.file(root).fsPath);
    assert.strictEqual(mock.getRepositoryCalls, 0, 'must not spawn a fresh getRepository');
  });

  it('picks the DEEPEST repo when nested repos both contain the file', async () => {
    const outer = path.join(base, 'outer');
    const inner = path.join(outer, 'inner');
    const file = path.join(inner, 'x.ts');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(file, '');

    const mock = mockGitService({
      repositories: [repoAt(outer), repoAt(inner)],
      getRepositoryResult: undefined,
    });
    const resolved = await resolveBlameRepo(mock.service, Uri.file(file) as never);

    assert.strictEqual(
      resolved!.rootUri.fsPath,
      Uri.file(inner).fsPath,
      'the deepest ancestor repo must win'
    );
  });

  it('does NOT resolve the single open repo for a file outside it; defers to getRepository', async () => {
    const root = path.join(base, 'repo');
    const outside = path.join(base, 'elsewhere', 'y.ts');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, '');

    // One open repo, but the target is not inside it. Blaming repos[0] would run
    // git blame with a `../`-escaping pathspec against the wrong repo. The file
    // genuinely outside the only open repo must not resolve to it.
    const mock = mockGitService({ repositories: [repoAt(root)], getRepositoryResult: undefined });
    const resolved = await resolveBlameRepo(mock.service, Uri.file(outside) as never);

    assert.strictEqual(resolved, undefined, 'out-of-repo file must not resolve to the lone repo');
    assert.strictEqual(
      mock.getRepositoryCalls,
      1,
      'must defer the out-of-repo case to a fresh getRepository'
    );
  });

  it('still resolves the single open repo for a file INSIDE it (ancestor match)', async () => {
    const root = path.join(base, 'repo');
    const file = path.join(root, 'pkg', 'a.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');

    const mock = mockGitService({ repositories: [repoAt(root)], getRepositoryResult: undefined });
    const resolved = await resolveBlameRepo(mock.service, Uri.file(file) as never);

    assert.strictEqual(resolved!.rootUri.fsPath, Uri.file(root).fsPath);
    assert.strictEqual(mock.getRepositoryCalls, 0, 'inside the lone repo → no fresh getRepository');
  });

  it('falls back to fresh getRepository when multiple repos and none match', async () => {
    const a = path.join(base, 'a');
    const b = path.join(base, 'b');
    const outside = path.join(base, 'c', 'z.ts');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, '');

    const fresh = repoAt(a);
    const mock = mockGitService({
      repositories: [repoAt(a), repoAt(b)],
      getRepositoryResult: fresh,
    });
    const resolved = await resolveBlameRepo(mock.service, Uri.file(outside) as never);

    assert.strictEqual(
      mock.getRepositoryCalls,
      1,
      'must consult fresh getRepository as last resort'
    );
    assert.strictEqual(resolved, fresh);
  });

  it('returns undefined when nothing resolves', async () => {
    const mock = mockGitService({ repositories: [], getRepositoryResult: undefined });
    const resolved = await resolveBlameRepo(
      mock.service,
      Uri.file(path.join(base, 'none.ts')) as never
    );
    assert.strictEqual(resolved, undefined);
  });
});

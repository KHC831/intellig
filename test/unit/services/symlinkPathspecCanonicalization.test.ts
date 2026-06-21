/**
 * Regression coverage for the repo-relative git-pathspec derivation across the
 * blame providers, the changed-line HEAD read, and conflict staging.
 *
 * Each of these used a raw `path.relative(repo.rootUri.fsPath, <uri>.fsPath)`.
 * `gitService.getRepository` reports a realpath-CANONICALIZED root (macOS
 * `/var` → `/private/var`, from `git rev-parse --show-toplevel`), while the
 * editor/working-tree URI keeps the SYMLINK. A raw `path.relative` between the
 * two divergent resolution states yields an escaping `../…` pathspec, so git
 * blames/reads/stages a bogus path (the conflict case silently fails to stage
 * the resolved file). The fix routes every site through `repoRelativePath`,
 * which canonicalizes both ends first.
 *
 * The scenarios run against a REAL on-disk symlink (mkdtemp + fs.symlinkSync)
 * so `fs.realpathSync.native` is genuinely exercised, not mocked.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { InlineBlameProvider } from '../../../src/blame/InlineBlameProvider';
import { GutterBlameProvider } from '../../../src/blame/GutterBlameProvider';
import { fetchHeadContent } from '../../../src/linestatus/lineStatusHead';
import { MergeView } from '../../../src/conflicts/MergeView';
import { IBlameService, IBlameInfo } from '../../../src/blame/interfaces/IBlameService';
import { IGitService, IRepository, IBlameLine } from '../../../src/git-core/interfaces/IGitService';

interface SymlinkedRepo {
  /** Realpath repo root — what `git rev-parse --show-toplevel` reports. */
  canonicalRoot: string;
  /** Absolute path under the symlink — what an editor / working-tree URI keeps. */
  symlinkedFile: string;
  /** Bare repo-relative filename the canonical derivation must produce. */
  fileName: string;
  cleanup: () => void;
}

/**
 * Build `link-repo` → `real-repo` siblings with a file inside. The canonical
 * root (realpath of `real-repo`) and the symlinked file path diverge until
 * canonicalization, so a raw `path.relative` between them escapes with `../`.
 */
function makeSymlinkedRepo(fileName = 'file.ts'): SymlinkedRepo {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pathspec-symlink-'));
  const realRepo = path.join(tmpBase, 'real-repo');
  fs.mkdirSync(realRepo);
  fs.writeFileSync(path.join(realRepo, fileName), 'const x = 1;\n');
  const linkRepo = path.join(tmpBase, 'link-repo');
  fs.symlinkSync(realRepo, linkRepo, 'dir');
  return {
    canonicalRoot: fs.realpathSync.native(realRepo),
    symlinkedFile: path.join(linkRepo, fileName),
    fileName,
    cleanup: (): void => {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    },
  };
}

function makeRepo(canonicalRoot: string): IRepository {
  return {
    rootUri: vscode.Uri.file(canonicalRoot),
    state: 'idle',
    head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

/** Blame service that records the `path` argument `getBlame` receives. */
function makeBlameCapture(): { service: IBlameService; capture: { path?: string } } {
  const capture: { path?: string } = {};
  const onDidChangeBlame = new vscode.EventEmitter<{ path: string; blame: IBlameInfo }>();
  const service = {
    getBlame: (_repo: IRepository, p: string): Promise<IBlameInfo> => {
      capture.path = p;
      return Promise.resolve({ path: p, lines: [] });
    },
    getBlameForLine: (_repo: IRepository, p: string, line: number): Promise<IBlameLine> => {
      capture.path = p;
      return Promise.resolve({
        line,
        commit: '0000000000000000000000000000000000000000',
        author: '',
        authorEmail: '',
        date: new Date(0),
        message: '',
      });
    },
    getPreviousRevisionBlame: (_repo: IRepository, p: string): Promise<IBlameInfo> =>
      Promise.resolve({ path: p, lines: [] }),
    onDidChangeBlame: onDidChangeBlame.event,
    dispose: (): void => {
      onDidChangeBlame.dispose();
    },
  };
  return { service: service as unknown as IBlameService, capture };
}

/** Git service whose single repo has the canonical root. */
function makeGitWithRepo(canonicalRoot: string): IGitService {
  const repo = makeRepo(canonicalRoot);
  const onDidChangeRepository = new vscode.EventEmitter<IRepository>();
  return {
    getRepository: (): Promise<IRepository> => Promise.resolve(repo),
    getRepositories: (): IRepository[] => [repo],
    onDidChangeRepository: onDidChangeRepository.event,
  } as unknown as IGitService;
}

function fakeEditor(fileFsPath: string): vscode.TextEditor {
  return {
    document: { uri: vscode.Uri.file(fileFsPath) },
    selection: { active: { line: 0 } },
  } as unknown as vscode.TextEditor;
}

describe('repo-relative pathspec canonicalization on a symlinked checkout', () => {
  let repo: SymlinkedRepo;

  beforeEach(() => {
    repo = makeSymlinkedRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('InlineBlameProvider hands blame the canonical repo-relative path, not an escaping ../', async () => {
    const { service, capture } = makeBlameCapture();
    const provider = new InlineBlameProvider(service, makeGitWithRepo(repo.canonicalRoot));
    try {
      await (
        provider as unknown as {
          getBlameForLine: (editor: vscode.TextEditor, line: number) => Promise<unknown>;
        }
      ).getBlameForLine(fakeEditor(repo.symlinkedFile), 0);
    } finally {
      provider.dispose();
    }
    assert.strictEqual(
      capture.path,
      repo.fileName,
      `inline blame must receive '${repo.fileName}', got: ${String(capture.path)}`
    );
  });

  it('GutterBlameProvider hands blame the canonical repo-relative path, not an escaping ../', async () => {
    const { service, capture } = makeBlameCapture();
    const provider = new GutterBlameProvider(service, makeGitWithRepo(repo.canonicalRoot));
    try {
      await (
        provider as unknown as {
          getBlameForFile: (editor: vscode.TextEditor) => Promise<unknown>;
        }
      ).getBlameForFile(fakeEditor(repo.symlinkedFile));
    } finally {
      provider.dispose();
    }
    assert.strictEqual(
      capture.path,
      repo.fileName,
      `gutter blame must receive '${repo.fileName}', got: ${String(capture.path)}`
    );
  });

  it('fetchHeadContent reads HEAD at the canonical repo-relative path, not an escaping ../', async () => {
    const capture: { path?: string } = {};
    const git = {
      getRepository: (): Promise<IRepository> => Promise.resolve(makeRepo(repo.canonicalRoot)),
      getFileAtRevision: (_repo: IRepository, p: string): Promise<string> => {
        capture.path = p;
        return Promise.resolve('HEAD content');
      },
    } as unknown as IGitService;

    await fetchHeadContent(git, vscode.Uri.file(repo.symlinkedFile));

    assert.strictEqual(
      capture.path,
      repo.fileName,
      `HEAD read must use '${repo.fileName}', got: ${String(capture.path)}`
    );
  });

  it('MergeView.markResolved stages the canonical repo-relative path, not an escaping ../', async () => {
    const conflict = makeSymlinkedRepo('conflict.ts');
    const staged: string[] = [];
    const mergeRepo = makeRepo(conflict.canonicalRoot);
    const git = {
      getRepository: (): Promise<IRepository> => Promise.resolve(mergeRepo),
      getRepositories: (): IRepository[] => [mergeRepo],
      stage: (_repo: IRepository, paths: string[]): Promise<void> => {
        staged.push(...paths);
        return Promise.resolve();
      },
    } as unknown as IGitService;

    const mergeView = new MergeView(vscode.Uri.file('/ext'), git);
    try {
      // `show()` records the working-tree file (a symlinked absolute path)
      // against the canonical-root repo; `markResolved()` stages what it
      // recorded. An escaping `../` pathspec → `git add` silently no-ops.
      await mergeView.show(conflict.symlinkedFile);
      await mergeView.markResolved();
    } finally {
      mergeView.dispose();
      conflict.cleanup();
    }

    assert.deepStrictEqual(
      staged,
      [conflict.fileName],
      `markResolved must stage '${conflict.fileName}', got: ${JSON.stringify(staged)}`
    );
  });
});

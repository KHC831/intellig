/**
 * Before-commit check gathering + presentation.
 *
 * {@link CheckinHandlers} holds the pure check logic; this module is the
 * thin I/O + UI shell around it:
 *
 *   - {@link gatherCheckinContext} reads the bits the cheap checks need that
 *     the frozen {@link IGitService} composite does not expose
 *     (`git config user.name`/`user.email`, detached-HEAD) via the
 *     documented `gitCli` escape hatch (ADR-001, same pattern as
 *     `ConflictResolutionService`). It maps a caller-supplied path list onto
 *     the working-tree statuses so the unresolved-merge check sees the real
 *     `conflicted` flags.
 *   - {@link runBeforeCommitChecks} gathers, runs the handler chain, and —
 *     if there are problems — shows a modal. Blocking problems (errors)
 *     require an explicit "Commit Anyway" to proceed; pure warnings still
 *     ask for confirmation but read as advisory. Returns `true` when the
 *     caller may proceed with the commit, `false` when it should abort.
 *
 * The `--no-verify` bypass is the CALLER's responsibility: when in
 * no-verify mode the caller does not invoke {@link runBeforeCommitChecks}
 * at all, mirroring how `--no-verify` skips git's own hooks.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GitCli } from '../git-core/gitCli';
import {
  FileStatus,
  IFileStatus,
  IGitService,
  IRepository,
} from '../git-core/interfaces/IGitService';
import { isConflictedStatus, parseLineAttrPaths } from '../git-core/gitParser';
import { readConfig, updateConfig } from '../config/configKeys';
import { sanitizeGitError } from '../git-core/gitError';
import {
  ICheckinContext,
  ICheckinFile,
  ICheckinProblem,
  runCheckinHandlers,
} from './CheckinHandlers';

/**
 * Narrowed view of {@link IGitService} that also exposes the `gitCli`
 * escape hatch. `GitService` implements both; tests pass a stub. Mirrors
 * `ConflictResolutionService`'s `IGitServiceWithCli`.
 *
 * @internal
 */
interface IGitServiceWithCli extends IGitService {
  gitCli: GitCli;
}

/**
 * Resolve the most relevant {@link FileStatus} for a status entry. Conflict
 * wins because the unresolved-merge check keys on `conflicted`. Conflict
 * detection delegates to the shared predicate so add/add (AA) and delete/
 * delete (DD) conflicts are caught alongside the U-marked set.
 */
function resolveFileStatus(entry: IFileStatus): FileStatus {
  if (isConflictedStatus(entry)) {
    return 'conflicted';
  }
  // The unresolved-merge check only cares about `conflicted`; everything
  // else maps to `modified` for the purposes of the cheap checks. (The
  // richer FileStatus mapping lives in the changelist/status layer.)
  if (entry.indexStatus === 'A' || entry.workTreeStatus === 'A') {
    return 'added';
  }
  if (entry.indexStatus === 'D' || entry.workTreeStatus === 'D') {
    return 'deleted';
  }
  if (entry.indexStatus === '?' && entry.workTreeStatus === '?') {
    return 'untracked';
  }
  return 'modified';
}

/**
 * Read `git config <key>` for a repo, returning `undefined` when unset.
 */
async function readGitConfig(
  gitCli: GitCli,
  repo: IRepository,
  key: string
): Promise<string | undefined> {
  try {
    const result = await gitCli.exec(['config', '--get', key], {
      cwd: repo.rootUri.fsPath,
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    const value = result.stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect whether HEAD is detached.
 *
 * `git symbolic-ref -q HEAD` exits non-zero on a detached HEAD, which is the
 * canonical detector git4idea's detached-root handler relies on. Falls back
 * to `repo.head?.name` being absent when the CLI call cannot run.
 */
async function isDetachedHead(gitCli: GitCli, repo: IRepository): Promise<boolean> {
  try {
    const result = await gitCli.exec(['symbolic-ref', '-q', 'HEAD'], {
      cwd: repo.rootUri.fsPath,
    });
    return result.exitCode !== 0;
  } catch {
    return !repo.head?.name;
  }
}

/**
 * Gather the {@link ICheckinContext} for the given committed paths.
 *
 * @param gitService - The git service (must expose the `gitCli` hatch in
 *   production; tests stub it).
 * @param repo - The repository.
 * @param committedPaths - Paths that will be part of the commit. Used to
 *   project the working-tree status onto only the relevant files so the
 *   unresolved-merge check ignores conflicts in files the user isn't
 *   committing.
 */
/** Injectable fs seam for {@link sampleFileFacts}. */
export interface IFileFactsFs {
  stat(absPath: string): Promise<{ size: number }>;
  /** Read up to {@link FACTS_CHUNK_BYTES} starting at byte `offset`. */
  readChunk(absPath: string, offset: number): Promise<Buffer>;
}

const FACTS_CHUNK_BYTES = 8192;
/**
 * The CRLF scan reads the file in chunks up to this cap; a first CRLF deeper
 * than 1 MiB into an otherwise-LF file goes undetected (bounded I/O per
 * committed file beats exhaustive certainty here).
 */
export const FACTS_SCAN_CAP_BYTES = 1024 * 1024;

/**
 * The `core.autocrlf` value "Fix and Commit" writes (reference
 * `GitCrlfUtil.RECOMMENDED_VALUE`): `true` on Windows (checkout CRLF,
 * commit LF), `input` elsewhere — `true` on macOS/Linux would rewrite
 * LF checkouts to CRLF.
 */
export function recommendedAutoCrlfValue(
  platform: NodeJS.Platform = process.platform
): 'true' | 'input' {
  return platform === 'win32' ? 'true' : 'input';
}

const realFileFactsFs: IFileFactsFs = {
  stat: (absPath) => fs.promises.stat(absPath),
  async readChunk(absPath, offset) {
    const handle = await fs.promises.open(absPath, 'r');
    try {
      const buffer = Buffer.alloc(FACTS_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, FACTS_CHUNK_BYTES, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

/**
 * Sample the on-disk facts the CRLF and large-file checks need: size and
 * whether the file contains a CRLF separator within the first
 * {@link FACTS_SCAN_CAP_BYTES}. A NUL in any scanned chunk marks the file
 * binary (CRLF is meaningless there). Deleted files and any fs failure leave
 * the fields undefined — the checks stay silent on an unknown rather than
 * guessing.
 */
export async function sampleFileFacts(
  repoRootFsPath: string,
  files: ReadonlyArray<ICheckinFile>,
  fsLike: IFileFactsFs = realFileFactsFs
): Promise<ICheckinFile[]> {
  return Promise.all(
    files.map(async (file) => {
      if (file.status === 'deleted') {
        return { ...file };
      }
      const absPath = path.join(repoRootFsPath, file.path);
      let sizeBytes: number | undefined;
      let hasCrlf: boolean | undefined;
      try {
        sizeBytes = (await fsLike.stat(absPath)).size;
        hasCrlf = false;
        let prevEndsWithCr = false;
        for (let offset = 0; offset < FACTS_SCAN_CAP_BYTES; offset += FACTS_CHUNK_BYTES) {
          const chunk = await fsLike.readChunk(absPath, offset);
          if (chunk.length === 0) {
            break;
          }
          if (chunk.includes(0)) {
            break; // binary — CRLF is meaningless there
          }
          if ((prevEndsWithCr && chunk[0] === 0x0a) || chunk.includes('\r\n')) {
            hasCrlf = true;
            break;
          }
          prevEndsWithCr = chunk[chunk.length - 1] === 0x0d;
          if (chunk.length < FACTS_CHUNK_BYTES) {
            break; // EOF
          }
        }
      } catch {
        // Missing/unreadable file: leave both facts undefined (checks skip).
        sizeBytes = undefined;
        hasCrlf = undefined;
      }
      return { ...file, sizeBytes, hasCrlf };
    })
  );
}

export async function gatherCheckinContext(
  gitService: IGitService,
  repo: IRepository,
  committedPaths: ReadonlyArray<string>
): Promise<ICheckinContext> {
  const gitCli = (gitService as IGitServiceWithCli).gitCli;

  let statuses: IFileStatus[] = [];
  let statusReadFailed = false;
  try {
    statuses = await gitService.getStatus(repo);
  } catch {
    // Don't silently pass the conflict check on a status-read failure — flag it
    // so runCheckinHandlers can surface a non-blocking warning.
    statuses = [];
    statusReadFailed = true;
  }
  const committedSet = new Set(committedPaths);
  const files: ICheckinFile[] = statuses
    .filter((s) => committedSet.has(s.path))
    .map((s) => ({ path: s.path, status: resolveFileStatus(s) }));

  // When the `gitCli` escape hatch is unavailable (e.g. a stubbed
  // IGitService in a test), we cannot read git config — flag the identity
  // as unresolved so the user.name check stays silent rather than firing a
  // false positive. Production GitService always exposes the hatch.
  const canReadConfig = typeof gitCli?.exec === 'function';
  if (!canReadConfig) {
    return {
      userIdentityResolved: false,
      files,
      detachedHead: !repo.head?.name,
      statusReadFailed,
    };
  }

  const [userName, userEmail, autoCrlfRaw, lfsVersion, detachedHead, sampledFiles] =
    await Promise.all([
      readGitConfig(gitCli, repo, 'user.name'),
      readGitConfig(gitCli, repo, 'user.email'),
      readGitConfig(gitCli, repo, 'core.autocrlf'),
      readGitConfig(gitCli, repo, 'lfs.repositoryformatversion'),
      isDetachedHead(gitCli, repo),
      sampleFileFacts(repo.rootUri.fsPath, files),
    ]);
  const coreAutoCrlf = autoCrlfRaw ? autoCrlfRaw.trim().toLowerCase() : undefined;

  // gitattributes trump the sampled CRLF facts: a file with a text/crlf
  // attribute either gets normalized on checkin or carries CRLFs on purpose
  // (reference GitCrlfProblemsDetector.findFilesWithoutAttrs). Only consulted
  // when the warning could actually fire; on check-attr failure the reference
  // fails gracefully by not warning at all.
  const warnAboutCrlf = readConfig('warnAboutCrlf');
  const normalizing = coreAutoCrlf === 'true' || coreAutoCrlf === 'input';
  const crlfFiles = sampledFiles.filter((f) => f.hasCrlf);
  if (warnAboutCrlf !== false && !normalizing && crlfFiles.length > 0) {
    let excluded: ReadonlySet<string>;
    try {
      const result = await gitCli.exec(
        ['check-attr', '-z', 'text', 'crlf', '--', ...crlfFiles.map((f) => f.path)],
        { cwd: repo.rootUri.fsPath }
      );
      excluded =
        result.exitCode === 0
          ? parseLineAttrPaths(result.stdout)
          : new Set(crlfFiles.map((f) => f.path));
    } catch {
      excluded = new Set(crlfFiles.map((f) => f.path));
    }
    for (const f of crlfFiles) {
      if (excluded.has(f.path)) {
        f.hasCrlf = false;
      }
    }
  }

  return {
    userName,
    userEmail,
    userIdentityResolved: true,
    files: sampledFiles,
    detachedHead,
    coreAutoCrlf,
    lfsRepo: lfsVersion !== undefined,
    statusReadFailed,
    warnAboutCrlf,
    largeFileWarningBytes: readConfig('largeFileWarningMb') * 1024 * 1024,
  };
}

/**
 * Render the modal body for a set of problems. Errors first, then warnings.
 * Exported so the snapshot test can pin the wording.
 */
export function formatCheckinProblems(problems: ReadonlyArray<ICheckinProblem>): string {
  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');
  const lines: string[] = [];
  for (const p of errors) {
    lines.push(`✖ ${p.text}`);
  }
  for (const p of warnings) {
    lines.push(`⚠ ${p.text}`);
  }
  return lines.join('\n\n');
}

/**
 * Run the before-commit checks and, if any problems surface, present a modal
 * asking the user how to proceed.
 *
 * @returns `true` when the commit may proceed (no problems, or the user
 *   chose to commit anyway); `false` when the commit should be aborted.
 */
export async function runBeforeCommitChecks(
  gitService: IGitService,
  repo: IRepository,
  committedPaths: ReadonlyArray<string>
): Promise<boolean> {
  const context = await gatherCheckinContext(gitService, repo, committedPaths);
  const result = runCheckinHandlers(context);
  if (result.problems.length === 0) {
    return true;
  }

  // The CRLF problem carries its own affordances (reference GitCrlfDialog:
  // Fix and Commit sets the platform-recommended core.autocrlf --global
  // before committing; Commit As-Is proceeds; Cancel aborts; don't-warn-again
  // persists the warnAboutCrlf setting off). Its dialog runs LAST, after the
  // general problems modal, so the config write can never land on a commit
  // the user then aborts at a blocking problem.
  const crlfProblem = result.problems.find((p) => p.handlerId === 'git.crlf');
  const remaining = result.problems.filter((p) => p.handlerId !== 'git.crlf');

  if (remaining.length > 0) {
    const hasBlocking = remaining.some((p) => p.severity === 'error');
    const detail = formatCheckinProblems(remaining);
    const proceedLabel = hasBlocking ? 'Commit Anyway' : 'Commit';
    const title = hasBlocking
      ? 'Before-commit checks found problems'
      : 'Before-commit checks found warnings';

    const choice = await vscode.window.showWarningMessage(
      title,
      { modal: true, detail },
      proceedLabel
    );
    if (choice !== proceedLabel) {
      return false;
    }
  }

  if (crlfProblem) {
    const FIX = 'Fix and Commit';
    const AS_IS = 'Commit As-Is';
    const DONT_ASK = "Commit As-Is, Don't Ask Again";
    const crlfChoice = await vscode.window.showWarningMessage(
      'Committing CRLF line separators',
      { modal: true, detail: crlfProblem.text },
      FIX,
      AS_IS,
      DONT_ASK
    );
    if (crlfChoice === undefined) {
      return false;
    }
    if (crlfChoice === FIX) {
      const gitCli = (gitService as IGitServiceWithCli).gitCli;
      try {
        await gitCli.exec(['config', '--global', 'core.autocrlf', recommendedAutoCrlfValue()], {
          cwd: repo.rootUri.fsPath,
          throwOnError: true,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        void vscode.window.showWarningMessage(
          `Could not set core.autocrlf: ${sanitizeGitError(msg)}. Committing anyway.`
        );
      }
    } else if (crlfChoice === DONT_ASK) {
      // Workspace scope: the reference keeps the warn-about-crlf opt-out
      // project-level, so silencing here must not leak into other workspaces.
      await updateConfig('warnAboutCrlf', false, vscode.ConfigurationTarget.Workspace);
    }
  }
  return true;
}

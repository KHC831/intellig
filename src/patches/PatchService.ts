/**
 * Patch Service implementation.
 *
 * Thin wrapper over `git apply` / `git am` / `git diff`. See `IPatchService`
 * for the contract and the conflict-handoff integration point.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  IPatchService,
  IApplyPatchOptions,
  IApplyPatchResult,
  IAmSessionOpResult,
  ICreatePatchOptions,
} from './interfaces/IPatchService';
import { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { IConflictedFile } from '../conflicts/interfaces/IConflictResolutionService';
import { GitCli, IGitCommandOptions, IGitCommandResult, buildGitArgs } from '../git-core/gitCli';
import { isAmSession, resolveGitDir } from '../git-core/gitDirMarkers';
import { createWorkingStateSnapshot, type IPreApplyState } from '../git-core/ops/preservedChanges';
import { runAmSessionOp } from '../git-core/ops/amSession';
import { isConflictedStatus } from '../git-core/gitParser';
import { looksLikePatchConflictText, parseAppliedPatchFiles } from '../git-core/gitProse';
import { sanitizeGitError } from '../git-core/gitError';
import { atomicWriteFile } from '../utils/atomicWrite';
import { getLogger, type Logger } from '../utils/logger';
import { validateStripLevel } from './applyPatchValidation';

// Re-exported so the established `from './PatchService'` import path keeps working.
export { validateStripLevel };

/**
 * Thrown when `createPatchFromLocalChanges` fails writing the patch
 * to a user-picked `outputPath`. The service has already surfaced a
 * sanitised toast via `vscode.window.showErrorMessage`, so callers that
 * detect this error class MUST NOT show their own "Failed to create patch"
 * toast — doing so produces a double-notification for one failure.
 *
 * Callers that want to bail without re-toasting can `if (err instanceof
 * PatchWriteFailed) return;` before their generic catch-all.
 */
export class PatchWriteFailed extends Error {
  /**
   * Marker property — kept in addition to the `instanceof` check so callers
   * in adjacent bundles (where `instanceof` might fall through a cross-
   * boundary prototype chain) can fall back to a duck-typed check.
   */
  readonly userNotified = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PatchWriteFailed';
  }
}

/**
 * Narrow `IGitService` to the surface we actually need (just `.gitCli`).
 */
interface IGitServiceWithCli extends IGitService {
  gitCli: GitCli;
}

/** git's hard-coded empty tree — the base for a repo with no commits. */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * The revision a working-tree diff is taken against: `HEAD` normally, the
 * empty tree when HEAD is unborn. Probed with `rev-parse --verify`, never by
 * reading status prose.
 */
async function resolveDiffBase(gitCli: GitCli, repo: IRepository): Promise<string> {
  const head = await gitCli.exec(['rev-parse', '--verify', '--quiet', 'HEAD'], {
    cwd: repo.rootUri.fsPath,
    throwOnError: false,
  });
  return head.exitCode === 0 && head.stdout.trim().length > 0 ? 'HEAD' : EMPTY_TREE_SHA;
}

/**
 * Concrete Patch Service.
 */
export class PatchService implements IPatchService {
  /**
   * Component-bound Logger emitted on construction and disposal so
   * operational waypoints land in the IntelliG OutputChannel
   * uniformly with the rest of the service graph.
   */
  private readonly _logger: Logger;

  constructor(private readonly _gitService: IGitService) {
    this._logger = getLogger().child({ component: 'PatchService' });
    this._logger.info('PatchService constructed');
  }

  /**
   * Apply a patch file (or inline patch content) to the given repository.
   *
   * Pipeline:
   *  1. Validate options — exactly one of `patchPath` / `patchContent`.
   *  2. Materialize inline content to a temp file (git apply/am only accept files).
   *  3. Build the git argv from options.
   *  4. Run `git apply` (or `git am`) with `throwOnError: false` so we can
   *     inspect exit codes.
   *  5. On success, best-effort-parse touched files from stdout.
   *  6. On failure, classify as conflict-vs-hard-error and either populate
   *     `conflicts` or return `stderr` for the caller.
   */
  async applyPatch(repo: IRepository, options: IApplyPatchOptions): Promise<IApplyPatchResult> {
    const gitCli = (this._gitService as IGitServiceWithCli).gitCli;

    // Validate input.
    if (!options.patchPath && !options.patchContent) {
      return {
        success: false,
        appliedFiles: [],
        stderr: 'Apply Patch: either patchPath or patchContent is required.',
      };
    }
    if (options.patchPath && options.patchContent) {
      return {
        success: false,
        appliedFiles: [],
        stderr: 'Apply Patch: patchPath and patchContent are mutually exclusive.',
      };
    }
    // Validate baseDir cannot escape the repo root and stripLevel is a
    // sane integer. Both flow into the `git apply` argv, so we refuse bad
    // input at the service boundary rather than leaning on git's own parse.
    const baseDirErr = validateBaseDir(options.baseDir, repo.rootUri.fsPath);
    if (baseDirErr) {
      return { success: false, appliedFiles: [], stderr: `Apply Patch: ${baseDirErr}` };
    }
    const stripErr = validateStripLevel(options.stripLevel);
    if (stripErr) {
      return { success: false, appliedFiles: [], stderr: `Apply Patch: ${stripErr}` };
    }

    // Materialize inline content to a temp file. Track it so we can
    // unlink unconditionally in the `finally` block.
    let tempPath: string | undefined;
    let patchPath = options.patchPath;
    if (options.patchContent !== undefined) {
      tempPath = await this._writeTempPatch(options.patchContent);
      patchPath = tempPath;
    }

    try {
      // Build argv. We keep the two sub-commands split for clarity.
      const args = this._buildApplyArgs(options, patchPath!);
      const execOptions: IGitCommandOptions = {
        cwd: repo.rootUri.fsPath,
        throwOnError: false,
      };

      // Snapshot the working state before a PLAIN 3-way apply — the one arm
      // that can leave partial state behind (conflicted files with markers,
      // clean siblings fully applied). `git stash create` disturbs neither
      // the tree nor the stash stack, so success/hard-failure simply drop
      // the unreferenced snapshot. `git am` needs no bracket (`am --abort`
      // is its rollback), and check mode mutates nothing.
      const ranAmPath = options.useAm === true && !options.reverse;
      const preApplyStashSha =
        !options.check && !ranAmPath
          ? await createWorkingStateSnapshot(
              gitCli,
              repo.rootUri.fsPath,
              'IntelliG: before Apply Patch'
            )
          : undefined;

      // Execute. `throwOnError: false` so we can distinguish conflict
      // from hard error based on the exit code + stderr shape.
      const result: IGitCommandResult = await gitCli.exec(args, execOptions);

      // 6: classify. In check mode we never produce conflicts.
      if (result.exitCode === 0) {
        return {
          success: true,
          appliedFiles: this._parseAppliedFiles(result.stdout + '\n' + result.stderr),
        };
      }

      // Dry-run mode: no conflict extraction — just report the stderr.
      // Sanitize before returning: git stderr may embed `user:token@host`
      // credentials if the patch references a remote URL.
      if (options.check) {
        return {
          success: false,
          appliedFiles: [],
          stderr: sanitizeGitError(result.stderr || result.stdout),
        };
      }

      // A failed `git am` can PAUSE with a live session on disk (a
      // multi-commit mailbox failing past commit 1). Probe the marker file
      // so callers can offer the am recovery ops instead of stranding the
      // session behind a plain error toast. Only when the argv actually ran
      // `git am` — plain `git apply` creates no repo state, so a stale
      // marker from an earlier session must not be attributed to it.
      const amSessionActive =
        ranAmPath && (await isAmSession(await resolveGitDir(repo.rootUri.fsPath)));

      const conflicts = await this._extractConflicts(repo, result.stderr, result.stdout);
      if (conflicts.length > 0) {
        const touched = this._parseAppliedFiles(result.stdout + '\n' + result.stderr);
        // The restore token rides only the plain-apply conflict arm; am
        // conflicts roll back through `git am --abort` instead.
        const preApplyState: IPreApplyState | undefined = ranAmPath
          ? undefined
          : { stashSha: preApplyStashSha, patchPaths: touched };
        return {
          success: false,
          appliedFiles: touched,
          conflicts,
          stderr: sanitizeGitError(result.stderr || result.stdout),
          ...(amSessionActive ? { amSessionActive: true } : {}),
          ...(preApplyState ? { preApplyState } : {}),
        };
      }

      return {
        success: false,
        appliedFiles: [],
        stderr: sanitizeGitError(result.stderr || result.stdout || 'git apply failed'),
        ...(amSessionActive ? { amSessionActive: true } : {}),
      };
    } finally {
      if (tempPath) {
        try {
          // Remove the whole mkdtemp directory (file + its private dir) so the
          // per-apply temp dir doesn't leak for the process lifetime.
          await fs.promises.rm(path.dirname(tempPath), { recursive: true, force: true });
          // eslint-disable-next-line no-restricted-syntax -- best-effort cleanup of a private mkdtemp dir; a leftover temp dir is harmless and there is no recovery worth surfacing.
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  }

  /**
   * Create a patch from the repo's local changes. Always returns the patch
   * text; delivery side-effects (clipboard / file write) happen before return.
   */
  async createPatchFromLocalChanges(
    repo: IRepository,
    options: ICreatePatchOptions
  ): Promise<string> {
    const gitCli = (this._gitService as IGitServiceWithCli).gitCli;

    // One diff invocation, one base. `git diff HEAD` compares HEAD to the
    // worktree, so a file that is both staged and dirty yields a SINGLE
    // coherent block — concatenating `diff` + `diff --cached` produced two
    // blocks with contradictory bases that `git apply` rejects. Mirrors
    // IntelliJ's one-change-per-file patch. `--cached` remains the explicit
    // staged-only mode. On an unborn HEAD (a fresh repo whose first commit
    // has not landed) `HEAD` does not resolve, so the base becomes the empty
    // tree — the first commit's content still yields one coherent block.
    const base = options.stagedOnly ? undefined : await resolveDiffBase(gitCli, repo);
    const argv = base === undefined ? ['diff', '--cached'] : ['diff', base];
    if (options.reverse) {
      argv.push('-R');
    }
    if (options.files && options.files.length > 0) {
      argv.push('--', ...options.files);
    }
    const result = await gitCli.exec(argv, {
      cwd: repo.rootUri.fsPath,
      throwOnError: false,
    });
    // Fail closed on a capped diff: the captured stdout is a prefix of the
    // real diff, so the patch would be silently corrupt (apply/am would fail
    // downstream). Refuse to deliver rather than write junk.
    if (result.truncated) {
      const msg = 'diff exceeds the capture limit; patch not written';
      // sanitize-exempt: non-error-data: fixed literal, carries no git output
      void vscode.window.showErrorMessage(`Failed to create patch: ${msg}`);
      throw new PatchWriteFailed(msg);
    }

    // A failing diff surfaces to the caller's toast path — silently treating
    // it as "no local changes" hid real errors (and delivery below would
    // have wiped the clipboard first).
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || 'git diff failed');
    }

    const patch = result.stdout;

    // Nothing to deliver: bail BEFORE the side effects so a clean tree can
    // never wipe the clipboard or leave a 0-byte patch file behind.
    if (patch.trim().length === 0) {
      return '';
    }

    // Deliver via the requested channel(s). Both flags can be set — we honor
    // each independently so a power user can save+copy in one go.
    if (options.toClipboard) {
      await vscode.env.clipboard.writeText(patch);
    }
    if (options.outputPath) {
      // Route the user-picked save through atomicWriteFile so a partial
      // write never leaves a truncated `.patch` file at the picked path —
      // `git apply` / `git am` would silently fail on junk.
      // Surface a sanitised toast here + re-throw as PatchWriteFailed so
      // callers can distinguish write-only failure from a successful
      // write + later clipboard issue, and skip their own re-toast.
      try {
        await atomicWriteFile(options.outputPath, patch);
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Failed to write patch: ${sanitizeGitError(raw)}`);
        throw new PatchWriteFailed(raw, { cause: err });
      }
    }

    return patch;
  }

  amContinue(repo: IRepository): Promise<IAmSessionOpResult> {
    return this._runAmSessionOp(repo, '--continue');
  }

  amSkip(repo: IRepository): Promise<IAmSessionOpResult> {
    return this._runAmSessionOp(repo, '--skip');
  }

  amAbort(repo: IRepository): Promise<IAmSessionOpResult> {
    return this._runAmSessionOp(repo, '--abort');
  }

  /**
   * Run one `git am` session op through the shared implementation
   * (git-core/ops/amSession — also behind the Resolve Conflicts dialog's
   * Continue), mapping unmerged paths into the patch-domain conflict shape.
   */
  private async _runAmSessionOp(
    repo: IRepository,
    flag: '--continue' | '--skip' | '--abort'
  ): Promise<IAmSessionOpResult> {
    const gitCli = (this._gitService as IGitServiceWithCli).gitCli;
    const outcome = await runAmSessionOp(gitCli, repo.rootUri.fsPath, flag);
    if (outcome.success) {
      return { success: true };
    }
    if (outcome.conflictPaths && outcome.conflictPaths.length > 0) {
      const conflicts: IConflictedFile[] = outcome.conflictPaths.map((path) => ({
        path,
        resolved: false,
      }));
      return { success: false, conflicts };
    }
    return { success: false, failureReason: outcome.failureReason };
  }

  dispose(): void {
    this._logger.info('PatchService disposing');
    // No subscriptions held; intentionally empty otherwise.
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  /**
   * Build the `git apply` / `git am` argv from `IApplyPatchOptions`. Kept
   * separate so tests (and future callers) can validate argv without going
   * through the full apply flow.
   */
  private _buildApplyArgs(options: IApplyPatchOptions, patchPath: string): string[] {
    // `git am` is a higher-level command that wants the patch as the final
    // positional. It doesn't accept --3way by default — we add --3way so it
    // degrades to conflict markers instead of a hard stop where possible.
    if (options.useAm && !options.check) {
      if (options.reverse) {
        // `git am` doesn't support --reverse; fall back to `git apply` with
        // --reverse. This is a defensive choice — IntelliJ surfaces the same
        // fallback silently.
        return this._buildPlainApplyArgs(options, patchPath);
      }
      const flags = ['--3way'];
      if (options.stripLevel !== undefined) {
        flags.push(`-p${options.stripLevel}`);
      }
      if (options.baseDir) {
        flags.push('--directory', options.baseDir);
      }
      // Splice `--` before the patch path (via buildGitArgs' `paths` arg) so a
      // leading-dash path can never be parsed as a flag — uniform with the
      // project's --end-of-options argv hardening.
      return buildGitArgs('am', flags, [], [patchPath]);
    }
    return this._buildPlainApplyArgs(options, patchPath);
  }

  /**
   * Build argv for `git apply`. Always uses `--index` so the patch is staged
   * on success (matches IntelliJ's default behavior). Uses `--3way` so
   * overlapping changes produce markers rather than a hard failure.
   */
  private _buildPlainApplyArgs(options: IApplyPatchOptions, patchPath: string): string[] {
    const flags: string[] = [];
    if (options.check) {
      flags.push('--check');
    } else {
      // --verbose makes git report EVERY touched file ("Checking patch
      // <path>..."), not just the 3-way-fallback ones — without it a file
      // that applies cleanly first-try is silent, so the conflict scoping
      // and the pre-apply restore token would miss cleanly-applied siblings.
      flags.push('--index', '--3way', '--verbose');
    }
    if (options.reverse) {
      flags.push('--reverse');
    }
    if (options.stripLevel !== undefined) {
      flags.push(`-p${options.stripLevel}`);
    }
    if (options.baseDir) {
      flags.push('--directory', options.baseDir);
    }
    // Splice `--` before the patch path (via buildGitArgs' `paths` arg) so a
    // leading-dash path can never be parsed as a flag — uniform with the
    // project's --end-of-options argv hardening.
    return buildGitArgs('apply', flags, [], [patchPath]);
  }

  /**
   * Write raw patch content to a unique temp file. Returns the absolute path.
   */
  private async _writeTempPatch(content: string): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'intellig-patch-'));
    const file = path.join(dir, 'patch.diff');
    await fs.promises.writeFile(file, content, 'utf-8');
    return file;
  }

  /**
   * Derive conflict file list. Strategy:
   *  1. If git stderr/stdout looks conflict-shaped, read `git status` and
   *     collect files with `U` index or worktree status (same signal as
   *     ConflictResolutionService.getConflictedFiles).
   *  2. Scope those to the files THIS patch touched (parsed from git's output)
   *     so a pre-existing, unrelated merge conflict elsewhere in the repo is
   *     not mis-attributed to the patch. When the output yields no parseable
   *     file list we fall back to all `U` files rather than risk dropping a
   *     real conflict.
   *  3. If no conflict markers found, return [] (caller treats as hard error)
   *     and skip the status read entirely.
   */
  private async _extractConflicts(
    repo: IRepository,
    stderr: string,
    stdout: string
  ): Promise<IConflictedFile[]> {
    if (!looksLikePatchConflictText(stderr + ' ' + stdout)) {
      return [];
    }
    const statusFiles = await this._gitService.getStatus(repo);
    // isConflictedStatus covers U (unmerged), AA (both-added), and DD
    // (both-deleted) — all three signal a conflict that the caller must handle.
    const unmerged = statusFiles.filter(isConflictedStatus);

    const touched = new Set(this._parseAppliedFiles(stdout + '\n' + stderr));
    const scoped = touched.size > 0 ? unmerged.filter((f) => touched.has(f.path)) : unmerged;

    return scoped.map((f) => ({ path: f.path, resolved: false }));
  }

  /**
   * Recover the touched file list from git's per-file apply output. The
   * prose shapes live in gitProse (`parseAppliedPatchFiles`) under the
   * locale-pin contract.
   */
  private _parseAppliedFiles(output: string): string[] {
    return parseAppliedPatchFiles(output);
  }
}

/**
 * Factory. Mirrors the pattern used by sibling services.
 */
export function createPatchService(gitService: IGitService): PatchService {
  return new PatchService(gitService);
}

/**
 * One changed file carved out of a multi-file unified patch.
 */
export interface IPatchFileSegment {
  /** Repo-relative path of the changed file (the `b/<path>` side). */
  path: string;
  /**
   * Verbatim patch text for just this file, including its `diff --git`
   * header, so it applies through the standard `git apply` path unchanged.
   */
  content: string;
}

/**
 * Matches a `diff --git a/<old> b/<new>` header line. Mirrors IntelliJ
 * PatchReader's `ourGitHeaderLinePattern`
 * (`diff --git\s+(\S+)\s+(\S+).*`) — paths are whitespace-delimited tokens.
 */
const GIT_DIFF_HEADER = /^diff --git\s+(\S+)\s+(\S+).*$/;

/**
 * Split a unified patch into one segment per changed file.
 *
 * Mirrors IntelliJ `PatchReader.readTextPatches()`
 * (platform/vcs-impl/src/com/intellij/openapi/diff/impl/patch/PatchReader.java),
 * which yields a `TextFilePatch` per file by breaking the stream on each
 * `diff --git` header line (`DIFF_GIT_HEADER_LINE`). Any `git format-patch`
 * style preamble before the first header is dropped, just as the reader skips
 * non-patch lines until the first recognised header.
 *
 * Each segment keeps the file's diff block verbatim, so a single-file patch
 * round-trips to one segment whose `content` equals the input. Returns an
 * empty array when no `diff --git` header is present — the caller decides how
 * to treat a headerless patch.
 */
export function splitPatchByFile(content: string): IPatchFileSegment[] {
  // Split immediately before each header line, retaining the delimiter at the
  // start of each piece. The first piece is any preamble and is discarded by
  // the `startsWith` filter below.
  const blocks = content
    .split(/(?=^diff --git )/m)
    .filter((block) => block.startsWith('diff --git '));

  const segments: IPatchFileSegment[] = [];
  for (const block of blocks) {
    const header = block.slice(0, block.indexOf('\n') === -1 ? undefined : block.indexOf('\n'));
    const match = header.match(GIT_DIFF_HEADER);
    if (!match) {
      continue;
    }
    // Recover the repo-relative path from the `b/<new>` side, falling back to
    // the `a/<old>` side for pure deletions where the new path is `/dev/null`.
    const newPath = stripPatchPathPrefix(match[2]);
    const oldPath = stripPatchPathPrefix(match[1]);
    const path = newPath === '/dev/null' || newPath.length === 0 ? oldPath : newPath;
    segments.push({ path, content: block });
  }
  return segments;
}

/**
 * First line of a `git format-patch` mailbox: `From <sha> Mon Sep 17 …`.
 * This is what `git am`'s format detection keys on; a patch that loses it
 * fails with "Patch format detection failed" before a hunk is ever read.
 */
const MAILBOX_FIRST_LINE = /^From \S+ /;

/**
 * Return the mailbox envelope preceding the first `diff --git` header, or
 * `undefined` when `content` is a plain unified diff.
 *
 * The envelope carries the author, date and commit message `git am` turns
 * into a commit, so it must survive per-file subsetting. The trailing
 * diffstat inside it may name files the subset dropped; `git apply` skips
 * non-diff lines, so a stale summary is harmless.
 */
export function extractMailboxPreamble(content: string): string | undefined {
  const firstHeader = content.search(/^diff --git /m);
  if (firstHeader <= 0) {
    return undefined;
  }
  const preamble = content.slice(0, firstHeader);
  return MAILBOX_FIRST_LINE.test(preamble) ? preamble : undefined;
}

/**
 * Reassemble a unified patch keeping only the blocks for `selectedPaths`.
 *
 * This is the engine behind per-file Apply-Patch selection. It mirrors
 * IntelliJ `ApplyPatchDifferentiatedDialog.getIncludedChanges()`
 * (platform/vcs-impl/src/com/intellij/openapi/vcs/changes/patch/
 * ApplyPatchDifferentiatedDialog.java): the patch is shown per file and only
 * the checked rows are applied.
 *
 * Splits via `splitPatchByFile`, keeps the segments whose `path` is in
 * `selectedPaths`, and concatenates each kept segment's text verbatim — so the
 * result is a valid patch that round-trips through `git apply` unchanged.
 * Selecting every file yields the same blocks as the input (any `git
 * format-patch` preamble aside, which `splitPatchByFile` drops). Returns an
 * empty string when nothing matches; the caller treats that as "apply nothing".
 */
export function filterPatchByFiles(content: string, selectedPaths: string[]): string {
  const wanted = new Set(selectedPaths);
  const kept = splitPatchByFile(content)
    .filter((segment) => wanted.has(segment.path))
    .map((segment) => segment.content)
    .join('');
  if (kept.length === 0) {
    return '';
  }
  // A mailbox source stays a mailbox: `git am` rejects a subset stripped of
  // its `From …` envelope outright.
  return (extractMailboxPreamble(content) ?? '') + kept;
}

/**
 * Strip the leading `a/` or `b/` prefix git puts on patch header paths.
 * Leaves `/dev/null` and prefix-less paths untouched.
 */
function stripPatchPathPrefix(token: string): string {
  if (token.startsWith('a/') || token.startsWith('b/')) {
    return token.slice(2);
  }
  return token;
}

/**
 * Validate an `IApplyPatchOptions.baseDir` input.
 *
 * The value is passed to `git apply --directory <value>`. git itself will
 * happily accept a path outside the repo; we refuse that up-front to prevent
 * an `Apply Patch…` flow from modifying files above `repo.rootUri`.
 *
 * Rules:
 *  - `undefined` / empty → allowed (git applies relative to CWD).
 *  - The value is resolved against `repoRoot`; the result MUST stay under
 *    `repoRoot` (no `..` traversal).
 *  - Absolute paths that escape the repo root are rejected.
 *
 * Returns `undefined` when valid, an error message string when invalid.
 */
export function validateBaseDir(baseDir: string | undefined, repoRoot: string): string | undefined {
  if (baseDir === undefined || baseDir === '') {
    return undefined;
  }
  if (typeof baseDir !== 'string') {
    return 'baseDir must be a string';
  }
  // Defense-in-depth: null byte would truncate in downstream C code.
  if (baseDir.includes('\0')) {
    return 'baseDir contains invalid characters';
  }
  // Resolve against the repo root. `path.resolve` normalizes `..` segments,
  // so a traversal attempt lands outside `repoRoot` and is caught below.
  const resolved = path.resolve(repoRoot, baseDir);
  const normRoot = path.resolve(repoRoot);
  const rootWithSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
  if (resolved !== normRoot && !resolved.startsWith(rootWithSep)) {
    return `baseDir must stay inside the repository root (${normRoot})`;
  }
  return undefined;
}

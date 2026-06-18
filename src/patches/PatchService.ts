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
  ICreatePatchOptions,
} from './interfaces/IPatchService';
import { IGitService, IRepository } from '../git-core/interfaces/IGitService';
import { IConflictedFile } from '../conflicts/interfaces/IConflictResolutionService';
import { GitCli, IGitCommandOptions, IGitCommandResult } from '../git-core/gitCli';
import { sanitizeGitError } from '../git-core/gitError';
import { atomicWriteFile } from '../utils/atomicWrite';
import { getLogger, type Logger } from '../utils/logger';

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
 * Lowercase tokens that indicate git apply / am produced conflict markers
 * rather than a hard error. Covers the standard phrasing emitted by git when
 * `--3way` falls through to merge markers or when `am` pauses mid-patch.
 *
 * Mirrors the heuristic used in StashView.ts `_looksLikeConflictError`.
 */
const CONFLICT_PHRASES = [
  'conflict',
  'patch does not apply',
  'patch failed',
  'patch failed at',
  'applied patch to',
  'needs merge',
  'u ',
];

/**
 * Narrow `IGitService` to the surface we actually need (just `.gitCli`).
 */
interface IGitServiceWithCli extends IGitService {
  gitCli: GitCli;
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
      // credentials if the patch references a remote URL (LOW finding).
      if (options.check) {
        return {
          success: false,
          appliedFiles: [],
          stderr: sanitizeGitError(result.stderr || result.stdout),
        };
      }

      const conflicts = await this._extractConflicts(repo, result.stderr, result.stdout);
      if (conflicts.length > 0) {
        return {
          success: false,
          appliedFiles: this._parseAppliedFiles(result.stdout + '\n' + result.stderr),
          conflicts,
          stderr: sanitizeGitError(result.stderr || result.stdout),
        };
      }

      return {
        success: false,
        appliedFiles: [],
        stderr: sanitizeGitError(result.stderr || result.stdout || 'git apply failed'),
      };
    } finally {
      if (tempPath) {
        try {
          await fs.promises.unlink(tempPath);
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

    // Build the diff argv. When stagedOnly is set, only the index-vs-HEAD diff
    // is emitted. Otherwise we concatenate staged + unstaged so "Create Patch
    // from Local Changes" actually contains everything the user has.
    const baseArgs: string[][] = [];
    if (options.stagedOnly) {
      baseArgs.push(['diff', '--cached']);
    } else {
      // Unstaged + staged, in that order. Mirrors what IntelliJ's "Create
      // Patch" produces for a default changelist.
      baseArgs.push(['diff']);
      baseArgs.push(['diff', '--cached']);
    }

    const sections: string[] = [];
    for (const args of baseArgs) {
      const argv = [...args];
      if (options.files && options.files.length > 0) {
        argv.push('--', ...options.files);
      }
      const result = await gitCli.exec(argv, {
        cwd: repo.rootUri.fsPath,
        throwOnError: false,
      });
      if (result.exitCode === 0 && result.stdout) {
        sections.push(result.stdout);
      }
    }

    const patch = sections.join('');

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
      const args = ['am', '--3way'];
      if (options.reverse) {
        // `git am` doesn't support --reverse; fall back to `git apply` with
        // --reverse. This is a defensive choice — IntelliJ surfaces the same
        // fallback silently.
        return this._buildPlainApplyArgs(options, patchPath);
      }
      if (options.stripLevel !== undefined) {
        args.push(`-p${options.stripLevel}`);
      }
      if (options.baseDir) {
        args.push('--directory', options.baseDir);
      }
      args.push(patchPath);
      return args;
    }
    return this._buildPlainApplyArgs(options, patchPath);
  }

  /**
   * Build argv for `git apply`. Always uses `--index` so the patch is staged
   * on success (matches IntelliJ's default behavior). Uses `--3way` so
   * overlapping changes produce markers rather than a hard failure.
   */
  private _buildPlainApplyArgs(options: IApplyPatchOptions, patchPath: string): string[] {
    const args = ['apply'];
    if (options.check) {
      args.push('--check');
    } else {
      args.push('--index', '--3way');
    }
    if (options.reverse) {
      args.push('--reverse');
    }
    if (options.stripLevel !== undefined) {
      args.push(`-p${options.stripLevel}`);
    }
    if (options.baseDir) {
      args.push('--directory', options.baseDir);
    }
    args.push(patchPath);
    return args;
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
   * Heuristic: does git's error output look like a conflict-markers failure
   * rather than a hard refusal?
   */
  private _looksLikeConflict(stderr: string, stdout: string): boolean {
    const blob = (stderr + ' ' + stdout).toLowerCase();
    return CONFLICT_PHRASES.some((phrase) => blob.includes(phrase));
  }

  /**
   * Derive conflict file list. Strategy:
   *  1. If git stderr/stdout looks conflict-shaped, read `git status` and
   *     return files with `U` index or worktree status (same signal as
   *     ConflictResolutionService.getConflictedFiles).
   *  2. If no conflict markers found, return [] (caller treats as hard error).
   */
  private async _extractConflicts(
    repo: IRepository,
    stderr: string,
    stdout: string
  ): Promise<IConflictedFile[]> {
    if (!this._looksLikeConflict(stderr, stdout)) {
      return [];
    }
    const statusFiles = await this._gitService.getStatus(repo);
    return statusFiles
      .filter((f) => f.indexStatus === 'U' || f.workTreeStatus === 'U')
      .map((f) => ({ path: f.path, resolved: false }));
  }

  /**
   * Parse "Applied patch …" / "Applying: …" / `git apply --verbose` headers
   * to recover the touched file list. Falls back to [] if no header found.
   */
  private _parseAppliedFiles(output: string): string[] {
    const files = new Set<string>();
    const lines = output.split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      // `git apply` emits "Applied patch X.diff cleanly" or
      // "Applying: <subject>" (am) — neither lists files. But with --verbose
      // or --numstat you get "<file>\t..." or "patching file <path>".
      const patching = line.match(/^patching file (.+)$/i);
      if (patching) {
        files.add(patching[1]);
        continue;
      }
      const checking = line.match(/^Checking patch (.+?)\.\.\.$/);
      if (checking) {
        files.add(checking[1]);
      }
    }
    return Array.from(files);
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
  return splitPatchByFile(content)
    .filter((segment) => wanted.has(segment.path))
    .map((segment) => segment.content)
    .join('');
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

/**
 * Validate an `IApplyPatchOptions.stripLevel` input.
 *
 * Rules: must be a finite non-negative integer, and reasonably small
 * (`≤ 20`) so a typo doesn't turn into `git apply -p999999` which strips the
 * whole path and silently no-ops. Returns `undefined` when valid, an error
 * message when invalid.
 */
export function validateStripLevel(stripLevel: number | undefined): string | undefined {
  if (stripLevel === undefined) {
    return undefined;
  }
  if (typeof stripLevel !== 'number' || !Number.isFinite(stripLevel)) {
    return 'stripLevel must be a finite number';
  }
  if (!Number.isInteger(stripLevel)) {
    return 'stripLevel must be an integer';
  }
  if (stripLevel < 0) {
    return 'stripLevel must be >= 0';
  }
  if (stripLevel > 20) {
    return 'stripLevel must be <= 20';
  }
  return undefined;
}

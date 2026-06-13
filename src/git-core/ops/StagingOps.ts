import { IRepository, IFileStatus, IHunk, IDiffLine, ResetMode } from '../interfaces/IGitService';
import { parseStatus } from '../gitParser';
import { IGitOpsContext } from './GitOpsContext';

/**
 * Working-tree index & patch staging operations extracted from the
 * {@link GitService} façade. Stateless: reaches the live GitCli + cache
 * invalidation lazily through {@link IGitOpsContext}.
 */
export class StagingOps {
  constructor(private readonly ctx: IGitOpsContext) {}

  async getStatus(repo: IRepository): Promise<IFileStatus[]> {
    const result = await this.ctx.gitCli.exec(['status', '--porcelain'], {
      cwd: repo.rootUri.fsPath,
    });

    if (result.exitCode !== 0) {
      return [];
    }

    return parseStatus(result.stdout);
  }

  async stage(repo: IRepository, paths: string[]): Promise<void> {
    await this.ctx.gitCli.exec(['add', '--', ...paths], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  async unstage(repo: IRepository, paths: string[]): Promise<void> {
    await this.ctx.gitCli.exec(['reset', 'HEAD', '--', ...paths], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Stage a single hunk from a file.
   *
   * @param repo - The repository
   * @param path - The file path
   * @param hunk - The hunk to stage
   */
  async stageHunk(repo: IRepository, path: string, hunk: IHunk): Promise<void> {
    // Generate a patch for the hunk
    const patch = this.generateHunkPatch(path, hunk);

    await this.ctx.gitCli.exec(['apply', '--cached', '-'], {
      cwd: repo.rootUri.fsPath,
      input: patch,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Stage specific lines within a file.
   * This generates a custom patch that includes only the specified lines.
   *
   * @param repo - The repository
   * @param path - The file path
   * @param lines - Array of line numbers (1-indexed) in the new file to stage
   * @param hunk - The hunk containing the lines to stage
   */
  async stageLines(repo: IRepository, path: string, lines: number[], hunk: IHunk): Promise<void> {
    if (lines.length === 0) {
      return;
    }

    // Generate a patch that includes only the specified lines
    const patch = this.generateLinesPatch(path, lines, hunk);

    await this.ctx.gitCli.exec(['apply', '--cached', '-'], {
      cwd: repo.rootUri.fsPath,
      input: patch,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Unstage a single hunk from a file.
   * This generates a reverse patch and applies it to the index.
   *
   * @param repo - The repository
   * @param path - The file path
   * @param hunk - The hunk to unstage
   */
  async unstageHunk(repo: IRepository, path: string, hunk: IHunk): Promise<void> {
    // Generate a patch for the hunk
    const patch = this.generateHunkPatch(path, hunk);

    // Apply the patch in reverse to unstage
    await this.ctx.gitCli.exec(['apply', '--cached', '-R', '-'], {
      cwd: repo.rootUri.fsPath,
      input: patch,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Revert (discard) uncommitted changes to a file.
   * This restores the file to its last committed state.
   *
   * @param repo - The repository
   * @param path - The file path to revert
   */
  async revertFile(repo: IRepository, path: string): Promise<void> {
    // Use git checkout -- <path> to discard changes
    // This works for both modified and deleted files
    await this.ctx.gitCli.exec(['checkout', '--', path], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Reset the current branch to the given target commit using one of the four
   * IntelliJ reset modes.
   */
  async resetToCommit(repo: IRepository, target: string, mode: ResetMode): Promise<void> {
    // Security: reject refs starting with `-` (git would treat them as CLI
    // flags, bypassing the argv-spawn defense) or `.` (invalid per
    // git-check-ref-format). Mirrors the ResetDialog.isValidRef guard.
    if (!target || !/^(?![-.])[A-Za-z0-9_./@:~^-]+$/.test(target)) {
      throw new Error(`Invalid reset target: ${target}`);
    }
    const modeFlag = `--${mode}`;
    await this.ctx.gitCli.exec(['reset', modeFlag, target], {
      cwd: repo.rootUri.fsPath,
      throwOnError: true,
    });
    this.ctx.invalidateCache(repo.rootUri.fsPath);
  }

  /**
   * Generate a patch string for a single hunk.
   *
   * @param path - The file path
   * @param hunk - The hunk to generate a patch for
   * @returns The patch string
   */
  private generateHunkPatch(path: string, hunk: IHunk): string {
    const lines: string[] = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      hunk.header,
    ];

    for (const line of hunk.lines) {
      switch (line.type) {
        case 'add':
          lines.push(`+${line.content}`);
          break;
        case 'delete':
          lines.push(`-${line.content}`);
          break;
        case 'context':
          lines.push(` ${line.content}`);
          break;
      }
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Generate a patch string for specific lines within a hunk.
   * This creates a patch that only includes the selected lines while
   * converting unselected additions to context and keeping unselected deletions.
   *
   * @param path - The file path
   * @param selectedLines - Array of line numbers (1-indexed) in the new file to include
   * @param hunk - The hunk containing the lines
   * @returns The patch string
   */
  private generateLinesPatch(path: string, selectedLines: number[], hunk: IHunk): string {
    const selectedSet = new Set(selectedLines);

    // Build the new hunk with only selected lines
    const newLines: IDiffLine[] = [];
    let currentNewLine = hunk.newStart;
    let oldLines = 0;
    let newLinesCount = 0;

    for (const line of hunk.lines) {
      if (line.type === 'context') {
        // Context lines are always included
        newLines.push(line);
        oldLines++;
        newLinesCount++;
        currentNewLine++;
      } else if (line.type === 'add') {
        if (selectedSet.has(currentNewLine)) {
          // Include selected additions
          newLines.push(line);
          newLinesCount++;
        } else {
          // Convert unselected additions to context (they exist in working copy)
          // Skip them - they won't be staged
        }
        currentNewLine++;
      } else if (line.type === 'delete') {
        // For deletions, we need to check if the corresponding line is selected
        // Deletions don't have a new line number, so we include them if any
        // adjacent additions are selected, or always include them for simplicity
        // In practice, line-level staging of deletions is complex
        // For now, include deletions that are explicitly selected or adjacent to selected lines
        const lineNumber = line.oldLineNumber;
        if (lineNumber !== undefined && selectedSet.has(lineNumber)) {
          newLines.push(line);
          oldLines++;
        } else {
          // Convert unselected deletions to context
          newLines.push({
            type: 'context',
            content: line.content,
            oldLineNumber: line.oldLineNumber,
            newLineNumber: currentNewLine,
          });
          oldLines++;
          newLinesCount++;
        }
      }
    }

    // If no lines were actually selected for staging, return empty
    const hasChanges = newLines.some((l) => l.type === 'add' || l.type === 'delete');
    if (!hasChanges) {
      return '';
    }

    // Generate the new hunk header
    const newHeader = `@@ -${hunk.oldStart},${oldLines} +${hunk.newStart},${newLinesCount} @@`;

    const patchLines: string[] = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      newHeader,
    ];

    for (const line of newLines) {
      switch (line.type) {
        case 'add':
          patchLines.push(`+${line.content}`);
          break;
        case 'delete':
          patchLines.push(`-${line.content}`);
          break;
        case 'context':
          patchLines.push(` ${line.content}`);
          break;
      }
    }

    return patchLines.join('\n') + '\n';
  }
}

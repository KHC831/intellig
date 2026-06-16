import * as vscode from 'vscode';
import { registerLoggedCommand } from '../../utils/logger';
import { resolveRepo } from '../../utils/resolveRepo';
import { formatActionFailureToast } from '../../git-core/gitError';
import {
  createInlineBlameProvider,
  createGutterBlameProvider,
  type IRepository,
  type IBlameLine,
} from '../../services';
import type { ICommandContext } from './CommandContext';

/**
 * Resolve the target URI for `intellig.localChanges.openFile` (F4 /
 * "Jump to Source" from Local Changes).
 *
 * The command is invoked from three sources:
 *   - CommitToolWindow's webview postMessage (path passed as `string`).
 *   - Future explorer-context entries (URI passed directly).
 *   - The F4 keybinding from a focused Local-Changes view (no argument;
 *     the caller is expected to wire `currentSelection` from whatever
 *     selection state is reachable — until that exists, this case
 *     returns `undefined` and the command handler falls back to a toast
 *     hinting the user to select a file first).
 *
 * Centralised so unit tests can verify the resolution rules without
 * spinning up the full extension host. Relocated verbatim from extension.ts
 * (a by-name test seam) and re-exported there so the
 * `from '../../../extension'` import path used by `localChangesOpenFile.test.ts`
 * is preserved (RULE E2). The helper file never imports extension.ts.
 *
 * @param arg - The argument forwarded by VS Code to the command handler.
 *   `vscode.Uri` or string from explicit invocations; `undefined` for
 *   bare keybinding presses.
 * @param currentSelection - The path of the currently-selected
 *   Local-Changes row, when known. Empty strings are treated the same as
 *   `undefined` so an unset selection accessor does not produce a bogus
 *   `Uri.file('')`.
 * @returns The URI to pass to `vscode.open`, or `undefined` when no
 *   target is reachable (caller surfaces a toast).
 */
export function resolveLocalChangesOpenFileTarget(
  arg: vscode.Uri | string | undefined,
  currentSelection: string | undefined
): vscode.Uri | undefined {
  if (arg !== undefined) {
    if (typeof arg === 'string') {
      if (arg.length === 0) {
        return undefined;
      }
      return vscode.Uri.file(arg);
    }
    return arg;
  }
  if (currentSelection !== undefined && currentSelection.length > 0) {
    return vscode.Uri.file(currentSelection);
  }
  return undefined;
}

/**
 * Blame (inline + gutter) and editor-context-menu command handlers plus
 * `intellig.localChanges.openFile`, extracted verbatim from extension.ts's
 * registerCommands.
 *
 * Reaches shared state through {@link ICommandContext}. The inline/gutter
 * blame providers are lazily written back through the read/WRITE ctx
 * accessors (RULE E1). Returns its disposables; extension.ts owns the single
 * push (RULE E4).
 */
export function registerBlameEditorCommands(ctx: ICommandContext): vscode.Disposable[] {
  const toggleBlameCommand = registerLoggedCommand('intellig.toggleBlame', () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    // Toggle inline blame
    if (!ctx.inlineBlameProvider) {
      ctx.inlineBlameProvider = createInlineBlameProvider(
        ctx.services.blameService,
        ctx.services.gitService,
        ctx.services.blameOptionsSource
      );
    }

    const enabled = ctx.inlineBlameProvider.toggle();
    void vscode.window.showInformationMessage(
      `Inline blame annotations ${enabled ? 'enabled' : 'disabled'}`
    );
  });

  // Toggle gutter blame annotations command
  const toggleGutterBlameCommand = registerLoggedCommand('intellig.toggleGutterBlame', () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    // Toggle gutter blame
    if (!ctx.gutterBlameProvider) {
      ctx.gutterBlameProvider = createGutterBlameProvider(
        ctx.services.blameService,
        ctx.services.gitService,
        ctx.services.blameOptionsSource
      );
    }

    const enabled = ctx.gutterBlameProvider.toggle();
    void vscode.window.showInformationMessage(
      `Gutter blame annotations ${enabled ? 'enabled' : 'disabled'}`
    );
  });

  const localChangesOpenFileCommand = registerLoggedCommand(
    'intellig.localChanges.openFile',
    async (arg?: vscode.Uri | string) => {
      const target = resolveLocalChangesOpenFileTarget(arg, undefined);
      if (target) {
        await vscode.commands.executeCommand('vscode.open', target);
        return;
      }
      void vscode.window.showInformationMessage('Select a file in Local Changes first.');
    }
  );

  const editorToggleBlameCommand = registerLoggedCommand('intellig.editor.toggleBlame', () => {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return;
    }

    // Create inline blame provider if not exists
    if (!ctx.inlineBlameProvider) {
      ctx.inlineBlameProvider = createInlineBlameProvider(
        ctx.services.blameService,
        ctx.services.gitService,
        ctx.services.blameOptionsSource
      );
    }

    const enabled = ctx.inlineBlameProvider.toggle();
    void vscode.window.showInformationMessage(
      `Blame annotations ${enabled ? 'enabled' : 'disabled'}`
    );
  });

  // Show Line History command for editor context menu
  const editorShowLineHistoryCommand = registerLoggedCommand(
    'intellig.editor.showLineHistory',
    async () => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        void vscode.window.showErrorMessage('No active editor');
        return;
      }

      const gitService = ctx.services.gitService;
      const blameService = ctx.services.blameService;
      // honor the active-editor file's repo in multi-root workspaces.
      const repo = await resolveRepo(gitService, {
        hintRepoPath: activeEditor.document.uri.fsPath,
        preferActive: true,
      });
      if (!repo) {
        return;
      }
      const filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      const line = activeEditor.selection.active.line + 1; // Convert to 1-indexed

      try {
        // Get blame info for the current line
        const blameLine = await blameService.getBlameForLine(repo, filePath, line);

        if (blameLine.commit.startsWith('0000000')) {
          void vscode.window.showInformationMessage('This line has not been committed yet');
          return;
        }

        // Get the file history and filter to commits that modified this line
        const history = await gitService.getFileHistory(repo, filePath);

        // Show history in a quick pick
        const items = history.map((commit) => ({
          label: commit.shortHash,
          description: commit.message.substring(0, 60),
          detail: `${commit.author.name} - ${commit.authorDate.toLocaleDateString()}`,
          commit,
        }));

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: `History for line ${line} in ${filePath}`,
          title: 'Line History',
        });

        if (selected) {
          // sanitize-exempt: non-error-data: selected.commit.message is the user-authored commit subject from `git log`, not git stderr
          void vscode.window.showInformationMessage(
            `Commit ${selected.commit.shortHash}: ${selected.commit.message}`
          );
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to get line history', error)
        );
      }
    }
  );

  // Copy Commit Hash command for editor context menu.
  //
  // `commitHashArg` is supplied when invoked from a blame gutter/inline hover
  // link; otherwise the commit is resolved from the cursor line's blame.
  const editorCopyCommitHashCommand = registerLoggedCommand(
    'intellig.editor.copyCommitHash',
    async (commitHashArg?: unknown) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      // Click-through from the blame annotation — the commit is supplied directly.
      if (typeof commitHashArg === 'string' && commitHashArg.length > 0) {
        await vscode.env.clipboard.writeText(commitHashArg);
        void vscode.window.showInformationMessage(
          `Copied commit hash: ${commitHashArg.substring(0, 7)}`
        );
        return;
      }

      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        void vscode.window.showErrorMessage('No active editor');
        return;
      }

      const gitService = ctx.services.gitService;
      const blameService = ctx.services.blameService;
      // honor the active-editor file's repo in multi-root workspaces.
      const repo = await resolveRepo(gitService, {
        hintRepoPath: activeEditor.document.uri.fsPath,
        preferActive: true,
      });
      if (!repo) {
        return;
      }
      const filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      const line = activeEditor.selection.active.line + 1; // Convert to 1-indexed

      try {
        // Get blame info for the current line
        const blameLine = await blameService.getBlameForLine(repo, filePath, line);

        if (blameLine.commit.startsWith('0000000')) {
          void vscode.window.showInformationMessage('This line has not been committed yet');
          return;
        }

        // Copy the commit hash to clipboard
        await vscode.env.clipboard.writeText(blameLine.commit);
        void vscode.window.showInformationMessage(
          `Copied commit hash: ${blameLine.commit.substring(0, 7)}`
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to copy commit hash', error)
        );
      }
    }
  );

  // Show Commit command for editor context menu.
  //
  // `commitHashArg` is supplied when the command is invoked from a blame
  // gutter/inline hover link (the commit travels with the click). When
  // omitted (context-menu / keybinding invocation), the commit is resolved
  // from the blame of the line under the cursor.
  const editorShowCommitCommand = registerLoggedCommand(
    'intellig.editor.showCommit',
    async (commitHashArg?: unknown) => {
      if (!ctx.services) {
        void vscode.window.showErrorMessage('Extension services not initialized');
        return;
      }

      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        void vscode.window.showErrorMessage('No active editor');
        return;
      }

      const gitService = ctx.services.gitService;
      const blameService = ctx.services.blameService;
      // honor the active-editor file's repo in multi-root workspaces.
      const repo = await resolveRepo(gitService, {
        hintRepoPath: activeEditor.document.uri.fsPath,
        preferActive: true,
      });
      if (!repo) {
        return;
      }

      try {
        let targetHash: string;
        if (typeof commitHashArg === 'string' && commitHashArg.length > 0) {
          // Click-through from the blame annotation — use the supplied commit.
          targetHash = commitHashArg;
        } else {
          const filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
          const line = activeEditor.selection.active.line + 1; // Convert to 1-indexed
          const blameLine = await blameService.getBlameForLine(repo, filePath, line);
          if (blameLine.commit.startsWith('0000000')) {
            void vscode.window.showInformationMessage('This line has not been committed yet');
            return;
          }
          targetHash = blameLine.commit;
        }

        // Get full commit details
        const commit = await gitService.getCommit(repo, targetHash);

        // Get the diff for this commit
        const diffs = await gitService.getCommitDiff(repo, commit.hash);

        // Show commit details in a quick pick with options
        const items = [
          {
            label: '$(git-commit) View Commit Details',
            description: `${commit.shortHash} - ${commit.message.substring(0, 40)}`,
            action: 'details',
          },
          {
            label: '$(files) View Changed Files',
            description: `${diffs.length} file(s) changed`,
            action: 'files',
          },
          {
            label: '$(clippy) Copy Commit Hash',
            description: commit.hash,
            action: 'copy',
          },
        ];

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: `Commit ${commit.shortHash}: ${commit.message.substring(0, 50)}`,
          title: 'Show Commit',
        });

        if (selected) {
          switch (selected.action) {
            case 'details': {
              // Show full commit details in an information message
              const dateStr = commit.authorDate.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              });
              // sanitize-exempt: non-error-data: commit.message + commit.author.name come from `git log`/`git show` output, not git stderr; user-authored content
              void vscode.window.showInformationMessage(
                `Commit: ${commit.shortHash}\nAuthor: ${commit.author.name}\nDate: ${dateStr}\n\n${commit.message}`,
                { modal: true }
              );
              break;
            }
            case 'files': {
              // Show changed files in a quick pick
              const fileItems = diffs.map((d) => ({
                label: d.path,
                description: d.status,
              }));
              await vscode.window.showQuickPick(fileItems, {
                placeHolder: `Files changed in ${commit.shortHash}`,
                title: 'Changed Files',
              });
              break;
            }
            case 'copy':
              await vscode.env.clipboard.writeText(commit.hash);
              void vscode.window.showInformationMessage(`Copied commit hash: ${commit.shortHash}`);
              break;
          }
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Failed to show commit', error)
        );
      }
    }
  );

  // =========================================================================
  // Blame gutter menu commands.
  //
  // All commands resolve the blame line under the *active editor cursor* —
  // VS Code doesn't expose the gutter click position, so the menu surface
  // uses the current cursor as the anchor. This matches IntelliJ's own
  // behavior when invoking the annotate menu by keyboard.
  // =========================================================================
  /**
   * Resolve the current editor's repo + file-path + cursor-line + blame line.
   * Shared by all blame-menu commands. Returns `undefined` when any piece is
   * missing (no editor / no repo / file not in repo / uncommitted line).
   */
  async function _resolveBlameContext(): Promise<
    | {
        editor: vscode.TextEditor;
        repo: IRepository;
        filePath: string;
        line: number;
        blameLine: IBlameLine;
      }
    | undefined
  > {
    if (!ctx.services) {
      void vscode.window.showErrorMessage('Extension services not initialized');
      return undefined;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showErrorMessage('No active editor');
      return undefined;
    }
    const gitService = ctx.services.gitService;
    const blameService = ctx.services.blameService;
    const repo = await gitService.getRepository(editor.document.uri);
    if (!repo) {
      void vscode.window.showErrorMessage('Current file is not in a Git repository');
      return undefined;
    }
    const relative = (await import('path')).relative(
      repo.rootUri.fsPath,
      editor.document.uri.fsPath
    );
    const line = editor.selection.active.line + 1; // 1-indexed.
    const blameLine = await blameService.getBlameForLine(
      repo,
      relative,
      line,
      ctx.services.blameOptionsSource.asBlameOptions()
    );
    if (blameLine.commit.startsWith('0000000')) {
      void vscode.window.showInformationMessage('This line has not been committed yet.');
      return undefined;
    }
    return { editor, repo, filePath: relative, line, blameLine };
  }

  // Show Commit — delegates to the existing intellig.editor.showCommit.
  const blameShowCommitCommand = registerLoggedCommand('intellig.blame.showCommit', async () => {
    await vscode.commands.executeCommand('intellig.editor.showCommit');
  });

  // Copy Revision Number — delegates to the existing copy-hash command.
  const blameCopyRevisionCommand = registerLoggedCommand(
    'intellig.blame.copyRevision',
    async () => {
      await vscode.commands.executeCommand('intellig.editor.copyCommitHash');
    }
  );

  // Annotate Previous Revision — re-blame the file at <sha>^ (parent of the
  // blamed commit). Uses the parent SHA recorded by git blame when available.
  const blameAnnotatePreviousCommand = registerLoggedCommand(
    'intellig.blame.annotatePrevious',
    async () => {
      const blameCtx = await _resolveBlameContext();
      if (!blameCtx || !ctx.services) {
        return;
      }
      try {
        // Target the filename at the parent revision if git reported a rename.
        const targetPath = blameCtx.blameLine.previousFilename ?? blameCtx.filePath;
        const info = await ctx.services.blameService.getPreviousRevisionBlame(
          blameCtx.repo,
          targetPath,
          blameCtx.blameLine.commit,
          ctx.services.blameOptionsSource.asBlameOptions()
        );
        if (info.lines.length === 0) {
          void vscode.window.showInformationMessage(
            'No previous revision available for this line.'
          );
          return;
        }
        // Resolve the parent SHA for the toast.
        const shortParent = (
          blameCtx.blameLine.previousCommit ?? `${blameCtx.blameLine.commit}^`
        ).substring(0, 7);
        void vscode.window.showInformationMessage(
          `Annotated at ${shortParent}: ${info.lines.length} line(s) blamed.`
        );
        // Refresh providers so the gutter / inline decorations re-render
        // against the new cached result; the providers keep HEAD-based blame
        // as their default view, so we hint refresh here.
        await ctx.gutterBlameProvider?.refresh();
        await ctx.inlineBlameProvider?.refresh();
      } catch (error) {
        void vscode.window.showErrorMessage(
          formatActionFailureToast('Annotate Previous failed', error)
        );
      }
    }
  );

  // Hide Revision — adds the blamed commit to the hidden-revision set so the
  // gutter / inline providers skip it on subsequent renders.
  const blameHideRevisionCommand = registerLoggedCommand(
    'intellig.blame.hideRevision',
    async () => {
      const blameCtx = await _resolveBlameContext();
      if (!blameCtx || !ctx.services) {
        return;
      }
      await ctx.services.blameOptionsSource.hideRevision(blameCtx.blameLine.commit);
      void vscode.window.showInformationMessage(
        `Hiding revision ${blameCtx.blameLine.commit.substring(0, 7)} from blame.`
      );
    }
  );

  // Options submenu — toggle Ignore Whitespace.
  const blameToggleIgnoreWhitespaceCommand = registerLoggedCommand(
    'intellig.blame.toggleIgnoreWhitespace',
    async () => {
      if (!ctx.services) {
        return;
      }
      const next = await ctx.services.blameOptionsSource.toggleFlag('ignoreWhitespace');
      void vscode.window.showInformationMessage(
        `Blame: Ignore Whitespaces ${next ? 'enabled' : 'disabled'}.`
      );
    }
  );

  // Options submenu — toggle Detect Movements Within File.
  const blameToggleDetectWithinCommand = registerLoggedCommand(
    'intellig.blame.toggleDetectMovementsWithinFile',
    async () => {
      if (!ctx.services) {
        return;
      }
      const next = await ctx.services.blameOptionsSource.toggleFlag('detectMovementsWithinFile');
      void vscode.window.showInformationMessage(
        `Blame: Detect Movements Within File ${next ? 'enabled' : 'disabled'}.`
      );
    }
  );

  // Options submenu — toggle Detect Movements Across Files.
  const blameToggleDetectAcrossCommand = registerLoggedCommand(
    'intellig.blame.toggleDetectMovementsAcrossFiles',
    async () => {
      if (!ctx.services) {
        return;
      }
      const next = await ctx.services.blameOptionsSource.toggleFlag('detectMovementsAcrossFiles');
      void vscode.window.showInformationMessage(
        `Blame: Detect Movements Across Files ${next ? 'enabled' : 'disabled'}.`
      );
    }
  );

  // Utility — clears the hidden-revision set (surfaced via command palette).
  const blameClearHiddenRevisionsCommand = registerLoggedCommand(
    'intellig.blame.clearHiddenRevisions',
    async () => {
      if (!ctx.services) {
        return;
      }
      await ctx.services.blameOptionsSource.clearHiddenRevisions();
      void vscode.window.showInformationMessage('Blame: hidden revisions cleared.');
    }
  );

  return [
    toggleBlameCommand,
    toggleGutterBlameCommand,
    localChangesOpenFileCommand,
    editorToggleBlameCommand,
    editorShowLineHistoryCommand,
    editorCopyCommitHashCommand,
    editorShowCommitCommand,
    blameShowCommitCommand,
    blameCopyRevisionCommand,
    blameAnnotatePreviousCommand,
    blameHideRevisionCommand,
    blameToggleIgnoreWhitespaceCommand,
    blameToggleDetectWithinCommand,
    blameToggleDetectAcrossCommand,
    blameClearHiddenRevisionsCommand,
  ];
}

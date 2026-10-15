import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * A watcher on each linked worktree's folder under `<common dir>/worktrees`,
 * for the two files the Worktrees list shows.
 *
 * The recursive `worktrees/*\/locked` glob relies on the platform watcher
 * adding a watch for each new folder, and on Linux (inotify) a folder created
 * together with its parent, as the first `git worktree add` does, can be
 * missed: its later lock never reports. A watcher rooted at the folder is
 * created after the folder exists and does not recurse, so it cannot miss it.
 * `sync` runs on every `.git` event, which picks up worktrees added since.
 */
export class WorktreeStateWatchers implements vscode.Disposable {
  private readonly _byName = new Map<string, vscode.FileSystemWatcher>();

  constructor(
    private readonly _worktreesDir: string,
    private readonly _onChange: (uri: vscode.Uri) => void
  ) {}

  sync(): void {
    const names = new Set(listDirectories(this._worktreesDir));
    for (const [name, watcher] of this._byName) {
      if (!names.has(name)) {
        watcher.dispose();
        this._byName.delete(name);
      }
    }
    for (const name of names) {
      if (!this._byName.has(name)) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            vscode.Uri.file(path.join(this._worktreesDir, name)),
            '{locked,gitdir}'
          )
        );
        watcher.onDidChange(this._onChange);
        watcher.onDidCreate(this._onChange);
        watcher.onDidDelete(this._onChange);
        this._byName.set(name, watcher);
      }
    }
  }

  dispose(): void {
    for (const watcher of this._byName.values()) {
      watcher.dispose();
    }
    this._byName.clear();
  }
}

/** The directory names in `dir`; none when it cannot be read. */
function listDirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No `worktrees` folder until the first `git worktree add`; the recursive
    // `worktrees/*` globs still cover the repository meanwhile.
    return [];
  }
}

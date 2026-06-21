/**
 * Credential-redaction tests for ConsoleService.
 *
 * The Git Console mirrors raw git command output to a VS Code OutputChannel
 * AND to the tool-window console. git embeds credentials in remote URLs that
 * surface in stderr on auth failure — e.g.
 *   fatal: unable to access 'https://x-access-token:ghp_abc123@github.com/o/r.git/'
 * The console event fires for EVERY exit code, including failures from the
 * unattended auto-fetch loop, so without redaction a PAT lands in the
 * persistent console with zero user interaction. Every value that reaches a
 * console sink must pass through sanitizeGitError first.
 */

import '../../setup';
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { ConsoleService } from '../../../src/ui-shell/ConsoleService';
import { GitCli, IGitCommandResult } from '../../../src/git-core/gitCli';
import { IConsoleEntry, IGitToolWindowProvider } from '../../../src/services/interfaces';
import { EventEmitter } from '../../mocks/vscode';

class StubOutputChannel {
  public name = 'IntelliG Git Console';
  public lines: string[] = [];
  append(value: string): void {
    this.lines.push(value);
  }
  appendLine(value: string): void {
    this.lines.push(`${value}\n`);
  }
  replace(value: string): void {
    this.lines = [value];
  }
  clear(): void {
    this.lines = [];
  }
  show(): void {
    /* no-op */
  }
  hide(): void {
    /* no-op */
  }
  dispose(): void {
    /* no-op */
  }
  text(): string {
    return this.lines.join('');
  }
}

class MockGitToolWindowProvider implements Partial<IGitToolWindowProvider> {
  public entries: Array<Omit<IConsoleEntry, 'timestamp'>> = [];
  addConsoleEntry(entry: Omit<IConsoleEntry, 'timestamp'>): void {
    this.entries.push(entry);
  }
  clearConsole(): void {
    this.entries = [];
  }
  refresh(): void {
    /* no-op */
  }
  text(): string {
    return this.entries.map((e) => `${e.command}\n${e.output}`).join('\n');
  }
}

class MockGitCli {
  private _onCommandExecuted = new EventEmitter<{
    command: string;
    args: string[];
    result: IGitCommandResult;
  }>();
  readonly onCommandExecuted = this._onCommandExecuted.event;
  fireCommandExecuted(command: string, args: string[], result: IGitCommandResult): void {
    this._onCommandExecuted.fire({ command, args, result });
  }
  dispose(): void {
    this._onCommandExecuted.dispose();
  }
}

const TOKEN = 'ghp_abc123def456ghi789jkl012';
const TOKEN_URL = `https://x-access-token:${TOKEN}@github.com/owner/repo.git`;
const AUTH_FAILURE = `fatal: unable to access '${TOKEN_URL}/': The requested URL returned error: 403`;

describe('ConsoleService credential redaction', () => {
  it('redacts a token in failed auto-fetch output across every sink', () => {
    const channel = new StubOutputChannel();
    const provider = new MockGitToolWindowProvider();
    const service = new ConsoleService(undefined, channel as unknown as vscode.OutputChannel);
    service.connectToToolWindow(provider as unknown as IGitToolWindowProvider);
    const gitCli = new MockGitCli();
    service.connectToGitCli(gitCli as unknown as GitCli);

    gitCli.fireCommandExecuted('git', ['fetch', '--prune', TOKEN_URL], {
      stdout: '',
      stderr: AUTH_FAILURE,
      combined: AUTH_FAILURE,
      exitCode: 128,
    });

    assert.ok(
      !channel.text().includes(TOKEN),
      `token leaked into OutputChannel: ${channel.text()}`
    );
    assert.ok(channel.text().includes('<redacted>'), 'channel should show <redacted>');
    assert.ok(
      !provider.text().includes(TOKEN),
      `token leaked into tool-window console: ${provider.text()}`
    );
    const entryText = service
      .getEntries()
      .map((e) => `${e.command}\n${e.output}`)
      .join('\n');
    assert.ok(!entryText.includes(TOKEN), `token leaked into stored entries: ${entryText}`);
  });

  it('redacts a token in the command line itself', () => {
    const channel = new StubOutputChannel();
    const service = new ConsoleService(undefined, channel as unknown as vscode.OutputChannel);
    const gitCli = new MockGitCli();
    service.connectToGitCli(gitCli as unknown as GitCli);

    gitCli.fireCommandExecuted('git', ['push', TOKEN_URL, 'HEAD'], {
      stdout: '',
      stderr: '',
      combined: '',
      exitCode: 0,
    });

    assert.ok(!channel.text().includes(TOKEN), `token leaked via command line: ${channel.text()}`);
  });

  it('redacts a token routed through the public logCommand API', () => {
    const channel = new StubOutputChannel();
    const service = new ConsoleService(undefined, channel as unknown as vscode.OutputChannel);
    service.logCommand('git fetch', AUTH_FAILURE, 128, { isError: true });
    assert.ok(!channel.text().includes(TOKEN), `token leaked via logCommand: ${channel.text()}`);
    assert.ok(!service.getEntries()[0].output.includes(TOKEN), 'stored entry output leaks token');
  });

  it('redacts a token in streamed output chunks', () => {
    const channel = new StubOutputChannel();
    const service = new ConsoleService(undefined, channel as unknown as vscode.OutputChannel);
    const handler = service.startStreaming('git fetch');
    handler.onData(`${AUTH_FAILURE}\n`);
    assert.ok(
      !channel.text().includes(TOKEN),
      `token leaked via streaming onData: ${channel.text()}`
    );
  });
});

/**
 * Unit tests for ConsoleService
 */

import '../../setup';
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { ConsoleService, createConsoleService } from '../../../ui-shell/ConsoleService';
import { GitCli, IGitCommandResult } from '../../../git-core/gitCli';
import { IConsoleEntry, IGitToolWindowProvider } from '../../../services/interfaces';
import { EventEmitter } from '../../mocks/vscode';

// Stub OutputChannel that records written lines and reveal calls so tests
// can assert what the Console surface emitted.
class StubOutputChannel {
  public name = 'IntelliG Git Console';
  public lines: string[] = [];
  public showCount = 0;
  public disposed = false;
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
    this.showCount++;
  }
  hide(): void {
    /* no-op */
  }
  dispose(): void {
    this.disposed = true;
  }
  /** Convenience: full channel text joined for substring assertions. */
  text(): string {
    return this.lines.join('');
  }
}

// Mock GitToolWindowProvider for testing
class MockGitToolWindowProvider implements Partial<IGitToolWindowProvider> {
  public entries: Array<Omit<IConsoleEntry, 'timestamp'>> = [];
  public refreshCount = 0;
  public clearCount = 0;

  addConsoleEntry(entry: Omit<IConsoleEntry, 'timestamp'>): void {
    this.entries.push(entry);
  }

  clearConsole(): void {
    this.entries = [];
    this.clearCount++;
  }

  refresh(): void {
    this.refreshCount++;
  }
}

// Mock GitCli for testing
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

describe('ConsoleService', () => {
  let consoleService: ConsoleService;

  beforeEach(() => {
    consoleService = new ConsoleService();
  });

  afterEach(() => {
    consoleService.dispose();
  });

  describe('constructor', () => {
    it('should create with default max entries', () => {
      const service = createConsoleService();
      assert.ok(service);
      service.dispose();
    });

    it('should create with custom max entries', () => {
      const service = createConsoleService(100);
      assert.ok(service);
      service.dispose();
    });
  });

  describe('logCommand', () => {
    it('should log a command with output', () => {
      consoleService.logCommand('git status', 'On branch main\nnothing to commit');

      const entries = consoleService.getEntries();
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].command, 'git status');
      assert.strictEqual(entries[0].output, 'On branch main\nnothing to commit');
      assert.strictEqual(entries[0].isError, false);
    });

    it('should log a command with exit code', () => {
      consoleService.logCommand('git commit -m "test"', '[main abc1234] test', 0);

      const entries = consoleService.getEntries();
      assert.strictEqual(entries[0].exitCode, 0);
      assert.strictEqual(entries[0].isError, false);
    });

    it('should mark as error when exit code is non-zero', () => {
      consoleService.logCommand('git push', 'error: failed to push', 1);

      const entries = consoleService.getEntries();
      assert.strictEqual(entries[0].exitCode, 1);
      assert.strictEqual(entries[0].isError, true);
    });

    it('should allow explicit isError override', () => {
      consoleService.logCommand('git status', 'warning message', 0, { isError: true });

      const entries = consoleService.getEntries();
      assert.strictEqual(entries[0].isError, true);
    });

    it('should add timestamp to entries', () => {
      const beforeTime = new Date();
      consoleService.logCommand('git status', 'output');
      const afterTime = new Date();

      const entries = consoleService.getEntries();
      assert.ok(entries[0].timestamp >= beforeTime);
      assert.ok(entries[0].timestamp <= afterTime);
    });

    it('should fire onDidAddEntry event', (done) => {
      const disposable = consoleService.onDidAddEntry((entry) => {
        assert.strictEqual(entry.command, 'git status');
        disposable.dispose();
        done();
      });

      consoleService.logCommand('git status', 'output');
    });

    it('should log multiple commands', () => {
      consoleService.logCommand('git status', 'output 1');
      consoleService.logCommand('git add .', 'output 2');
      consoleService.logCommand('git commit -m "test"', 'output 3');

      const entries = consoleService.getEntries();
      assert.strictEqual(entries.length, 3);
    });
  });

  describe('logError', () => {
    it('should log error with string message', () => {
      consoleService.logError('git push', 'Authentication failed');

      const entries = consoleService.getEntries();
      assert.strictEqual(entries[0].command, 'git push');
      assert.strictEqual(entries[0].output, 'Authentication failed');
      assert.strictEqual(entries[0].isError, true);
      assert.strictEqual(entries[0].exitCode, 1);
    });

    it('should log error with Error object', () => {
      const error = new Error('Network error');
      consoleService.logError('git fetch', error);

      const entries = consoleService.getEntries();
      assert.strictEqual(entries[0].output, 'Network error');
      assert.strictEqual(entries[0].isError, true);
    });
  });

  describe('clear', () => {
    it('should clear all entries', () => {
      consoleService.logCommand('git status', 'output 1');
      consoleService.logCommand('git add .', 'output 2');

      consoleService.clear();

      const entries = consoleService.getEntries();
      assert.strictEqual(entries.length, 0);
    });

    it('should fire onDidClear event', (done) => {
      consoleService.logCommand('git status', 'output');

      const disposable = consoleService.onDidClear(() => {
        disposable.dispose();
        done();
      });

      consoleService.clear();
    });
  });

  describe('getEntries', () => {
    it('should return a copy of entries', () => {
      consoleService.logCommand('git status', 'output');

      const entries1 = consoleService.getEntries();
      const entries2 = consoleService.getEntries();

      assert.notStrictEqual(entries1, entries2);
      assert.deepStrictEqual(entries1, entries2);
    });
  });

  describe('max entries limit', () => {
    it('should trim old entries when exceeding max', () => {
      const service = createConsoleService(3);

      service.logCommand('cmd1', 'output1');
      service.logCommand('cmd2', 'output2');
      service.logCommand('cmd3', 'output3');
      service.logCommand('cmd4', 'output4');

      const entries = service.getEntries();
      assert.strictEqual(entries.length, 3);
      assert.strictEqual(entries[0].command, 'cmd2');
      assert.strictEqual(entries[2].command, 'cmd4');

      service.dispose();
    });
  });

  describe('connectToGitCli', () => {
    it('should capture Git command output from GitCli', () => {
      const mockGitCli = new MockGitCli();
      consoleService.connectToGitCli(mockGitCli as unknown as GitCli);

      mockGitCli.fireCommandExecuted('git', ['status'], {
        exitCode: 0,
        stdout: 'On branch main',
        stderr: '',
        combined: 'On branch main',
      });

      const entries = consoleService.getEntries();
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].command, 'git status');
      assert.strictEqual(entries[0].output, 'On branch main');
      assert.strictEqual(entries[0].isError, false);

      mockGitCli.dispose();
    });

    it('should mark failed commands as errors', () => {
      const mockGitCli = new MockGitCli();
      consoleService.connectToGitCli(mockGitCli as unknown as GitCli);

      mockGitCli.fireCommandExecuted('git', ['push'], {
        exitCode: 1,
        stdout: '',
        stderr: 'error: failed to push',
        combined: 'error: failed to push',
      });

      const entries = consoleService.getEntries();
      assert.strictEqual(entries[0].isError, true);
      assert.strictEqual(entries[0].exitCode, 1);

      mockGitCli.dispose();
    });

    it('should capture multiple commands', () => {
      const mockGitCli = new MockGitCli();
      consoleService.connectToGitCli(mockGitCli as unknown as GitCli);

      mockGitCli.fireCommandExecuted('git', ['status'], {
        exitCode: 0,
        stdout: 'output1',
        stderr: '',
        combined: 'output1',
      });

      mockGitCli.fireCommandExecuted('git', ['add', '.'], {
        exitCode: 0,
        stdout: '',
        stderr: '',
        combined: '',
      });

      mockGitCli.fireCommandExecuted('git', ['commit', '-m', 'test'], {
        exitCode: 0,
        stdout: '[main abc1234] test',
        stderr: '',
        combined: '[main abc1234] test',
      });

      const entries = consoleService.getEntries();
      assert.strictEqual(entries.length, 3);

      mockGitCli.dispose();
    });
  });

  describe('connectToToolWindow', () => {
    it('should forward entries to GitToolWindowProvider', () => {
      const mockProvider = new MockGitToolWindowProvider();
      consoleService.connectToToolWindow(mockProvider as unknown as IGitToolWindowProvider);

      consoleService.logCommand('git status', 'On branch main');

      assert.strictEqual(mockProvider.entries.length, 1);
      assert.strictEqual(mockProvider.entries[0].command, 'git status');
    });

    it('should sync existing entries when connecting', () => {
      consoleService.logCommand('git status', 'output1');
      consoleService.logCommand('git add .', 'output2');

      const mockProvider = new MockGitToolWindowProvider();
      consoleService.connectToToolWindow(mockProvider as unknown as IGitToolWindowProvider);

      assert.strictEqual(mockProvider.entries.length, 2);
    });

    it('should clear provider when clear is called', () => {
      const mockProvider = new MockGitToolWindowProvider();
      consoleService.connectToToolWindow(mockProvider as unknown as IGitToolWindowProvider);

      consoleService.logCommand('git status', 'output');
      consoleService.clear();

      assert.strictEqual(mockProvider.clearCount, 1);
      assert.strictEqual(mockProvider.entries.length, 0);
    });
  });

  describe('showConsole', () => {
    it('should reveal the Git Console output channel', () => {
      const channel = new StubOutputChannel();
      const service = new ConsoleService(undefined, channel as unknown as vscode.OutputChannel);

      service.showConsole();

      assert.strictEqual(channel.showCount, 1);
      service.dispose();
    });

    it('should not throw when no provider connected', () => {
      // Should not throw
      consoleService.showConsole();
    });
  });

  describe('OutputChannel surface', () => {
    it('should write a timestamped command line for a logged command', () => {
      const channel = new StubOutputChannel();
      const service = new ConsoleService(undefined, channel as unknown as vscode.OutputChannel);

      service.logCommand('git status', 'On branch main');

      // IntelliJ GitVcsConsoleWriter.showCommandLine prefixes HH:mm:ss.SSS
      assert.match(channel.text(), /\d{2}:\d{2}:\d{2}\.\d{3}: git status/);
      service.dispose();
    });

    it('should write command output to the channel', () => {
      const channel = new StubOutputChannel();
      const service = new ConsoleService(undefined, channel as unknown as vscode.OutputChannel);

      service.logCommand('git status', 'On branch main\nnothing to commit');

      assert.ok(channel.text().includes('nothing to commit'));
      service.dispose();
    });

    it('should write error output for a failed command', () => {
      const channel = new StubOutputChannel();
      const service = new ConsoleService(undefined, channel as unknown as vscode.OutputChannel);

      service.logError('git push', 'error: failed to push some refs');

      assert.ok(channel.text().includes('git push'));
      assert.ok(channel.text().includes('error: failed to push some refs'));
      service.dispose();
    });

    it('should feed git commands captured from GitCli into the channel', () => {
      const channel = new StubOutputChannel();
      const service = new ConsoleService(undefined, channel as unknown as vscode.OutputChannel);
      const mockGitCli = new MockGitCli();
      service.connectToGitCli(mockGitCli as unknown as GitCli);

      mockGitCli.fireCommandExecuted('git', ['fetch', 'origin'], {
        exitCode: 0,
        stdout: 'From github.com/user/repo',
        stderr: '',
        combined: 'From github.com/user/repo',
      });

      assert.ok(channel.text().includes('git fetch origin'));
      assert.ok(channel.text().includes('From github.com/user/repo'));
      mockGitCli.dispose();
      service.dispose();
    });

    it('should write the command line and streamed data for streaming output', () => {
      const channel = new StubOutputChannel();
      const service = new ConsoleService(undefined, channel as unknown as vscode.OutputChannel);

      const handler = service.startStreaming('git clone https://example.com/repo.git');
      handler.onData("Cloning into 'repo'...\n");
      handler.onComplete(0);

      assert.ok(channel.text().includes('git clone https://example.com/repo.git'));
      assert.ok(channel.text().includes("Cloning into 'repo'..."));
      service.dispose();
    });

    it('should dispose a self-created channel on dispose', () => {
      const channel = new StubOutputChannel();
      // Inject so we can observe disposal; an injected channel is owned by
      // the caller, so ConsoleService must NOT dispose it.
      const service = new ConsoleService(undefined, channel as unknown as vscode.OutputChannel);
      service.dispose();

      assert.strictEqual(channel.disposed, false);
    });
  });

  describe('startStreaming', () => {
    it('should create a streaming handler', () => {
      const handler = consoleService.startStreaming('git clone https://example.com/repo.git');

      assert.ok(handler);
      assert.ok(typeof handler.onData === 'function');
      assert.ok(typeof handler.onComplete === 'function');
      assert.ok(typeof handler.onError === 'function');
    });

    it('should create initial entry with empty output', () => {
      consoleService.startStreaming('git clone https://example.com/repo.git');

      const entries = consoleService.getEntries();
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].command, 'git clone https://example.com/repo.git');
      assert.strictEqual(entries[0].output, '');
    });

    it('should accumulate output data', () => {
      const handler = consoleService.startStreaming('git clone');

      handler.onData("Cloning into 'repo'...\n");
      handler.onData('remote: Counting objects: 100\n');
      handler.onData('Receiving objects: 100%\n');

      const entries = consoleService.getEntries();
      assert.strictEqual(
        entries[0].output,
        "Cloning into 'repo'...\nremote: Counting objects: 100\nReceiving objects: 100%\n"
      );
    });

    it('should set exit code on complete', () => {
      const handler = consoleService.startStreaming('git clone');

      handler.onData('Done.\n');
      handler.onComplete(0);

      const entries = consoleService.getEntries();
      assert.strictEqual(entries[0].exitCode, 0);
      assert.strictEqual(entries[0].isError, false);
    });

    it('should mark as error on non-zero exit code', () => {
      const handler = consoleService.startStreaming('git clone');

      handler.onData('fatal: repository not found\n');
      handler.onComplete(128);

      const entries = consoleService.getEntries();
      assert.strictEqual(entries[0].exitCode, 128);
      assert.strictEqual(entries[0].isError, true);
    });

    it('should handle error callback', () => {
      const handler = consoleService.startStreaming('git clone');

      handler.onError(new Error('Network timeout'));

      const entries = consoleService.getEntries();
      assert.ok(entries[0].output.includes('Network timeout'));
      assert.strictEqual(entries[0].isError, true);
      assert.strictEqual(entries[0].exitCode, 1);
    });

    it('should refresh tool window on streaming updates', () => {
      const mockProvider = new MockGitToolWindowProvider();
      consoleService.connectToToolWindow(mockProvider as unknown as IGitToolWindowProvider);

      const handler = consoleService.startStreaming('git clone');
      handler.onData('output');

      assert.ok(mockProvider.refreshCount > 0);
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      consoleService.logCommand('git status', 'output');
      consoleService.dispose();

      // After dispose, getEntries should return empty
      const entries = consoleService.getEntries();
      assert.strictEqual(entries.length, 0);
    });

    it('should be safe to call multiple times', () => {
      consoleService.dispose();
      consoleService.dispose();
      // Should not throw
    });
  });

  describe('Real-time output capture', () => {
    it('should capture command and output in real-time from GitCli', () => {
      const mockGitCli = new MockGitCli();
      const mockProvider = new MockGitToolWindowProvider();

      consoleService.connectToGitCli(mockGitCli as unknown as GitCli);
      consoleService.connectToToolWindow(mockProvider as unknown as IGitToolWindowProvider);

      // Simulate a Git command execution
      mockGitCli.fireCommandExecuted('git', ['log', '--oneline', '-5'], {
        exitCode: 0,
        stdout: 'abc1234 First commit\ndef5678 Second commit',
        stderr: '',
        combined: 'abc1234 First commit\ndef5678 Second commit',
      });

      // Verify the command was captured
      const entries = consoleService.getEntries();
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].command, 'git log --oneline -5');
      assert.ok(entries[0].output.includes('First commit'));

      // Verify it was forwarded to the tool window
      assert.strictEqual(mockProvider.entries.length, 1);

      mockGitCli.dispose();
    });

    it('should display both command and output for each Git operation', () => {
      const mockGitCli = new MockGitCli();
      consoleService.connectToGitCli(mockGitCli as unknown as GitCli);

      // Simulate multiple Git operations
      mockGitCli.fireCommandExecuted('git', ['fetch', 'origin'], {
        exitCode: 0,
        stdout: 'From https://github.com/user/repo\n * branch main -> FETCH_HEAD',
        stderr: '',
        combined: 'From https://github.com/user/repo\n * branch main -> FETCH_HEAD',
      });

      mockGitCli.fireCommandExecuted('git', ['merge', 'origin/main'], {
        exitCode: 0,
        stdout: 'Already up to date.',
        stderr: '',
        combined: 'Already up to date.',
      });

      const entries = consoleService.getEntries();
      assert.strictEqual(entries.length, 2);

      // First command
      assert.strictEqual(entries[0].command, 'git fetch origin');
      assert.ok(entries[0].output.includes('FETCH_HEAD'));

      // Second command
      assert.strictEqual(entries[1].command, 'git merge origin/main');
      assert.ok(entries[1].output.includes('Already up to date'));

      mockGitCli.dispose();
    });
  });
});

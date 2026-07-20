/**
 * Unit tests for ConsoleService
 */

import '../../setup';
import * as assert from 'assert';
import type * as vscode from 'vscode';
import {
  ConsoleService,
  createConsoleService,
  capConsoleOutput,
} from '../../../src/ui-shell/ConsoleService';
import { GitCli, IGitCommandResult } from '../../../src/git-core/gitCli';
import { IConsoleEntry, IGitToolWindowProvider } from '../../../src/services/interfaces';
import { EventEmitter, window as mockWindow } from '../../mocks/vscode';

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
  public updateCount = 0;
  public clearCount = 0;

  addConsoleEntry(entry: Omit<IConsoleEntry, 'timestamp'>): void {
    this.entries.push(entry);
  }

  clearConsole(): void {
    this.entries = [];
    this.clearCount++;
  }

  updateConsoleEntry(update: {
    id: string;
    output: string;
    exitCode?: number;
    isError?: boolean;
  }): void {
    this.updateCount++;
    const entry = this.entries.find((e) => e.id === update.id);
    if (!entry) {
      return;
    }
    entry.output = update.output;
    if (update.exitCode !== undefined) {
      entry.exitCode = update.exitCode;
    }
    if (update.isError !== undefined) {
      entry.isError = update.isError;
    }
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

  get listenerCount(): number {
    return this._onCommandExecuted.listenerCount;
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
    it('registers no listener once the service is disposed', () => {
      // dispose() drains _disposables, so a subscription pushed afterwards has
      // no owner left to unregister it: the emitter would hold the retired
      // service alive for the emitter's lifetime.
      const mockGitCli = new MockGitCli();
      consoleService.dispose();

      consoleService.connectToGitCli(mockGitCli as unknown as GitCli);

      assert.strictEqual(
        mockGitCli.listenerCount,
        0,
        'a disposed service must not subscribe to the GitCli emitter'
      );

      mockGitCli.dispose();
    });

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

      // connectToToolWindow clears before replaying, so measure the delta.
      const clearsAfterConnect = mockProvider.clearCount;
      consoleService.logCommand('git status', 'output');
      consoleService.clear();

      assert.strictEqual(mockProvider.clearCount - clearsAfterConnect, 1);
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

    it('should push one coalesced entry update per window on streaming updates', async () => {
      // Not refresh(): the provider holds a snapshot copy, so a bare refresh
      // re-renders the empty output the stream started with. The targeted
      // update seam is what actually surfaces streamed bytes.
      const mockProvider = new MockGitToolWindowProvider();
      consoleService.connectToToolWindow(mockProvider as unknown as IGitToolWindowProvider);
      const before = mockProvider.updateCount;

      const handler = consoleService.startStreaming('git clone');
      handler.onData('output');
      handler.onData('more output');

      await new Promise((resolve) => setTimeout(resolve, 60));

      assert.strictEqual(
        mockProvider.updateCount - before,
        1,
        'two chunks inside one window produce a single entry update'
      );
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

/**
 * Per-entry output cap.
 *
 * gitCli allows up to 64 MiB of output and the console stored every byte, so a
 * single big diff froze the tool-window webview rendering it. IntelliJ caps a
 * console message at 10k chars, keeping a 30% head and 70% tail
 * (GitVcsConsoleWriter.MAX_CONSOLE_OUTPUT_SIZE + its chunked showMessage), and
 * only elides past 1.2x the cap so a barely-over message stays whole.
 */
describe('ConsoleService output cap', () => {
  function serviceWithEntry(output: string): IConsoleEntry {
    const service = new ConsoleService(
      1000,
      new StubOutputChannel() as unknown as vscode.OutputChannel
    );
    service.logCommand('git diff', output, 0);
    const entries = service.getEntries();
    assert.strictEqual(entries.length, 1);
    return entries[0];
  }

  it('stores a modest output verbatim', () => {
    const output = 'x'.repeat(500);

    assert.strictEqual(serviceWithEntry(output).output, output);
  });

  it('leaves an output just over the cap whole (below the elision threshold)', () => {
    const output = 'x'.repeat(11000);

    assert.strictEqual(serviceWithEntry(output).output, output);
  });

  it('caps a far-over output to roughly the limit', () => {
    const entry = serviceWithEntry('x'.repeat(5_000_000));

    assert.ok(
      entry.output.length < 11000,
      `capped output should be near the 10k limit, got ${entry.output.length}`
    );
  });

  it('keeps the head AND the tail of a capped output', () => {
    const output = `HEAD_MARKER${'x'.repeat(5_000_000)}TAIL_MARKER`;

    const entry = serviceWithEntry(output);

    assert.ok(entry.output.startsWith('HEAD_MARKER'), 'head survives');
    assert.ok(entry.output.endsWith('TAIL_MARKER'), 'tail survives');
  });

  it('states the exact number of characters elided', () => {
    const entry = serviceWithEntry('x'.repeat(5_000_000));

    // 5,000,000 in, 10,000 retained => exactly 4,990,000 dropped.
    assert.ok(
      entry.output.includes('… 4990000 characters truncated …'),
      `marker must carry the true count, got: ${entry.output.slice(2990, 3060)}`
    );
  });

  it('never splits a surrogate pair when slicing', () => {
    // Emoji are 2 code units, so a fixed code-unit cut lands mid-pair.
    const output = 'a' + '😀'.repeat(7000);

    const capped = capConsoleOutput(output);

    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(capped), 'no lone high surrogate');
    assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(capped), 'no lone low surrogate');
    assert.ok(!capped.includes('\uFFFD'), 'no replacement characters');
  });
});

describe('capConsoleOutput boundaries', () => {
  const CAP = 10000;
  const THRESHOLD = CAP * 1.2;

  it('returns an output at the elision threshold unchanged', () => {
    const output = 'x'.repeat(THRESHOLD);

    assert.strictEqual(capConsoleOutput(output), output);
  });

  it('elides one character past the threshold to an exact string', () => {
    const output = 'x'.repeat(THRESHOLD + 1);

    const capped = capConsoleOutput(output);

    // 12001 in, 3000 head + 7000 tail retained => exactly 2001 dropped.
    assert.strictEqual(
      capped,
      `${'x'.repeat(3000)}\n… 2001 characters truncated …\n${'x'.repeat(7000)}`
    );
  });

  it('retains a 30% head and a 70% tail around the marker', () => {
    const head = 'H'.repeat(3000);
    const tail = 'T'.repeat(7000);
    const output = `${head}${'x'.repeat(100_000)}${tail}`;

    const capped = capConsoleOutput(output);

    assert.ok(capped.startsWith(head), 'the 30% head is retained verbatim');
    assert.ok(capped.endsWith(tail), 'the 70% tail is retained verbatim');
    assert.match(capped, /… \d+ characters truncated …/);
  });

  it('is idempotent — capping an already-capped output changes nothing', () => {
    const capped = capConsoleOutput('x'.repeat(5_000_000));

    assert.strictEqual(capConsoleOutput(capped), capped);
  });

  it('handles an empty output', () => {
    assert.strictEqual(capConsoleOutput(''), '');
  });
});

describe('ConsoleService streaming entry identity', () => {
  const created: ConsoleService[] = [];

  afterEach(() => {
    // Every service holds a coalescing timer; leaving them pending leaks into
    // sibling suites and can keep the process alive.
    while (created.length > 0) {
      created.pop()?.dispose();
    }
  });

  function connectedService(maxEntries: number): {
    service: ConsoleService;
    provider: MockGitToolWindowProvider;
  } {
    const service = new ConsoleService(
      maxEntries,
      new StubOutputChannel() as unknown as vscode.OutputChannel
    );
    const provider = new MockGitToolWindowProvider();
    service.connectToToolWindow(provider as unknown as IGitToolWindowProvider);
    created.push(service);
    return { service, provider };
  }

  it('streams into its own entry when the entry cap has already been reached', () => {
    const { service } = connectedService(3);
    service.logCommand('git one', 'a');
    service.logCommand('git two', 'b');
    service.logCommand('git three', 'c');

    const handler = service.startStreaming('git clone');
    handler.onData('CLONE_BYTES');
    handler.onComplete(0);

    const entries = service.getEntries();
    const streamed = entries.find((e) => e.command === 'git clone');
    assert.ok(streamed, 'the streaming entry survives the trim');
    assert.strictEqual(
      streamed.output,
      'CLONE_BYTES',
      'streamed bytes land on the streaming entry'
    );
    assert.strictEqual(streamed.exitCode, 0, 'exit code stamps the streaming entry');
  });

  it('streams into its own entry when a later command trims the array beneath it', () => {
    const { service } = connectedService(2);

    const handler = service.startStreaming('git clone');
    service.logCommand('git two', 'b');
    service.logCommand('git three', 'c');

    handler.onData('CLONE_BYTES');
    handler.onComplete(0);

    const entries = service.getEntries();
    const other = entries.find((e) => e.command !== 'git clone');
    assert.ok(other, 'a non-streaming entry is present');
    assert.ok(
      !other.output.includes('CLONE_BYTES'),
      'streamed bytes must never append to an unrelated command'
    );
    assert.strictEqual(other.exitCode, undefined, 'exit code must not stamp an unrelated command');
  });

  it('does not resurrect a streaming entry after clear()', () => {
    const { service } = connectedService(10);
    const handler = service.startStreaming('git clone');
    service.clear();

    handler.onData('CLONE_BYTES');
    handler.onComplete(0);

    assert.deepStrictEqual(service.getEntries(), [], 'clear() stays cleared');
  });

  it('caps streamed output so a chatty clone cannot grow an entry without bound', () => {
    const { service } = connectedService(10);
    const handler = service.startStreaming('git clone');

    for (let i = 0; i < 50; i++) {
      handler.onData('x'.repeat(100_000));
    }

    const entry = service.getEntries()[0];
    assert.ok(
      entry.output.length < 20000,
      `streamed output must stay bounded, got ${entry.output.length}`
    );
  });

  it('caps streamed output appended via onError too', () => {
    const { service } = connectedService(10);
    const handler = service.startStreaming('git clone');

    handler.onData('x'.repeat(5_000_000));
    handler.onError(new Error('boom'));

    const entry = service.getEntries()[0];
    assert.ok(entry.output.length < 20000, 'output stays bounded after onError');
    assert.ok(entry.output.includes('boom'), 'the error reason survives at the tail');
  });

  it('delivers streamed bytes to the PROVIDER, not just to its own entry', async () => {
    // The provider stores a COPY taken when the stream started (output ''), so
    // a bare refresh() re-renders that snapshot forever. Assert the user-visible
    // side actually receives the bytes.
    const { service, provider } = connectedService(10);
    const handler = service.startStreaming('git clone');

    handler.onData('CLONE_BYTES');
    handler.onComplete(0);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const providerEntry = provider.entries.find((e) => e.command === 'git clone');
    assert.ok(providerEntry, 'the provider has the streaming entry');
    assert.ok(
      providerEntry.output.includes('CLONE_BYTES'),
      `provider output must carry the stream, got ${JSON.stringify(providerEntry.output)}`
    );
    assert.strictEqual(providerEntry.exitCode, 0, 'and the exit code');
  });

  it('delivers the failure flag to the provider when a stream exits non-zero', async () => {
    // isError is what colours the row red. It travels the same seam as the
    // bytes, so a regression that stopped propagating it would otherwise be
    // invisible to every spec here.
    const { service, provider } = connectedService(10);
    const handler = service.startStreaming('git push');

    handler.onData('rejected');
    handler.onComplete(1);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const providerEntry = provider.entries.find((e) => e.command === 'git push');
    assert.ok(providerEntry, 'the provider has the streaming entry');
    assert.strictEqual(providerEntry.isError, true, 'a failed stream must arrive flagged');
  });

  it('does not force a full data reload for a console-only stream update', async () => {
    const { service, provider } = connectedService(10);
    const refreshesBefore = provider.refreshCount;

    const handler = service.startStreaming('git clone');
    for (let i = 0; i < 50; i++) {
      handler.onData('chunk');
    }
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.strictEqual(
      provider.refreshCount,
      refreshesBefore,
      'a console-only update must not fire the provider-wide refresh'
    );
    assert.ok(provider.updateCount > 0, 'it goes through the targeted update seam instead');
  });

  it('coalesces tool-window updates across a burst of chunks', async () => {
    const { service, provider } = connectedService(10);
    const before = provider.updateCount;

    const handler = service.startStreaming('git clone');
    for (let i = 0; i < 200; i++) {
      handler.onData('chunk');
    }

    const during = provider.updateCount - before;
    assert.ok(during <= 5, `a 200-chunk burst must not update per chunk, got ${during}`);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(provider.updateCount - before > 0, 'the burst is still flushed to the tool window');
    const entry = provider.entries.find((e) => e.command === 'git clone');
    assert.ok(entry && entry.output.length > 0, 'and the flushed update carries the bytes');
  });

  it('reports the true elided total across a long stream', () => {
    const { service } = connectedService(10);
    const handler = service.startStreaming('git clone');
    for (let i = 0; i < 50; i++) {
      handler.onData('x'.repeat(100_000));
    }

    // Cross-check the streamed result against the one-shot cap over the same
    // input. A loose lower bound would let a 990k accounting error pass.
    const entry = service.getEntries()[0];
    assert.strictEqual(
      entry.output,
      capConsoleOutput('x'.repeat(50 * 100_000)),
      'a stream must land byte-identical to logging the same bytes at once'
    );
  });

  it('no path on a disposed service builds an OutputChannel or regrows entries', () => {
    // _getOutputChannel() is reachable from logCommand, logError, startStreaming,
    // showConsole and connectToToolWindow — not only the stream callbacks.
    let created = 0;
    const win = mockWindow as unknown as { createOutputChannel: unknown };
    const originalCreate = win.createOutputChannel;
    win.createOutputChannel = (): unknown => {
      created++;
      return new StubOutputChannel();
    };
    try {
      const service = new ConsoleService(
        10,
        new StubOutputChannel() as unknown as vscode.OutputChannel
      );
      const provider = new MockGitToolWindowProvider();
      service.dispose();

      service.logCommand('git status', 'out', 0);
      service.logError('git status', new Error('boom'));
      const handler = service.startStreaming('git clone');
      handler.onData('bytes');
      handler.onComplete(0);
      service.showConsole();
      service.connectToToolWindow(provider as unknown as IGitToolWindowProvider);

      assert.strictEqual(created, 0, 'a disposed service must never build an OutputChannel');
      assert.strictEqual(service.getEntries().length, 0, 'entries must not regrow after dispose');
      assert.strictEqual(provider.entries.length, 0, 'a provider must not re-attach after dispose');
    } finally {
      win.createOutputChannel = originalCreate;
    }
  });

  it('does not resurrect the output channel after dispose', () => {
    // dispose() drops the channel; a late chunk from an in-flight stream must
    // not lazily create a replacement that nothing will ever dispose.
    let created = 0;
    const win = mockWindow as unknown as { createOutputChannel: unknown };
    const originalCreate = win.createOutputChannel;
    win.createOutputChannel = (): unknown => {
      created++;
      return new StubOutputChannel();
    };
    try {
      const service = new ConsoleService(
        10,
        new StubOutputChannel() as unknown as vscode.OutputChannel
      );
      const handler = service.startStreaming('git clone');
      service.dispose();

      handler.onData('late');
      handler.onComplete(0);
      handler.onError(new Error('late failure'));

      assert.strictEqual(created, 0, 'a disposed service must not create an OutputChannel');
    } finally {
      win.createOutputChannel = originalCreate;
    }
  });

  it('ignores late streaming callbacks after dispose', () => {
    // Asserting only on getEntries() would be tautological: dispose() empties
    // them and onData never touched them. Assert the observable side effects.
    const channel = new StubOutputChannel();
    const service = new ConsoleService(10, channel as unknown as vscode.OutputChannel);
    const provider = new MockGitToolWindowProvider();
    service.connectToToolWindow(provider as unknown as IGitToolWindowProvider);
    const handler = service.startStreaming('git clone');
    const appendsBefore = channel.lines.length;
    const refreshesBefore = provider.refreshCount;
    service.dispose();

    handler.onData('late');
    handler.onComplete(0);
    handler.onError(new Error('late failure'));

    assert.strictEqual(channel.lines.length, appendsBefore, 'nothing is appended after dispose');
    assert.strictEqual(provider.refreshCount, refreshesBefore, 'no refresh is scheduled');
    assert.deepStrictEqual(service.getEntries(), []);
  });

  it('does not duplicate entries when the tool window re-registers', () => {
    const service = new ConsoleService(
      100,
      new StubOutputChannel() as unknown as vscode.OutputChannel
    );
    service.logCommand('git one', 'a');
    service.logCommand('git two', 'b');

    const provider = new MockGitToolWindowProvider();
    service.connectToToolWindow(provider as unknown as IGitToolWindowProvider);
    service.connectToToolWindow(provider as unknown as IGitToolWindowProvider);

    assert.strictEqual(provider.entries.length, 2, 're-registration replays each entry once');
  });

  /**
   * Three mechanisms that behaved correctly but that no case would have
   * noticed losing. `_head` was pinned and its `_tail` twin was not, on a
   * symmetric pair six lines apart — the shape most likely to rot.
   */
  it('keeps the NEWEST output visible once a long stream starts eliding', () => {
    // Emptying the tail leaves the start of a clone and the elision marker,
    // with progress and errors silently gone: the half a user is reading.
    const { service } = connectedService(10);
    const handler = service.startStreaming('git clone');

    // ONE chunk that trips elision. A second chunk would rebuild the tail from
    // `_tail + text` and mask an emptied initial slice.
    handler.onData('HEADMARK' + 'x'.repeat(500_000) + 'TAILMARK');

    const output = service.getEntries()[0].output;
    assert.ok(output.includes('TAILMARK'), 'the newest output must survive elision');
    assert.ok(output.includes('HEADMARK'), 'and the head is kept as well');
  });

  it('gives concurrent streams distinct entry ids', () => {
    // Ids key the pending-update map. Duplicates make two live git commands
    // overwrite each other's output.
    const { service } = connectedService(10);
    service.startStreaming('git fetch');
    service.startStreaming('git clone');

    const ids = service.getEntries().map((e) => e.id);
    assert.strictEqual(new Set(ids).size, ids.length, `ids must be distinct, got ${ids.join()}`);
  });

  it('posts one provider update for a burst of chunks', async () => {
    // The per-entry map is what bounds this: it is drained once, so a burst
    // lands as a single update. The `_pendingRefresh` early return bounds the
    // number of TIMERS rather than the number of updates, and is therefore not
    // observable here — removing it leaves this count at 1. Pinning the
    // observable invariant, not that guard.
    const { service, provider } = connectedService(10);
    const handler = service.startStreaming('git clone');

    for (let i = 0; i < 50; i++) {
      handler.onData(`chunk ${i}\n`);
    }
    // Count AFTER the timers drain: without the coalesce each chunk schedules
    // its own timer, so the updates arrive late rather than during the burst.
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.ok(
      provider.updateCount <= 2,
      `50 chunks must coalesce, got ${provider.updateCount} updates`
    );
    assert.ok(provider.updateCount > 0, 'and the coalesced update must still arrive');
  });
});

/**
 * TL-41 — unit tests for the `safeFireAndForget` OutputChannel routing.
 *
 * Covers the two guarantees callers rely on:
 *   1. Default path (no options) — rejection lands in `console.error` only.
 *   2. Opt-in path (`options.outputChannel` set) — rejection ALSO lands in
 *      the caller-supplied OutputChannel via `appendLine`, with the same
 *      `[intellig] <context>: ...` tag + a full stringified error.
 *
 * The helper is fire-and-forget so we drive it through a microtask flush
 * (`await Promise.resolve()` twice) to let the `.catch` handler run before
 * we assert.
 */

import '../../../test/setup';
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { safeFireAndForget } from '../../../utils/safeFireAndForget';

/**
 * Minimal OutputChannel stub that captures every `appendLine` call. Matches
 * the shape of `vscode.OutputChannel` without pulling the mock module.
 */
function makeCapturingOutputChannel(): vscode.OutputChannel & { _lines: string[] } {
  const lines: string[] = [];
  const channel = {
    name: 'test',
    _lines: lines,
    append(value: string): void {
      lines.push(value);
    },
    appendLine(value: string): void {
      lines.push(value);
    },
    clear(): void {
      lines.length = 0;
    },
    show(): void {
      /* no-op */
    },
    hide(): void {
      /* no-op */
    },
    dispose(): void {
      /* no-op */
    },
    replace(value: string): void {
      lines.length = 0;
      lines.push(value);
    },
  } as unknown as vscode.OutputChannel & { _lines: string[] };
  return channel;
}

/**
 * Flush two microtask ticks so the promise chain in `safeFireAndForget`
 * completes. `Promise.resolve(promise)` introduces one turn; the `.catch`
 * handler runs on the next.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('safeFireAndForget — OutputChannel routing', () => {
  let errorLogs: unknown[][];
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    errorLogs = [];
    originalConsoleError = console.error;
    console.error = (...args: unknown[]): void => {
      errorLogs.push(args);
    };
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  it('logs to console.error only when options.outputChannel is not set', async () => {
    const err = new Error('boom');
    safeFireAndForget(Promise.reject(err), 'TestClass.method: context');
    await flushMicrotasks();

    assert.strictEqual(errorLogs.length, 1, 'expected one console.error call');
    assert.strictEqual(
      errorLogs[0][0],
      '[intellig] TestClass.method: context:',
      'console.error tag should match the canonical prefix'
    );
    assert.strictEqual(errorLogs[0][1], err, 'console.error should receive the raw Error');
  });

  it('mirrors rejection into options.outputChannel via appendLine', async () => {
    const channel = makeCapturingOutputChannel();
    const err = new Error('watcher-write-failed');
    safeFireAndForget(Promise.reject(err), 'GitService.watcher: refresh', {
      outputChannel: channel,
    });
    await flushMicrotasks();

    assert.strictEqual(errorLogs.length, 1, 'console.error still fires in parallel');
    assert.strictEqual(channel._lines.length, 1, 'expected exactly one appendLine call');
    const line = channel._lines[0];
    assert.ok(
      line.includes('[intellig] GitService.watcher: refresh:'),
      `expected canonical tag in channel line: ${line}`
    );
    assert.ok(
      line.includes('watcher-write-failed'),
      `expected error message in channel line: ${line}`
    );
    assert.ok(
      /\[\d{4}-\d{2}-\d{2}T/.test(line),
      `expected ISO timestamp prefix in channel line: ${line}`
    );
  });

  it('stringifies non-Error rejections into the OutputChannel line', async () => {
    const channel = makeCapturingOutputChannel();
    safeFireAndForget(Promise.reject('plain string reason'), 'TestClass.method: context', {
      outputChannel: channel,
    });
    await flushMicrotasks();

    assert.strictEqual(channel._lines.length, 1);
    assert.ok(
      channel._lines[0].includes('plain string reason'),
      `expected raw string to land in channel: ${channel._lines[0]}`
    );
  });

  it('does not fire appendLine when the promise resolves successfully', async () => {
    const channel = makeCapturingOutputChannel();
    safeFireAndForget(Promise.resolve(), 'TestClass.method: success', {
      outputChannel: channel,
    });
    await flushMicrotasks();

    assert.strictEqual(channel._lines.length, 0, 'no log on success');
    assert.strictEqual(errorLogs.length, 0, 'no console.error on success');
  });

  it('includes the stack trace in the channel line when the error has one', async () => {
    const channel = makeCapturingOutputChannel();
    const err = new Error('with-stack');
    safeFireAndForget(Promise.reject(err), 'TestClass.method: context', {
      outputChannel: channel,
    });
    await flushMicrotasks();

    assert.strictEqual(channel._lines.length, 1);
    // V8 stack lines start with `    at `. The rendered channel line should
    // contain at least one such frame when the Error was created normally.
    assert.ok(
      channel._lines[0].includes('\n    at '),
      `expected stack frames in channel line: ${channel._lines[0]}`
    );
  });
});

/**
 * TL-58 (Cluster C) — TestSurface idiom rename for the OutputChannel
 * singleton's test-only reset.
 *
 * Pre-rename, `disposeOutputChannel()` was the public name of a function
 * documented as "test-only" but lacking the project's TestSurface idiom
 * (`__*ForTest` prefix; see docs/testing.md §3). The mismatch made the
 * function look like a normal disposal hook and invited production
 * callers to drop the cached channel mid-flight.
 *
 * Post-rename, `__resetOutputChannelForTest()` carries the contract in
 * its name. This spec pins (a) the new export exists and is callable,
 * and (b) the old export name is gone — a future revival of the old
 * name would silently re-introduce the smell.
 */

import '../../setup';
import * as assert from 'assert';
import * as outputChannelModule from '../../../utils/outputChannel';

describe('outputChannel — TestSurface rename (TL-58)', () => {
  it('exports __resetOutputChannelForTest as a callable function', () => {
    const mod = outputChannelModule as unknown as Record<string, unknown>;
    assert.strictEqual(
      typeof mod.__resetOutputChannelForTest,
      'function',
      '__resetOutputChannelForTest must be exported as a function (TestSurface idiom)'
    );
  });

  it('does not export the legacy disposeOutputChannel name', () => {
    const mod = outputChannelModule as unknown as Record<string, unknown>;
    assert.strictEqual(
      mod.disposeOutputChannel,
      undefined,
      'disposeOutputChannel was renamed to __resetOutputChannelForTest; the old name must not be re-exported'
    );
  });

  it('drops the cached channel so the next getOutputChannel() creates a fresh instance', () => {
    const { getOutputChannel } = outputChannelModule;
    const mod = outputChannelModule as unknown as {
      __resetOutputChannelForTest: () => void;
    };

    const first = getOutputChannel();
    mod.__resetOutputChannelForTest();
    const second = getOutputChannel();

    // Identity check: same module-level singleton is replaced, so the
    // post-reset call must hand back a fresh instance.
    assert.notStrictEqual(
      first,
      second,
      '__resetOutputChannelForTest must drop the cache so the next get() creates a fresh channel'
    );

    // Clean up to avoid leaking the second channel into other suites.
    mod.__resetOutputChannelForTest();
  });
});

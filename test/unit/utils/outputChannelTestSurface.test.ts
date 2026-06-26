/**
 * TestSurface idiom for the OutputChannel singleton's test-only reset.
 *
 * `__resetOutputChannelForTest()` carries the test-only contract in its name
 * (the `__*ForTest` prefix; see docs/testing.md section 3), so it can't be
 * mistaken for a normal disposal hook that a production caller might use to
 * drop the cached channel mid-flight. This spec pins (a) the export exists and
 * is callable, and (b) no `disposeOutputChannel`-style public name exists —
 * reviving one would silently re-introduce the smell.
 */

import '../../setup';
import * as assert from 'assert';
import * as outputChannelModule from '../../../src/utils/outputChannel';

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

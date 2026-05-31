/**
 * Smoke test 9 — Logger activation invariants.
 *
 * Pins three contracts about the structured Logger's behaviour at
 * `activate()` time, observed inside the real Extension Host:
 *
 *   (a) `activate()` adds <5ms to the post-activate-idle gate budget
 *       — i.e. the Logger's emission cost during activation does NOT
 *       inflate the activation path beyond the slack the
 *       `07.post-activate-idle.test.ts` gate already tolerates
 *       (Requirement 7.5).
 *
 *   (b) The `IntelliG` `vscode.OutputChannel` singleton exists
 *       post-activate. The Logger's `OutputChannelSink` borrows this
 *       channel from `initOutputChannel(context)` (Requirement 3.1,
 *       3.5); a missing channel means either `initOutputChannel` was
 *       skipped or the sink was registered against the wrong target.
 *
 *   (c) The Logger has registered an active sink. We prove
 *       registration by intercepting `appendLine` on the shared
 *       `IntelliG` channel, emitting a marker record via
 *       `getLogger().info(...)`, and asserting the marker reached
 *       the channel (Requirement 8.2 — `initLogger(context)` pushes
 *       the OutputChannel sink onto `context.subscriptions` and
 *       attaches it to the Logger). If the Logger were not
 *       registered, the marker would land nowhere — the test
 *       captures real signal.
 *
 * Why these checks are not redundant with the unit tests:
 *   The unit tests in `src/test/unit/utils/logger/` exercise the
 *   Logger against the `vscode.workspace` mock and a stub
 *   `ExtensionContext`. They cannot prove the production
 *   `extension.ts` activate path actually wired the Logger to the
 *   real channel — which is what this suite catches. A regression
 *   that swapped the order of `initOutputChannel(context)` and
 *   `initLogger(context)` (or omitted one entirely) would pass every
 *   unit test and fail here.
 *
 * Failure-mode notes:
 *   - The marker capture monkey-patches `appendLine` on the live
 *     OutputChannel instance. We restore the original method in the
 *     test's `finally` so subsequent specs are not polluted.
 *   - The activation-overhead probe runs a representative burst of
 *     `info`-level records through the live Logger and asserts the
 *     wall-clock cost stays under the per-activation budget. The
 *     burst size (40 records) is generous compared to the actual
 *     activation path's emission count (the production
 *     `activate()` path emits ~3 root records plus per-service
 *     constructor records, well under 40 today), so the budget has
 *     slack for service growth.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

import { getLogger } from '../../../utils/logger';
import { getOutputChannel } from '../../../utils/outputChannel';

const EXT_ID = 'KaHoChan.intellig';

/**
 * Per-activation budget for Logger emissions (Requirement 7.5).
 * The number is the absolute ceiling on wall-clock cost contributed
 * by the Logger across the entire activation path.
 */
const ACTIVATION_LOGGER_BUDGET_MS = 5;

/**
 * Representative count of activation-time log emissions. Production
 * `activate()` plus current service constructors emit far fewer than
 * this; the over-estimate gives the budget slack for service growth.
 */
const ACTIVATION_BURST_RECORDS = 40;

describe('ext-host smoke — 9. logger activation', function () {
  this.timeout(30_000);

  before(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not installed`);
    await ext.activate();
  });

  it('IntelliG OutputChannel exists post-activate', () => {
    // `getOutputChannel()` is the singleton accessor the
    // `OutputChannelSink` uses. Calling it post-activate must return
    // the cached channel created by `initOutputChannel(context)`
    // during `activate()`. A missing or replaced channel here would
    // mean either `initOutputChannel` was skipped, the singleton was
    // disposed mid-activation, or the cache was leaked across the
    // host boundary in a way that breaks the sink wiring.
    const channel = getOutputChannel();
    assert.ok(channel, 'getOutputChannel() returned no channel post-activate');

    // The `OutputChannel` API surface the sink relies on. Assert the
    // method is callable so a future fake-channel regression (e.g. a
    // mock leak from a unit test) surfaces with a meaningful error.
    assert.strictEqual(
      typeof channel.appendLine,
      'function',
      'channel.appendLine is not callable — channel object shape is wrong'
    );

    // The channel is named `IntelliG` (see `src/utils/outputChannel.ts`).
    // The VS Code public API does not expose `.name` on every host
    // version, so we guard the assertion behind a presence check.
    if (typeof (channel as { name?: unknown }).name === 'string') {
      assert.strictEqual(
        (channel as { name: string }).name,
        'IntelliG',
        'OutputChannel name drifted from the documented "IntelliG" singleton'
      );
    }
  });

  it('Logger is registered post-activate (marker record reaches OutputChannel sink)', () => {
    // Intercept `appendLine` on the live channel. Every record the
    // Logger emits at admitted levels flows through `formatRecord`
    // and lands in the channel via this method, so capturing here
    // proves the OutputChannelSink is actually attached to the
    // Logger AND backed by the same channel singleton.
    //
    // Failure modes the capture catches:
    //   - `initLogger(context)` skipped → `_sinks` is empty,
    //     `getLogger().info(...)` falls into the no-allocation fast
    //     path, marker never reaches the channel.
    //   - `OutputChannelSink` constructed but never appended to
    //     `_sinks` → same outcome.
    //   - `OutputChannelSink` attached to a DIFFERENT channel
    //     (regression where someone called
    //     `vscode.window.createOutputChannel('IntelliG')` directly,
    //     producing a fresh instance rather than the singleton) →
    //     marker reaches a channel, but not THIS one, so the
    //     capture array stays empty.
    const channel = getOutputChannel();
    const captured: string[] = [];
    const originalAppendLine = channel.appendLine.bind(channel);
    let appendLineHook: ((line: string) => void) | undefined;
    try {
      appendLineHook = (line: string): void => {
        captured.push(line);
        originalAppendLine(line);
      };
      // Replace via direct property assignment. `OutputChannel` is a
      // plain object on the host side; the sink calls
      // `getOutputChannel().appendLine(...)` afresh per emission so
      // the override is observed on the next call.
      (channel as unknown as { appendLine: (line: string) => void }).appendLine = appendLineHook;

      // Emit the marker. We embed a unique random-ish substring so a
      // coincidental log line from elsewhere in the host (e.g.
      // another suite's late emission) cannot satisfy the assertion.
      const marker = `LOGGER-ACTIVATION-MARKER-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      getLogger().info(marker, { source: 'ext-host-09-logger-activation' });

      const matches = captured.filter((line) => line.includes(marker));
      assert.ok(
        matches.length > 0,
        `Logger marker did not reach the IntelliG OutputChannel — Logger is not registered. ` +
          `Captured ${captured.length} appendLine call(s); none contained the marker "${marker}". ` +
          `Either initLogger(context) was skipped, OutputChannelSink is not in _sinks, or the sink ` +
          `is attached to a non-singleton channel.`
      );

      // Sanity-check the rendered shape so a future grammar
      // regression (e.g. dropped `INFO` level token) surfaces here
      // rather than in the property tests.
      const matchedLine = matches[0];
      assert.ok(
        matchedLine.includes('INFO'),
        `Captured marker line missing 'INFO' level token: ${JSON.stringify(matchedLine)}`
      );
      assert.ok(
        matchedLine.includes('root'),
        `Captured marker line missing 'root' component (default for getLogger() with no child): ${JSON.stringify(matchedLine)}`
      );
    } finally {
      // Restore the original method. Skipping this would pollute
      // every subsequent ext-host spec sharing this channel.
      (channel as unknown as { appendLine: (line: string) => void }).appendLine =
        originalAppendLine;
    }
  });

  it('Logger emission cost during activation stays under the 5ms budget (Requirement 7.5)', () => {
    // The post-activate-idle invariant gate (07.*) measures git-spawn
    // count during a 5s idle window — the Logger does NOT contribute
    // git spawns. The complementary contract pinned here is the
    // activation-PATH cost: the Logger's wall-clock contribution to
    // `activate()` must stay under 5ms total.
    //
    // We measure by running a representative burst of `info`-level
    // emissions through the live root Logger. Production
    // `activate()` emits a small handful of records (extension
    // activating, extension activated, plus one info per service
    // constructor that emits during its own ctor — currently a
    // single-digit count). The burst size (40) over-estimates that
    // count, so passing this test under 5ms also covers the
    // production path with slack for service growth.
    //
    // We do not reset/re-init the Logger here: the goal is to
    // measure the ALREADY-activated path's per-record cost, not the
    // initialization cost. `initLogger(context)` runs once during
    // host startup and is amortized away.
    const logger = getLogger();

    // Warm-up call: ensures any first-call path (lazy resolver
    // construction, JIT pinning) is paid before the timed loop. The
    // production activation also pays warm-up once at its first
    // `getLogger().info(...)` call, but the budget covers steady-state
    // — we time a representative burst, not the very first record
    // alone.
    logger.info('logger-activation-warmup');

    const startNs = process.hrtime.bigint();
    for (let i = 0; i < ACTIVATION_BURST_RECORDS; i++) {
      logger.info('activation-budget-probe', { iter: i });
    }
    const elapsedNs = process.hrtime.bigint() - startNs;
    const elapsedMs = Number(elapsedNs) / 1_000_000;

    // Observability: log the measurement either way so reviewers can
    // see headroom in CI logs and retune the burst size if the
    // production emission count grows past it.
    // eslint-disable-next-line no-console
    console.log(
      `[logger activation budget] ${ACTIVATION_BURST_RECORDS} info records emitted in ` +
        `${elapsedMs.toFixed(3)}ms (budget: ${ACTIVATION_LOGGER_BUDGET_MS}ms)`
    );

    assert.ok(
      elapsedMs < ACTIVATION_LOGGER_BUDGET_MS,
      `Logger emission cost exceeds the per-activation budget: ` +
        `${elapsedMs.toFixed(3)}ms over ${ACTIVATION_BURST_RECORDS} info records ` +
        `(budget ${ACTIVATION_LOGGER_BUDGET_MS}ms). ` +
        `Requirement 7.5 caps activation overhead at ${ACTIVATION_LOGGER_BUDGET_MS}ms; ` +
        `something on the hot path is allocating or sanitizing more than expected.`
    );
  });
});

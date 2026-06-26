/**
 * Tier-2 E2E — Logger correlation-id smoke.
 *
 * Pins three contracts about the structured Logger's correlation-id
 * propagation, observed inside the real Extension Host against a real
 * git fixture:
 *
 *   (a) `registerLoggedCommand` establishes a correlation frame at
 * command-handler entry. The frame's
 *       `correlationId` is generated via
 *       `crypto.randomBytes(8).toString('hex')`, which yields a 16-char
 *       lowercase-hex string.
 *
 *   (b) Records emitted by services called from inside the handler —
 *       in particular the two info-level records emitted by
 *       `GitService.reloadRepository` (`'reloadRepository entry'` /
 *       `'reloadRepository exit'`) — carry the current frame's
 *       `correlationId` in the rendered OutputChannel block via the
 * `cid=<hex>` continuation line (+ the
 *       OutputChannel grammar in `render.ts`).
 *
 *   (c) Two consecutive command invocations establish two **distinct**
 *       correlation frames, so the rendered `cid=` values across the
 * two invocations must differ (non-fabrication
 * implies a fresh id per frame; — fresh id at
 *       handler entry).
 *
 * ### Choice of triggered command
 *
 * `intellig.fetch` is used because its handler explicitly `await`s
 * `gitService.reloadRepository(repo)` inline. `reloadRepository`
 * unconditionally emits two info-level records bound to the
 * `'GitService'` child component — one at entry, one at exit — both of
 * which sit inside the active correlation frame because the handler is
 * async and `AsyncLocalStorage` propagates the frame across the
 * intervening `await`s (per the Logger design).
 *
 * `intellig.refresh` would also satisfy the contract via the
 * `onDidRequestRefresh` → `loadAllPanelData` async cascade, but its
 * log-record emission depends on whether the cascade reaches a service
 * method that emits info-level (none of the loaders do today). Picking
 * `intellig.fetch` keeps the test independent of which downstream
 * services happen to log — `reloadRepository` is the canonical
 * waypoint.
 *
 * The fixture is built with `withRemote: true` (matching
 * `04.remote.test.ts`) so the `file://` origin lets `git fetch`
 * succeed without network. With a clean fetch the handler reaches
 * `reloadRepository` deterministically.
 *
 * ### Capture mechanism
 *
 * The Logger's `OutputChannelSink` calls
 * `getOutputChannel().appendLine(block)` once per emitted record (one
 * block per record, terminated by newline). We
 * monkey-patch `appendLine` on the live `IntelliG` channel for the
 * duration of the test and restore it in `finally`. This is the same
 * harness pattern used by `09.logger-activation.test.ts` in the
 * ext-host suite; the `OutputChannel` exposed to the host is a plain
 * object whose method can be reassigned, and the sink reads
 * `getOutputChannel()` afresh per emit so the override is observed on
 * the next call.
 *
 * ### Failure-mode notes
 *
 * - If `registerLoggedCommand` were ever swapped for the bare
 *   `vscode.commands.registerCommand`, `getCurrentCorrelationId()`
 *   would return `undefined` for emissions during the handler,
 *   `formatRecord` would omit the `cid=` line entirely, and this test
 *   would fail with "no cid lines captured".
 *
 * - If `crypto.randomBytes(8).toString('hex')` were replaced with a
 *   shorter or different encoding (e.g. base64 → 12 chars), the
 *   16-char hex regex would reject every cid and surface the change
 *   as a clear assertion failure.
 *
 * - If two invocations somehow shared a correlation id (e.g. a
 *   regression that cached the id at registration time instead of
 *   generating one per call), the distinct-cids assertion catches it.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

import { getOutputChannel } from '../support/activatedExtension';

import { createFixtureRepo, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspace, clearWorkspace } from '../support/workspaceHelper';

/**
 * Matches a complete 16-char lowercase-hex correlation id as produced
 * by `crypto.randomBytes(8).toString('hex')`. Anchored on both sides so
 * a partial match (e.g. a longer string with a hex prefix) fails the
 * format check.
 */
const HEX16 = /^[0-9a-f]{16}$/;

/**
 * Matches a single `cid=<value>` continuation line in a rendered
 * record block. The two-space indent is the `CONTINUATION_INDENT`
 * constant from `src/utils/logger/render.ts`. Anchored to line start
 * via `^` (multiline-aware via the per-line iteration below); does not
 * anchor the value side because we want to surface a malformed cid as
 * a typed-format failure rather than as a "no match" failure.
 */
const CID_LINE_RE = /^ {2}cid=(.+)$/;

/**
 * Extract every cid value from a captured rendered-block array. Each
 * entry in `blocks` is one full multi-line block as written to the
 * OutputChannel via `appendLine`. A block carries at most one `cid=`
 * line (per the rendering grammar in `render.ts`), but we iterate
 * line-by-line in case a future grammar evolution adds more.
 */
function extractCids(blocks: readonly string[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      const match = CID_LINE_RE.exec(line);
      if (match) {
        out.push(match[1]);
      }
    }
  }
  return out;
}

describe('e2e — Logger correlation-id smoke', function () {
  // 30s budget covers fixture creation (git init + commits + bare-remote
  // push), two end-to-end fetch invocations, and a generous margin on a
  // cold dev machine. The Tier-2 default (15s) leaves no slack here.
  this.timeout(30_000);

  let fix: Fixture;
  let stubs: PromptStubs;

  beforeEach(async () => {
    fix = await createFixtureRepo({ commits: 2, withRemote: true });
    await useFixtureWorkspace(fix.rootPath);
    stubs = stubPrompts({});
  });

  afterEach(async () => {
    if (stubs) {
      stubs.restore();
    }
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  it('emits cid= lines whose values are 16-char hex and differ across invocations', async () => {
    const channel = getOutputChannel();
    const captured: string[] = [];
    const originalAppendLine = channel.appendLine.bind(channel);
    try {
      // Replace via direct property assignment — same pattern as
      // 09.logger-activation.test.ts. The OutputChannel surface VS
      // Code hands back is a plain object whose method is reassignable;
      // the OutputChannelSink calls `getOutputChannel().appendLine(...)`
      // afresh per emit so the override is observed on the next call.
      (channel as unknown as { appendLine: (line: string) => void }).appendLine = (
        line: string
      ): void => {
        captured.push(line);
        originalAppendLine(line);
      };

      // Two consecutive invocations of the same command. Each
      // `executeCommand` enters `registerLoggedCommand`'s wrapper,
      // which generates a fresh correlationId via
      // `crypto.randomBytes(8).toString('hex')` and binds it to the
      // AsyncLocalStorage frame for the duration of the handler.
      // Inside the handler, `await gitService.reloadRepository(repo)`
      // emits two info-level records carrying the active cid.
      await vscode.commands.executeCommand('intellig.fetch');
      await vscode.commands.executeCommand('intellig.fetch');
    } finally {
      // Restore so subsequent specs (and the ambient host) see the
      // original method. Skipping this would pollute every later spec
      // sharing this channel.
      (channel as unknown as { appendLine: (line: string) => void }).appendLine =
        originalAppendLine;
    }

    const cids = extractCids(captured);

    // (1) At least one record produced during the test carries a
    // `cid=` continuation line. If this fails, either
    // `registerLoggedCommand` is not establishing a frame, or
    // no service emitted an info-level record while inside the
    // handler — both of which are regressions.
    assert.ok(
      cids.length > 0,
      `expected at least one cid= line across two intellig.fetch invocations, ` +
        `got 0 across ${captured.length} captured block(s). ` +
        `Either registerLoggedCommand is not establishing a correlation frame, ` +
        `or no admitted record was emitted from inside the handler.`
    );

    // (2) Every cid is exactly 16 lowercase-hex characters. Drift here
    // (e.g. truncation, base64 encoding, uppercase) surfaces as a
    // clear typed-format failure.
    for (const cid of cids) {
      assert.ok(
        HEX16.test(cid),
        `cid value is not a 16-char lowercase-hex string: ${JSON.stringify(cid)}. ` +
          `Expected /^[0-9a-f]{16}$/ (the format produced by ` +
          `crypto.randomBytes(8).toString('hex')).`
      );
    }

    // (3) Two consecutive command invocations produce at least two
    // distinct cid values. A regression that fabricates the id at
    // module-init time, or caches it across invocations, would
    // collapse the captured set to a single value here.
    const distinct = new Set(cids);
    assert.ok(
      distinct.size >= 2,
      `expected at least 2 distinct cid values across two consecutive command ` +
        `invocations; got ${distinct.size} distinct value(s) across ${cids.length} ` +
        `cid line(s): ${JSON.stringify([...distinct])}. ` +
        `Each registerLoggedCommand invocation must generate a fresh ` +
        `correlationId.`
    );
  });
});

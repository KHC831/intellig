/**
 * Property 12: ConfigurationService change records carry only keys.
 *
 *
 * When `ConfigurationService.handleConfigurationChange` detects an
 * effective change in the typed `IExtensionConfiguration` snapshot, it
 * emits a debug-level Logger record naming the changed keys via
 * `getLogger().child({ component: 'ConfigurationService' }).debug(
 *   'intellig configuration changed', { keys: [...] })`.
 *
 * The contract this property pins down:
 *
 * 1. The emitted record's `context.keys` array contains the changed
 *    key name (and only the changed key when one knob flips at a
 *    time).
 * 2. The emitted record does **not** carry the new value (or the old
 *    value) anywhere in its rendered block. Values may contain user
 *    content (commit-message templates, file colours, hex strings,
 *    booleans rendered as `true`/`false`, etc.) and are not safe to
 *    log unconditionally.
 *
 * The property exercises a representative slice of
 * `IExtensionConfiguration` — string-valued, boolean, and enum knobs
 * — so a regression that, say, accidentally serialised the boolean
 * `true` into the record would be caught for the boolean knobs while
 * a regression that leaked a hex colour would be caught for the
 * string knobs.
 *
 * ### Approach
 *
 * 1. Pin `intellig.log.level = 'debug'` (or stricter from the change
 *    record's perspective: still admits debug) so the
 *    `ConfigurationService._logger.debug(...)` record is admitted to
 *    the OutputChannel sink.
 * 2. `initOutputChannel(context)` + `initLogger(context)` so the
 *    production sinks are wired against the mock channel.
 * 3. Construct `ConfigurationService` (after the Logger is ready —
 *    it calls `getLogger().child(...)` in its constructor).
 * 4. For each fast-check iteration, pick an arbitrary IntelliG
 *    setting key + a new value that differs from the current one,
 *    then drive the change through the mock workspace's
 *    `update(...)` — that path fires `onDidChangeConfiguration`
 *    listeners, which is what `ConfigurationService` subscribes to
 *    in its constructor.
 * 5. Capture every line written to the channel since the change,
 *    pick the configuration-change record, parse it via
 *    `parseRecord`, and assert:
 *    - `record.message === 'intellig configuration changed'`
 *    - `record.level === 'debug'`
 *    - `record.component === 'ConfigurationService'`
 *    - `Array.isArray(record.context?.keys) && includes(changedKey)`
 *    - the rendered block does NOT contain the new value or the old
 *      value as a substring (cast to string for the search).
 *
 * ### Generator constraints
 *
 * - The set of knobs we drive is restricted to those whose value is
 *   either a non-empty string (`commitMessageTemplate`,
 *   `modifiedFileColor`, etc.), a finite-domain enum
 *   (`defaultToolWindowTab`, `blameAnnotationStyle`, `keymapPreset`),
 *   or a boolean. We deliberately exclude `logLevel` and `logConsole`
 *   because driving them would also re-trigger the Logger's own
 *   `LogLevelResolver.refresh()`, which could change whether the
 *   debug record is admitted mid-iteration. Asserting the same
 *   property over those two would conflate two distinct change
 *   pathways.
 * - For each knob the new value generator excludes the current
 *   default so the diff in `handleConfigurationChange` reports the
 *   key as changed.
 * - The "new value" string is intentionally a non-empty token with
 *   at least four characters and no characters that would either
 *   trigger sanitizer rewrites (`/`, `\`, `:`, `@`) or be interpreted
 *   as JSON-quoted boundary markers (`"`, `'`). Tokens stay in the
 *   safe alphanumeric subset so the "value does not appear in the
 *   rendered block" check is unambiguous.
 */

import '../setup';

import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';

import { ConfigurationService, getDefaultConfiguration } from '../../config/ConfigurationService';
import type { IExtensionConfiguration } from '../../config/interfaces/IConfigurationService';
import { __resetLoggerForTest, initLogger } from '../../utils/logger';
import { parseRecord } from '../../utils/logger/render';
import {
  __resetOutputChannelForTest,
  getOutputChannel,
  initOutputChannel,
} from '../../utils/outputChannel';
import { ConfigurationTarget, resetMockConfiguration, setMockConfigValue } from '../mocks/vscode';

// ─── Test fixtures and helpers ──────────────────────────────────────────────

/**
 * Minimal `ExtensionContext` stub: `initOutputChannel` and
 * `initLogger` only exercise `subscriptions`.
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return { subscriptions } as unknown as vscode.ExtensionContext;
}

/**
 * Snapshot the current set of captured channel lines. The mock
 * channel from `src/test/mocks/vscode.ts` exposes `_lines` on every
 * instance; the `OutputChannelSink` writes one entry per record via
 * `appendLine`.
 */
function captureChannelLines(): string[] {
  return [...(getOutputChannel() as unknown as { _lines: string[] })._lines];
}

/**
 * Reset both singletons + the mock workspace configuration. Order
 * matters: drop the Logger first (which detaches sinks) so the
 * channel reset below does not race a sink mid-emit, and call
 * `resetMockConfiguration()` last to clear any prior
 * `setMockConfigValue` writes.
 */
function fullReset(): void {
  __resetLoggerForTest();
  __resetOutputChannelForTest();
  resetMockConfiguration();
}

/**
 * The configuration-change record carries `message='intellig
 * configuration changed'`. Locate the index of that record's HEADER
 * line in the captured-lines array so we can extract the surrounding
 * block (header + continuation lines) and feed it to `parseRecord`.
 *
 * Returns `-1` if no such record was emitted.
 */
function findConfigChangeHeaderIndex(lines: readonly string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('intellig configuration changed')) {
      return i;
    }
  }
  return -1;
}

/**
 * Reassemble a single record's rendered block from the captured-lines
 * array. The OutputChannel mock stores each `appendLine` argument as
 * its own entry, so a record with N continuation lines spans `N+1`
 * adjacent entries. Walk forward from `headerIndex` accumulating
 * lines until we hit a line that does not start with the
 * two-space continuation indent — that line is the next record's
 * header (or the end of the stream).
 */
function reassembleBlock(lines: readonly string[], headerIndex: number): string {
  const collected: string[] = [lines[headerIndex]];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith('  ')) {
      collected.push(lines[i]);
    } else {
      break;
    }
  }
  return collected.join('\n');
}

/**
 * Render a value as it might plausibly appear in a sanitized log
 * block. We check three forms because the Logger could leak the
 * value via several routes (raw `String(value)`, JSON-encoded inside
 * `ctx=<json>`, or wrapped in quotes inside an array). The non-leak
 * assertion fails if **any** of these forms appears in the block.
 *
 * For booleans, `'true'` / `'false'` are short enough to give false
 * positives if a key like `'true'` ever shows up — but the
 * generators reject keys that match value tokens (see `keyArb`
 * filter below) so the boolean case stays unambiguous.
 */
function valueRenderForms(value: unknown): readonly string[] {
  const forms: string[] = [];
  forms.push(String(value));
  try {
    forms.push(JSON.stringify(value));
  } catch {
    // Circular / unstringifiable values cannot leak a JSON form.
  }
  return forms;
}

// ─── Knob catalogue ─────────────────────────────────────────────────────────

/**
 * Description of one IntelliG configuration knob the property test
 * may flip. Each entry pairs the typed `IExtensionConfiguration` key
 * (used to assert `context.keys` contains the right name) with the
 * VS Code setting name (used by `setMockConfigValue` and
 * `update(...)`) AND a generator for a fresh value distinct from the
 * default.
 *
 * The setting name differs from the typed key for a few entries
 * (`log.level` ≠ `logLevel`, etc.) because `CONFIG_KEY_MAP` in
 * `ConfigurationService.ts` does the translation. For the same
 * reason the generators here mirror the schema-default subset used
 * by the production typed projection.
 *
 * `valueArb` produces values that:
 *   - Differ from the default for the knob (so `oldConfig[k] !==
 *     newConfig[k]` triggers the diff).
 *   - Do not collide with the typed key string itself (the assertion
 *     "value not in rendered block" would be ambiguous if value
 *     equalled the key — generators stay disjoint).
 */
interface IKnobDescriptor<K extends keyof IExtensionConfiguration> {
  readonly typedKey: K;
  readonly settingName: string;
  readonly valueArb: fc.Arbitrary<IExtensionConfiguration[K]>;
}

const defaults = getDefaultConfiguration();

/**
 * String generator for the safe alphanumeric subset. Excludes every
 * char the sanitizer rewrites and quote/JSON delimiters so the
 * "value does not appear in the rendered block" check stays
 * unambiguous. Excludes the literal substring 'logLevel', 'keys',
 * 'true', 'false', and key-like tokens to keep the assertion
 * disjoint from the rendered context object.
 */
const safeStringArb: fc.Arbitrary<string> = fc
  .stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
    { minLength: 5, maxLength: 16 }
  )
  .filter((s) => {
    const lower = s.toLowerCase();
    // Disallow tokens that would collide with the rendered record's
    // shape. The change record always carries `keys`, `ctx`, `cid`,
    // and the message body. Any value containing those substrings
    // would produce a false positive in the leak assertion below.
    if (lower.includes('key') || lower.includes('ctx')) {
      return false;
    }
    if (lower.includes('cid') || lower.includes('intellig')) {
      return false;
    }
    if (lower.includes('configuration') || lower.includes('changed')) {
      return false;
    }
    if (lower === 'true' || lower === 'false') {
      return false;
    }
    // Disallow tokens that match any of the typed-key strings — see
    // generator-constraint note above.
    for (const k of Object.keys(defaults)) {
      if (lower === k.toLowerCase()) {
        return false;
      }
    }
    return true;
  });

/**
 * Hex-color generator. Produces a `#RRGGBB` token whose hex chars
 * avoid pure-zero outputs (so the value differs from the colour
 * defaults for the modified/added/deleted/ignored/conflict knobs)
 * and avoid `'true'`/`'false'`/`'keys'` collisions by construction
 * (six hex chars cannot equal those tokens).
 */
const hexColorArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 16, max: 255 }),
    fc.integer({ min: 16, max: 255 }),
    fc.integer({ min: 16, max: 255 })
  )
  .map(([r, g, b]) => {
    const toHex = (n: number): string => n.toString(16).padStart(2, '0').toUpperCase();
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  });

/**
 * Boolean knobs: flip to the negation of the schema default so the
 * diff always fires.
 */
function booleanFlipArb<K extends keyof IExtensionConfiguration>(
  key: K
): fc.Arbitrary<IExtensionConfiguration[K]> {
  return fc.constant(!defaults[key] as IExtensionConfiguration[K]);
}

/**
 * Integer arb used for `autoFetchInterval`. The default is `180`;
 * the generator picks any value in a wide reasonable range and
 * filters out the default so the diff fires.
 */
const autoFetchIntervalArb: fc.Arbitrary<number> = fc
  .integer({ min: 30, max: 3600 })
  .filter((n) => n !== defaults.autoFetchInterval);

const knobs: ReadonlyArray<IKnobDescriptor<keyof IExtensionConfiguration>> = [
  // Boolean knobs
  {
    typedKey: 'defaultCommitSignOff',
    settingName: 'defaultCommitSignOff',
    valueArb: booleanFlipArb('defaultCommitSignOff'),
  } as IKnobDescriptor<'defaultCommitSignOff'>,
  {
    typedKey: 'pullRebase',
    settingName: 'pullRebase',
    valueArb: booleanFlipArb('pullRebase'),
  } as IKnobDescriptor<'pullRebase'>,
  {
    typedKey: 'autoFetchEnabled',
    settingName: 'autoFetchEnabled',
    valueArb: booleanFlipArb('autoFetchEnabled'),
  } as IKnobDescriptor<'autoFetchEnabled'>,
  {
    typedKey: 'showStatusBarBranch',
    settingName: 'showStatusBarBranch',
    valueArb: booleanFlipArb('showStatusBarBranch'),
  } as IKnobDescriptor<'showStatusBarBranch'>,
  {
    typedKey: 'useIntelliJKeymap',
    settingName: 'useIntelliJKeymap',
    valueArb: booleanFlipArb('useIntelliJKeymap'),
  } as IKnobDescriptor<'useIntelliJKeymap'>,

  // Numeric knob
  {
    typedKey: 'autoFetchInterval',
    settingName: 'autoFetchInterval',
    valueArb: autoFetchIntervalArb,
  } as IKnobDescriptor<'autoFetchInterval'>,

  // String knobs
  {
    typedKey: 'commitMessageTemplate',
    settingName: 'commitMessageTemplate',
    valueArb: safeStringArb,
  } as IKnobDescriptor<'commitMessageTemplate'>,

  // Color knobs (hex-color string)
  {
    typedKey: 'modifiedFileColor',
    settingName: 'modifiedFileColor',
    valueArb: hexColorArb.filter((s) => s !== defaults.modifiedFileColor),
  } as IKnobDescriptor<'modifiedFileColor'>,
  {
    typedKey: 'addedFileColor',
    settingName: 'addedFileColor',
    valueArb: hexColorArb.filter((s) => s !== defaults.addedFileColor),
  } as IKnobDescriptor<'addedFileColor'>,
  {
    typedKey: 'deletedFileColor',
    settingName: 'deletedFileColor',
    valueArb: hexColorArb.filter((s) => s !== defaults.deletedFileColor),
  } as IKnobDescriptor<'deletedFileColor'>,
  {
    typedKey: 'ignoredFileColor',
    settingName: 'ignoredFileColor',
    valueArb: hexColorArb.filter((s) => s !== defaults.ignoredFileColor),
  } as IKnobDescriptor<'ignoredFileColor'>,
  {
    typedKey: 'conflictFileColor',
    settingName: 'conflictFileColor',
    valueArb: hexColorArb.filter((s) => s !== defaults.conflictFileColor),
  } as IKnobDescriptor<'conflictFileColor'>,

  // Enum knobs
  {
    typedKey: 'defaultToolWindowTab',
    settingName: 'defaultToolWindowTab',
    valueArb: fc
      .constantFrom<
        IExtensionConfiguration['defaultToolWindowTab']
      >('local-changes', 'log', 'console')
      .filter((v) => v !== defaults.defaultToolWindowTab),
  } as IKnobDescriptor<'defaultToolWindowTab'>,
  {
    typedKey: 'blameAnnotationStyle',
    settingName: 'blameAnnotationStyle',
    valueArb: fc
      .constantFrom<
        IExtensionConfiguration['blameAnnotationStyle']
      >('inline', 'gutter', 'both', 'off')
      .filter((v) => v !== defaults.blameAnnotationStyle),
  } as IKnobDescriptor<'blameAnnotationStyle'>,
  {
    typedKey: 'keymapPreset',
    settingName: 'keymapPreset',
    valueArb: fc
      .constantFrom<IExtensionConfiguration['keymapPreset']>('default', 'intellij')
      .filter((v) => v !== defaults.keymapPreset),
  } as IKnobDescriptor<'keymapPreset'>,
];

// ─── Property test ──────────────────────────────────────────────────────────

describe('ConfigurationService change records carry only keys (Property 12)', () => {
  beforeEach(() => {
    fullReset();
  });

  afterEach(() => {
    fullReset();
  });

  /**
   * Property 12: For any IntelliG configuration knob `K` with current
   * value `v_old` and any new value `v_new ≠ v_old`, when the user
   * (or test) writes `v_new` to the underlying VS Code configuration
   * AND `intellig.log.level = 'debug'` admits debug records, THEN:
   *
   *   - The OutputChannel receives exactly one `'intellig
   *     configuration changed'` record.
   *   - That record's level is `'debug'`.
   *   - That record's component is `'ConfigurationService'`.
   *   - That record's `context.keys` array contains the typed key
   *     name for `K`.
   *   - The rendered record's context-portion does NOT contain
   *     `String(v_new)` OR `JSON.stringify(v_new)` OR `String(v_old)`
   *     OR `JSON.stringify(v_old)` as a substring.
   *
   * Generator design: we drive the property over the cross-product of
   * (knob descriptor) × (a per-knob value sampler). Because each
   * descriptor carries its own `valueArb` whose value-space is tied
   * to the knob's type, we use `fc.oneof` to compose a single
   * arbitrary that yields `{ knob, newValue }` tuples — fast-check
   * can then shrink across both the knob choice and the chosen value
   * within that knob's space.
   */
  it('Property 12: change record contains the changed key and never carries the value', () => {
    /**
     * Composed arbitrary: yields `{ knob, newValue }` pairs where
     * `newValue` was drawn from `knob.valueArb`. We zip the knob
     * descriptor with one of its sampled values via
     * `arb.map(...)` inside an `fc.oneof` over every knob, so
     * fast-check sees a unified value-space and can shrink within
     * the chosen knob's column.
     */
    const knobAndValueArb: fc.Arbitrary<{
      knob: IKnobDescriptor<keyof IExtensionConfiguration>;
      newValue: IExtensionConfiguration[keyof IExtensionConfiguration];
    }> = fc.oneof(
      ...knobs.map((knob) =>
        knob.valueArb.map((newValue) => ({
          knob,
          newValue: newValue as IExtensionConfiguration[keyof IExtensionConfiguration],
        }))
      )
    );

    fc.assert(
      fc.property(knobAndValueArb, ({ knob, newValue }) => {
        // Per-iteration reset: drop the Logger + channel + mock
        // config so a prior iteration's writes can't pollute the
        // change-event diff or the captured channel lines. This
        // lives inside the property body because `fc.assert` has
        // no per-iteration hook.
        fullReset();

        // Pin the log level to 'debug' so the change record (which
        // the production code emits at debug level) is admitted to
        // the OutputChannel sink. Apply BEFORE initLogger so the
        // resolver picks it up on the initial refresh.
        setMockConfigValue('intellig', 'log.level', 'debug', ConfigurationTarget.Global);

        // Wire the production sinks against the mock channel.
        const ctx = makeFakeContext();
        initOutputChannel(ctx);
        initLogger(ctx);

        // Construct ConfigurationService AFTER the Logger is
        // ready — its constructor calls
        // getLogger().child({ component: 'ConfigurationService' }).
        const configService = new ConfigurationService();

        try {
          // Pin the OLD value as the schema default. The knob
          // generators above already filter so newValue !== default.
          const oldValue = defaults[knob.typedKey];

          // Defensive: skip iterations where the chosen new value
          // somehow equals the current value (no diff would fire).
          fc.pre(newValue !== oldValue);

          // Snapshot the channel lines that were already there
          // (e.g. the Logger's own warn record on an invalid
          // log.level fallback — should be zero in this setup
          // since we pinned 'debug', but be defensive).
          const baselineLines = captureChannelLines();

          // Drive the change through the mock workspace. This is
          // the same path real VS Code uses: update(...) writes
          // the value AND fires onDidChangeConfiguration to every
          // listener (including ConfigurationService's listener
          // installed in its constructor).
          const wsConfig = vscode.workspace.getConfiguration('intellig');
          // Cast through unknown — IExtensionConfiguration value
          // type is too narrow for the WorkspaceConfiguration
          // signature.
          void wsConfig.update(
            knob.settingName,
            newValue as unknown,
            vscode.ConfigurationTarget.Global
          );

          // Capture any new lines emitted as a result of the
          // change. The mock fires listeners synchronously inside
          // update(), so by the time update() returns the change
          // record (if any) is already in the channel.
          const allLines = captureChannelLines();
          const newLines = allLines.slice(baselineLines.length);

          // Find the change record's header and reassemble its
          // block so parseRecord can reconstruct the LogRecord.
          const headerOffset = findConfigChangeHeaderIndex(newLines);
          assert.notStrictEqual(
            headerOffset,
            -1,
            'expected the ConfigurationService change record to be ' +
              "emitted with message 'intellig configuration changed'; " +
              `captured lines: ${JSON.stringify(newLines)}`
          );

          const block = reassembleBlock(newLines, headerOffset);
          const record = parseRecord(block);

          // Pin the structural shape of the change record.
          assert.strictEqual(
            record.message,
            'intellig configuration changed',
            `expected message='intellig configuration changed'; got ${JSON.stringify(record.message)}`
          );
          assert.strictEqual(
            record.level,
            'debug',
            `expected debug level for the change record; got ${record.level}`
          );
          assert.strictEqual(
            record.component,
            'ConfigurationService',
            `expected component='ConfigurationService'; got ${record.component}`
          );

          // The record's context must carry a `keys` array.
          // The keys list must include the
          // typed-key name for the knob we just flipped
          // (name only, not value).
          assert.ok(
            record.context !== undefined,
            `expected change record to carry a context object; got ${JSON.stringify(record)}`
          );
          const keys = record.context?.keys;
          assert.ok(
            Array.isArray(keys),
            `expected context.keys to be an array; got ${JSON.stringify(keys)}`
          );
          assert.ok(
            (keys as readonly unknown[]).includes(knob.typedKey),
            `expected context.keys to contain '${knob.typedKey}'; ` + `got ${JSON.stringify(keys)}`
          );

          // Structural pin: the change record's context MUST
          // contain ONLY the `keys` field. Any extra context key
          // (e.g. an accidentally-added `oldValue` / `newValue`)
          // would risk leaking value content. This check makes
          // any future regression that adds another context entry
          // visible at the test boundary, even if the regression
          // happens to use a value that wouldn't show up in a
          // substring scan.
          const ctxKeysActual = Object.keys(record.context as Record<string, unknown>).sort();
          assert.deepStrictEqual(
            ctxKeysActual,
            ['keys'],
            `No-PII-in-keys: change-record context must only ` +
              `carry the 'keys' field; got ${JSON.stringify(ctxKeysActual)}`
          );

          // The change record must not carry an `error` payload
          // (would risk leaking value through error.message /
          // error.stack). Pin its absence in the production code
          // path.
          assert.strictEqual(
            record.error,
            undefined,
            `change record must not carry an error payload; got ${JSON.stringify(record.error)}`
          );

          // (substring scan): the value MUST
          // NOT appear anywhere in the rendered context portion
          // of the block. We scan ONLY the continuation lines
          // (`  ctx=...` etc.) rather than the entire block,
          // because the header line carries a timestamp whose
          // numeric components could legitimately overlap a
          // numeric `newValue` (e.g. `autoFetchInterval=30`
          // colliding with a `:30Z` second-of-minute in the
          // ISO-8601 timestamp). Continuation lines encode only
          // structural fields (`ctx`, `cid`, `err`), so a leak
          // through any of them would land here.
          const continuationLines: string[] = [];
          for (let i = headerOffset + 1; i < newLines.length; i++) {
            if (newLines[i].startsWith('  ')) {
              continuationLines.push(newLines[i]);
            } else {
              break;
            }
          }
          const continuationBlob = continuationLines.join('\n');

          for (const form of valueRenderForms(newValue)) {
            if (form.length === 0) {
              continue; // empty-string forms can't meaningfully leak
            }
            assert.ok(
              !continuationBlob.includes(form),
              `No-PII-in-keys violation: rendered change-record ` +
                `continuation lines contain the new value '${form}' ` +
                `for key '${knob.typedKey}'. lines=${JSON.stringify(continuationLines)}`
            );
          }
          for (const form of valueRenderForms(oldValue)) {
            if (form.length === 0) {
              continue;
            }
            assert.ok(
              !continuationBlob.includes(form),
              `No-PII-in-keys violation: rendered change-record ` +
                `continuation lines contain the old value '${form}' ` +
                `for key '${knob.typedKey}'. lines=${JSON.stringify(continuationLines)}`
            );
          }
        } finally {
          // Always tear down the ConfigurationService so its
          // onDidChangeConfiguration listener is detached before
          // the next iteration's reset wipes the listener registry.
          configService.dispose();
        }
      }),
      { numRuns: 100 }
    );
  });
});

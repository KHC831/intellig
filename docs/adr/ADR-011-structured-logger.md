# ADR-011: Structured Logger as an ADR-002 cross-cutting singleton

Status: Accepted (2026-05-26)

## Context

Before this work the extension had two parallel logging tracks. Some
code reached for `console.*` (visible only in the Extension Development
Host), and some appended directly to the shared `IntelliG`
`vscode.OutputChannel` via `getOutputChannel().appendLine(...)`. The
two tracks disagreed on everything that matters for reading a log: no
shared timestamp format, no level discipline, no component attribution,
no way to tie a line back to the user gesture that produced it, and no
guarantee that a credentialed remote URL or an absolute home-dir path
had been scrubbed before it landed somewhere copyable.

That divergence is a problem for the only consumer that matters — a
user filing a bug report, or a maintainer reading one. A report that
pastes `Output → IntelliG` should carry enough structure to locate the
failing component and correlate the lines that belong to one command
invocation, and it must never carry a token or a real account name.

We want **one** boundary every layer of the extension writes through:
services, tree/webview providers, command handlers, and the
`safeFireAndForget` rejection path. One set of conventions, one
sanitization seam, one place to change rendering. The open question
this ADR answers is _how that boundary is exposed_ — and specifically
why it is a module-level singleton under `src/utils/` rather than a
service on the `ExtensionServices` graph, given that ADR-002
deliberately makes the singleton track a narrow exception.

## Decision

Ship a structured Logger as a module-level singleton under
`src/utils/logger/`, exposed through a single public barrel
(`src/utils/logger/index.ts`). The Logger is a **passive facade**: a
consumer looks up `getLogger().child({ component: 'X' })` and calls
level methods; everything else (threshold filtering, correlation
lookup, sanitization, sink fan-out) happens behind the facade.

### Logger facade shape

`Logger` exposes the five level methods plus `child`:

```ts
interface Logger {
  trace(message: string, context?: Bindings): void;
  debug(message: string, context?: Bindings): void;
  info(message: string, context?: Bindings): void;
  warn(message: string, context?: Bindings): void;
  error(message: string, contextOrError?: Bindings | Error, errorArg?: Error): void;
  child(bindings: Bindings): Logger;
}
```

- `error` carries an overload: the second argument may be a `Bindings`
  bag _or_ an `Error`, so the common shorthand `logger.error('failed',
err)` works without spelling out a third positional. `instanceof
Error` is the discriminator.
- `child(bindings)` returns a fresh `Logger` whose state is the parent
  state shallow-merged with `bindings`. It is **non-destructive**:
  neither the parent's captured state nor the caller's `bindings`
  object is mutated. Two keys are special-cased onto top-level record
  fields — `component` (most-recent `child` wins) and `correlationId`
  (an explicit override; rarely used). Every other key lands inside
  `LogRecord.context`.
- The root Logger has component `'root'`, no inherited context, and no
  correlation override. Every other Logger descends from it.

Each emit walks a fixed flow: a **hot-path threshold check first**
(short-circuit before any allocation when the configured level rejects
the record), then record construction (timestamp, effective component,
merged context, resolved correlation id, optional split `Error`), then
`sanitizeRecord`, then multicast to admitting sinks. At
`intellig.log.level = "off"` the per-call cost is one numeric
comparison.

### LogSink contract

A sink is the consumer side of the Logger. The contract is three
methods plus a stable `name`:

```ts
interface LogSink {
  readonly name: string;
  admits(record: LogRecord): boolean;
  emit(record: LogRecord): void;
  dispose(): void;
}
```

- `admits` is consulted at emit time even though the Logger already
  short-circuits on the shared threshold. Keeping the per-sink gate
  means a future per-sink override (e.g. a test sink capturing only
  `warn`/`error`) Just Works without touching the Logger.
- `emit` receives an **already-sanitized** record. Sinks do no
  redaction of their own. They MUST NOT throw for non-fatal rendering
  issues; the Logger catches `emit` throws and re-emits a single warn
  record naming the failing sink, guarded against recursion and
  skipping the offending sink so a persistently broken sink cannot
  loop its own failure reports back into itself.
- `dispose` is idempotent and detaches the sink's own subscription
  only. A sink that _borrows_ an externally-owned resource never
  disposes it (see the channel-ownership boundary below).

Two production sinks ship today, both sharing the Logger's single
`LogLevelResolver`:

- **`OutputChannelSink`** (`name = 'output-channel'`) — the canonical
  user-visible surface. It renders each record through `formatRecord`
  (`render.ts`) and writes the block with `appendLine`. The underlying
  `vscode.OutputChannel` is owned by `initOutputChannel(context)`; the
  sink only borrows it, so `dispose()` here detaches the sink and never
  calls `outputChannel.dispose()`. VS Code tears the channel down via
  the subscription `initOutputChannel` registered.
- **`ConsoleSink`** (`name = 'console'`) — a developer-only mirror,
  active only when `intellig.log.console` is `true`. It reuses the same
  `formatRecord` output as the OutputChannel sink (byte-for-byte
  parity) and forwards to `console[level]`, mapping `trace →
console.debug`. This file is the **one sanctioned production
  reference to `console.*`**; the structural guard
  `scripts/check-no-bare-console.sh` allowlists it and fails the build
  on any other `console` call site.

### Correlation-id mechanism

Correlation propagation uses Node's `AsyncLocalStorage` (built into the
runtime VS Code embeds). `correlation.ts` owns an
`AsyncLocalStorage<ICorrelationFrame>` where a frame carries a
16-character lowercase hex `correlationId` (from
`crypto.randomBytes(8).toString('hex')`) and the originating
`commandId`.

`registerLoggedCommand(id, handler)` wraps
`vscode.commands.registerCommand`. From the VS Code side the returned
`Disposable` is indistinguishable from a direct registration — same
dispose semantics, same arg passing, same return-value propagation. The
only difference is that the handler body runs inside
`_store.run({ correlationId, commandId }, () => handler(...args))`, so
any Logger emission from the body or its awaited descendants carries
the frame's id. A fresh id is minted per invocation.

Two properties matter and are deliberate:

- **Read at emit time, not at `child` time.** `child(bindings)` does
  not read the store. The store is read when a record is built, so a
  child Logger constructed inside one command frame and called inside
  another attributes records to the _current_ frame. An explicit
  `correlationId` binding overrides the store read.
- **Non-fabrication.** When no command frame is on the stack (e.g. a
  watcher event handler firing outside any `run(...)`),
  `getCurrentCorrelationId()` returns `undefined` and the Logger omits
  the field rather than synthesizing one. `safeFireAndForget` captures
  the id _at call time_ and closes over it, so a rejection that fires
  after the frame has popped still emits the captured id.

### LogLevelResolver

`levels.ts` owns the `LogLevelResolver`, which caches the configured
threshold (`intellig.log.level`, default `info`) and the
developer-console flag (`intellig.log.console`). Threshold ordering is
the frozen `LEVEL_RANK` table `trace < debug < info < warn < error <
off`; `admits(level)` is a single comparison `LEVEL_RANK[level] >=
LEVEL_RANK[threshold]`. `'off'` is a _threshold-only_ value — a record
can never be at level `'off'`.

The resolver reads `vscode.workspace.getConfiguration('intellig')`
**directly**, not through `ConfigurationService`. This is a bootstrap
decision: `ConfigurationService` is constructed by `ExtensionServices`,
which runs _after_ `initLogger(context)`, so depending on it would
reintroduce the chicken-and-egg ordering hazard the singleton exists to
avoid. `initLogger` instead registers a raw
`onDidChangeConfiguration` listener — the same pattern
`ConfigurationService` uses internally — and both subscribers recompute
independently from the same event. An invalid `intellig.log.level`
falls back to `info` and surfaces exactly one warn record naming the
offending value (de-duplicated per value), so a typo'd setting does not
flood the channel.

### Sanitizer: reuse of `sanitizeGitError` (ADR-005)

`sanitize.ts` is the single recursion-and-walk point that scrubs a
record before it reaches any sink. It does **not** re-derive any
redaction logic. Every string leaf — `message`, `correlationId`,
`error.message`, `error.stack`, and every string inside `context` —
passes through `sanitizeGitError` (`src/git-core/gitError.ts`), whose
four-pass ordering (credential URL → Windows backslash → Windows
forward-slash → POSIX home) is pinned by **ADR-005**. The Logger-side
walker adds only the structural concerns ADR-005 does not cover:
recursion into arrays and plain objects, cycle detection via a
`WeakSet` (a self-referential `context` collapses to `'[Circular]'`
rather than looping), silent drop of `Symbol`-keyed entries (matching
`JSON.stringify`), and a top-level `try/catch` that converts a thrown
sanitizer into a sentinel result. The Logger turns that sentinel into a
fixed-content fallback warn record, so a sanitizer failure can never
propagate into caller flow and can never leak the payload that broke
it. New redaction rules belong at the ADR-005 site, not here.

### ADR-002 conformance by construction

The Logger lives under `src/utils/` because it satisfies **every one**
of ADR-002's four criteria for a module-level singleton. This is the
explicit justification ADR-002 requires; anything short of all four
would belong on `ExtensionServices`.

1. **Cross-cutting sink.** The Logger is the canonical structured-log
   boundary written into by every layer — services, providers, command
   handlers, and `safeFireAndForget`. It is an observability surface,
   not business state, not cached data, not a configuration projection.

2. **Needs early access.** `GitService.setupRepositoryWatcher` and the
   `ConflictResolutionService` state-sync paths emit during service
   _construction_, before `ExtensionServices.initialize` has finished
   wiring the graph. The Logger is the uniform replacement for the
   `console.*` / direct-channel calls on those paths, so it inherits
   the same pre-`initialize()` access constraint that motivated the
   original `getOutputChannel` singleton. `initLogger(context)` runs in
   `activate` _before_ `ExtensionServices.initialize`.

3. **Test-isolation hook.** `__resetLoggerForTest()` drops the cached
   root Logger, detaches and disposes every registered sink, disposes
   the configuration listener, and resets the `LogLevelResolver`'s
   cached threshold and the idempotency guard — so each spec starts
   from a fresh singleton. The `__<name>ForTest` prefix is the
   TestSurface convention (`docs/testing.md` section 3); the structural guard
   `scripts/check-test-only-surface.sh` fails the build on any
   production reference.

4. **Registered for disposal.** `initLogger(context)` pushes the
   configuration-change listener and one disposable per sink onto
   `context.subscriptions`, so the deactivation chain tears them down
   alongside every other extension disposable. The underlying
   `OutputChannel` is _not_ double-disposed here — it is owned by
   `initOutputChannel(context)`'s own subscription (Requirement 3.4).

## Consequences

### Positive

- One boundary, one set of conventions. Every layer emits structured
  records with timestamp, level, component, optional context, optional
  correlation id, and an optional split `Error` — no more `console.*`
  vs `appendLine` divergence.
- Sanitization is centralized and reuses the ADR-005-pinned helper, so
  the redaction ordering has exactly one owner and the Logger walker
  only adds structural traversal. Adding a redaction rule is still a
  one-site change at `sanitizeGitError`.
- Correlation ids let a maintainer group every record from one command
  invocation, including records emitted from awaited descendants and
  from `safeFireAndForget` rejections that fire after the frame popped.
- The hot-path threshold check makes the disabled / filtered case
  essentially free, so adding log calls on warm paths is cheap.
- The ADR-002 conformance is checkable, not asserted in prose alone:
  the four criteria each map to a concrete mechanism
  (`__resetLoggerForTest`, the `context.subscriptions` registrations,
  the pre-`initialize` activation order, the cross-cutting consumer
  set), and `src/test/unit/utils/logger/adr002Conformance.test.ts`
  pins them.

### Negative / costs

- The Logger is a second module-level singleton alongside
  `getOutputChannel`. ADR-002 names two as the informal ceiling before
  re-evaluating whether a small "bootstrap observability" service is
  warranted; this ADR spends that budget. A _third_ cross-cutting sink
  (telemetry, error routing) should trigger that re-evaluation rather
  than reflexively adding a third singleton.
- The resolver talking directly to `vscode.workspace` duplicates the
  configuration-read pattern that `ConfigurationService` also
  implements. This is intentional (it dodges the bootstrap circular)
  but it does mean two independent subscribers recompute on the same
  event.
- The sink fan-out has to defend against `emit` throws with a
  recursion-guarded fallback path, which is more machinery than a
  single `appendLine` call. The cost buys isolation: one broken sink
  cannot take down emission to the others.

### Neutral

- `render.ts` ships both `formatRecord` (production) and `parseRecord`
  (its inverse). `parseRecord` has no production caller today and
  exists for the round-trip property test, but it is the canonical
  entry point should the runtime ever need to parse rendered blocks
  (e.g. an in-process log viewer). It carries no `__*ForTest` prefix
  because it is a pure, state-free helper.
- The `Bindings` value-space is restricted to JSON-serializable types
  so the sanitizer's walker traverses a closed space. Non-conforming
  values that slip in via `as` casts degrade gracefully (Symbol keys
  dropped, `undefined` skipped) rather than throwing.

## Motivating example

A command handler registered with `registerLoggedCommand('intellig.commit', …)`
runs its body inside a correlation frame. Inside the body, a service
looks up `getLogger().child({ component: 'commit' })` and calls
`.info('staging files', { count: 3 })`. The emitted record carries the
frame's `correlationId`, `component: 'commit'`, and a sanitized
`context`. If the same handler calls `safeFireAndForget(pushPromise,
…)`, the push rejection — which fires after the handler returned and the
`AsyncLocalStorage` frame popped — still logs the _same_ correlation id
because `safeFireAndForget` captured it at call time. Every line is
scrubbed by `sanitizeGitError` before it reaches the `IntelliG`
channel, so a `fatal: unable to access https://user:token@host/…`
stderr fragment renders with the credential redacted.

## References

- `src/utils/logger/index.ts` — the public barrel; the single import
  surface for every consumer (`getLogger`, `initLogger`,
  `__resetLoggerForTest`, `registerLoggedCommand`, and the `Logger` /
  `LogRecord` / `LogSink` / `LogLevel` types).
- `src/utils/logger/logger.ts` — the `Logger` facade, the module-level
  singleton state, the emit flow, and the lifecycle accessors.
- `src/utils/logger/levels.ts` — `LogLevel` / `LogThreshold`,
  `LEVEL_RANK`, and the `LogLevelResolver`.
- `src/utils/logger/correlation.ts` — the `AsyncLocalStorage` store and
  the `registerLoggedCommand` wrapper.
- `src/utils/logger/sanitize.ts` — the record walker delegating every
  string leaf to `sanitizeGitError`.
- `src/utils/logger/render.ts` — `formatRecord` / `parseRecord`.
- `src/utils/logger/sinks/` — `types.ts` (the `LogSink` contract),
  `OutputChannelSink.ts`, `ConsoleSink.ts`.
- ADR-002 — module-level singletons in `src/utils/`; this ADR is the
  conformance justification its four criteria require.
- ADR-005 — sanitizer pass ordering in `sanitizeGitError`; the Logger
  reuses that helper rather than re-deriving redaction.
- `docs/testing.md` section 3 — the `__<name>ForTest` TestSurface convention
  the `__resetLoggerForTest` hook follows.

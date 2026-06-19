# ADR-002: Module-level singletons in `src/utils/`

Status: Accepted (2026-05-12)

## Context

Most extension state lives behind a service class that is constructed,
wired into the dependency graph, and torn down by `ExtensionServices`.
The pattern is deliberate: every consumer takes the service by interface,
every service goes through a single `initialize()` sequence with a
predictable ordering, and every disposable is owned by the service graph
so deactivation is a single chain of `dispose()` calls.

A small number of utilities in `src/utils/` deviate from this: they hold
their instance in a module-level `let _x: T | undefined` variable and
expose a `getX()` accessor that lazily constructs the value on first
access. The clearest current example is `getOutputChannel()` in
`src/utils/outputChannel.ts`, which caches the `IntelliG` VS Code
`OutputChannel` behind a `_channel` module-level. An earlier design
considered exposing the channel through `NotificationService`, but that
approach forced every early-activation call site (watcher setup,
state-sync fired during construction) to reach into a service that
wasn't guaranteed to be wired yet — a circular ordering hazard. A lazy
module-level singleton dodged the hazard without expanding the service
graph's bootstrap surface.

This created an implicit "second track" for state in the codebase. Each
new candidate re-raised the same review debate: should it be a service
or a singleton? Without a written rule, reviewers landed different calls
on equivalent cases, and a well-meaning future change could widen the
utils-singleton track past the point where it is a net positive.

## Decision

A module-level singleton is acceptable in `src/utils/` **only** when
every one of the following is true:

1. **Cross-cutting sink.** The value is a logging channel, telemetry
   reporter, error router, or similar observability surface that every
   layer of the extension needs to write into. It is _not_ business
   state, _not_ cached data, and _not_ a configuration projection.

2. **Needs early access.** At least one real consumer must be able to
   call `getX()` _before_ `ExtensionServices.initialize()` has finished
   wiring the service graph. The canonical case is a watcher / state-sync
   path that fires during service construction itself, when requiring a
   constructed service would be a chicken-and-egg bootstrap failure.

3. **Test-isolation hook.** The module must expose a reset/dispose
   helper (e.g. `__resetOutputChannelForTest()`) that drops the cached
   instance so unit tests can run against a fresh singleton each time.
   Without this hook the singleton leaks between specs and creates
   order-dependent flakiness. The TestSurface idiom (see
   `docs/testing.md` section 3) requires the `__<name>ForTest` prefix on
   module-scope test-only exports — it encodes the
   "production-callers-MUST-NOT" contract in the function name itself
   and pairs with a structural CI guard that fails the build on any
   production reference.

4. **Registered for disposal.** The module must expose an
   `initX(context)` function that registers the cached instance against
   `context.subscriptions`. Activation calls `initX` exactly once; the
   deactivation chain drops the subscription in the normal way. Callers
   of `getX()` must not have to think about lifetime.

Anything that does not satisfy all four criteria belongs on a service
under `ExtensionServices`. "Convenience" alone is not a reason; if the
value is business state, the service graph is the right home even at
the cost of a little bootstrap plumbing.

## Consequences

### Positive

- Reviewers have a checklist rather than a case-by-case debate.
- The utils-singleton track stays scoped to its original purpose
  (cross-cutting observability with early-access needs) instead of
  slowly eating features that should live on services.
- The `initX` / `__resetXForTest` shape is consistent across singletons,
  so a new one is mechanical to add once a real need is demonstrated.

### Negative / costs

- The criteria are deliberately narrow. A genuinely good-faith case
  that falls just short — say, a cross-cutting sink that doesn't
  strictly need pre-`initialize()` access — will be pushed onto
  `ExtensionServices` even if a singleton would have been slightly
  simpler. That friction is intentional: it keeps the singleton track
  from being the path of least resistance.
- Writing a new singleton still costs more boilerplate than writing a
  new module-level helper function. The `initX` / `__resetXForTest`
  pair is not free. Only pay it when the criteria actually apply.

### Neutral

- The criteria are not a gate against adding a genuinely new cross-cutting
  sink. Telemetry, error routing, structured-log aggregation — all are
  candidates if they arise. The rule is that the _third_ such singleton
  should prompt a fresh look at whether the utils-track is still the
  right shape or whether a small "bootstrap observability" service is
  warranted. Two is the informal ceiling before re-evaluation; it is a
  signal, not a hard cap.

## Motivating example

`src/utils/outputChannel.ts` matches every criterion:

- (1) The channel is the `IntelliG` Output pane — a write-only sink for
  init / watcher / state-sync diagnostics.
- (2) `GitService.setupRepositoryWatcher` and
  `ConflictResolutionService` state-sync paths fire during service
  construction, when `NotificationService` is not yet guaranteed wired.
- (3) `__resetOutputChannelForTest()` drops the cached instance for
  unit tests. The `__<name>ForTest` prefix is the TestSurface
  function-name convention (see `docs/testing.md` section 3); a structural CI
  guard (`scripts/check-output-channel-test-surface.sh`) fails the build
  if any production file references it.
- (4) `initOutputChannel(context)` pushes the channel onto
  `context.subscriptions` so deactivation tears it down alongside
  every other extension disposable.

Any future candidate should be evaluated against this example. If the
analogy strains on one of the four criteria, the candidate belongs on a
service.

## References

- `src/utils/outputChannel.ts` — the motivating singleton plus its
  JSDoc rationale for the lazy-init shape.
- `src/services/ExtensionServices.ts` — the default home for everything
  else (the service graph this ADR is carving an exception out of).
- ADR-001 — format reference; this ADR follows the same prose-first
  style with no SHA or task-ID references.

# ADR-006: Error-state binding by view type

Status: Accepted (2026-05-13)

## Context

By the end of Wave 7 the codebase had three patterns for surfacing
refresh-time errors in views, and the choice between them looked
arbitrary to anyone reading the diff after the fact:

- **`refresh() => Promise<{ error? }>` (canonical-channel pattern).**
  ShelfView's `refresh()` resolves to a structured outcome. Every caller
  reads the returned object and surfaces the error inline (toast,
  OutputChannel line, error result). The view state itself carries no
  `error` field — the return value is the sole channel.

- **`_state.error` sideband.** StashView, BranchComparisonView, and the
  HistoryTab template all stashed the latest refresh error into a field
  on the view's state object. A separate consumer would later read
  `state.error` and react. This is the older shape, predating Wave 7.

- **VS-Code-built-in error rendering** (`vscode.TreeDataProvider`).
  `BranchTreeProvider` lets `getChildren` rejections propagate up to
  the host. The host renders a "couldn't load this subtree" empty
  state; the provider holds no `error` field of its own. This pattern
  was unwritten before Wave 8 R2 — the existing provider works, but
  a future TreeView author had no docs to crib from and might
  reach for `_state.error` because the other two patterns were the
  only ones in print.

Three views carried the sideband: StashView, BranchComparisonView,
and HistoryTab (whose `state.error` is read inside HTML construction at
`gitToolWindow/html/historyHtml.ts`). One provider (`BranchTreeProvider`)
silently used the VS-Code-built-in pattern. The divergence wasn't
accidental but was also undocumented — a new view author copying from
the codebase had no way to tell which pattern was right for their case.

The triage that produced this ADR confirmed:

- StashView's `_state.error` had exactly one production reader
  (`_showStashList` line ~746); every other refresh path silently
  swallowed the error. Same shape as ShelfView pre-Wave-7.
- BranchComparisonView's `_state.error` had exactly one production
  reader (`show()` line ~127); the `_showComparisonResults`
  swap/refresh paths silently swallowed the error.
- HistoryTab's `state.error` is _rendered into HTML_ (`state.error ?
renderError(state.error) : ''`). The renderer needs synchronous
  read access during construction, where awaiting a refresh promise is
  the wrong shape. The sideband is structurally the right pattern there.

The first two cases are migration candidates; the third is a
genuine architectural exception that deserves to be called out
explicitly so future view authors don't try to "fix" it.

## Decision

Three patterns coexist. The choice between them is dictated by the
view's UI binding model — not by author preference.

**Default to the canonical-channel pattern unless your renderer
demands synchronous read access to the error.** When the binding
model is ambiguous, prefer the pattern that makes the failure
explicit at every call site (canonical-channel). Reach for a
sideband only when the renderer's shape genuinely forecloses on
awaiting a Promise.

### QuickPick / dialog / non-rendering views

Use the **canonical-channel pattern**:

- `refresh()` resolves to `Promise<{ error?: string }>`. Never rejects.
- The error message is sanitised at the source via `sanitizeGitError(raw)`.
- The view's state interface (e.g. `IShelfViewState`,
  `IStashViewState`, `IBranchComparisonViewState`) carries no `error`
  field.
- Every caller of `refresh()` (and any sibling method that performs a
  comparable read — `setBranches()`, `swapBranches()`, etc.) reads the
  return value and decides what to do (toast, OutputChannel, structured
  result) at the call site.

This pattern keeps the view-state object focused on data the UI binds
to (list contents, selection, loading flag) without a latent error
field that callers might read later instead of handling the live
outcome. It also eliminates the failure mode where one caller surfaces
the error and a downstream caller never realises a refresh failed.

### TreeView / async-`getChildren` views

Use the **VS-Code-built-in error rendering** pattern:

- The view implements `vscode.TreeDataProvider` and exposes
  `getChildren()` (which the host calls lazily as the user expands
  nodes). Helper methods like `_getLocalBranches()` /
  `_getRemoteBranches()` / `_getTags()` are awaited from inside
  `getChildren`.
- These helpers may **propagate rejection up to VS Code**. The host's
  TreeView renderer treats a thrown / rejected `getChildren` as
  "couldn't load this subtree" and renders an empty state — _that is
  the channel_. Don't catch the error inside the helper just to
  squash it; the user-visible "subtree didn't load" signal is
  intentional.
- Where a richer signal is warranted (network outage, auth failure,
  user-actionable diagnosis), surface a toast at the **action
  boundary** — the command handler that triggered the refresh, or
  the explicit "Refresh" action — _not_ from inside `getChildren`.
  `getChildren` runs whenever the host decides to re-query (expand,
  reveal, theme change, focus shift); a toast there fires
  unpredictably.
- Do **not** add an `error?` field to the tree provider's state.
  TreeView state is a list of nodes; an "error" node would either
  shadow legitimate empty states or compete with VS Code's own
  built-in error rendering. The empty-subtree convention plus a
  boundary-level toast is the pattern.

This pattern exists because the TreeView host owns the rendering
loop, not the provider. The provider's contract with VS Code is
"return the children, or throw / reject and the host will render
the failure." A `_state.error` sideband would have nowhere to go —
the renderer doesn't read provider state directly, and providers
don't own their own DOM the way a webview does. Augmenting the
host's behaviour with an action-boundary toast is the only
provider-side knob that makes sense.

The **`BranchTreeProvider`** is the canonical example today.
Its `_getLocalBranches`, `_getRemoteBranches`, and `_getTags` await
`gitService.getBranches` / `gitService.getTags` and let any
rejection propagate. Any toast surfacing of branch-fetch failure
lives at the action boundary (e.g. the explicit refresh command),
not inside the provider.

### HTML / template-rendering views

Use the **`_state.error` sideband pattern**:

- The view's state interface keeps an `error?: string` field.
- The HTML template reads `state.error` synchronously during
  construction (e.g. `state.error ? renderError(state.error) : ''`).
- Refresh failures still write the sanitised message to `_state.error`,
  not the raw error.

This pattern exists because the template renderer is a synchronous
function over the state object — it cannot await a refresh promise to
decide whether to render an error block. Routing the error through the
state object lets the same view-render pass handle both the data path
and the failure path uniformly.

A view qualifies for this pattern only if it:

1. **Renders HTML / a template** that needs synchronous read access to
   the error during construction.
2. **Has no other reasonable path** to surface the error — i.e. there
   is no QuickPick prompt, no dialog, no toast-bearing caller in scope
   that could read a Promise return value instead.

The HistoryTab is the canonical example today: `historyHtml.ts`
constructs the full HistoryTab markup from a `state` object, and the
error block is part of that markup.

## Consequences

### Positive

- A new view author can match the rule against their UI binding model
  and pick the right pattern without re-litigating it in review.
- QuickPick views shed a latent state field that mirrored the canonical
  channel; downstream callers can no longer read a stale error after
  the live one was already handled.
- The HTML-rendering exception is now explicit and tied to a structural
  signal (template binding), not author convenience.
- Reviewers have a one-line check on PRs that touch view error paths:
  _which UI binding model is this? does the refresh shape match?_

### Negative / costs

- Two patterns coexist permanently. Cross-codebase grep for
  `_state.error` will return matches in both (HistoryTab + future
  HTML-rendering views). The compensating discipline is that every
  match is now expected and documented, not a divergence.
- Adopting a new HTML-rendering view will reproduce the sideband
  shape. That is fine — the rule is _not_ "no sidebands ever," it is
  "sidebands only where the renderer demands one."

### Neutral

- If a future QuickPick view genuinely needs synchronous error read
  during item construction (no path to await a refresh), reopen this
  ADR before reaching for `_state.error`. The expected answer is to
  refactor the construction shape, not bypass the rule.
- The sanitiser-pass ordering rule (ADR-005) applies to both patterns:
  whatever channel carries the error, the message is sanitised at the
  source.

## Adopters

- **`IShelfView` (Wave 7).** Reference implementation of the
  canonical-channel pattern. State carries no `error`; `refresh()`
  resolves to `{ error? }`; every caller reads the return value.
- **`IStashView` (Wave 8).** Migrated under this rule. Same shape as
  ShelfView. `_state.error` removed; `_showStashList` reads
  `refreshResult.error` instead.
- **`IBranchComparisonView` (Wave 8).** Migrated under this rule.
  `refresh()`, `setBranches()`, and `swapBranches()` all return
  `{ error? }`. `show()` reads the `setBranches()` outcome instead of
  `_state.error`.
- **HistoryTab (kept).** Stays on the sideband because
  `historyHtml.ts` renders `state.error` synchronously during HTML
  construction. Per the rule, this is the structurally correct shape.
- **`BranchTreeProvider` (documented in Wave 8 R2).** Was already
  on the VS-Code-built-in pattern; this ADR now records that fact
  rather than ratifying a change. `getChildren` lets rejection
  propagate; no `error?` field on provider state.

## References

- `src/services/ShelfView.ts` + `src/services/interfaces/IShelfView.ts`
  — canonical-channel reference implementation.
- `src/services/StashView.ts` + `src/services/interfaces/IStashView.ts`
  — Wave 8 migration.
- `src/services/BranchComparisonView.ts` +
  `src/services/interfaces/IBranchComparisonView.ts` — Wave 8 migration.
- `src/services/gitToolWindow/html/historyHtml.ts` — template-binding
  exception; the canonical example for the `_state.error` pattern.
- `src/services/BranchTreeProvider.ts` — canonical example for the
  TreeView / async-`getChildren` pattern.
- ADR-005 — sanitiser-pass ordering; orthogonal to the channel choice
  but constrains the message that travels through whichever channel.

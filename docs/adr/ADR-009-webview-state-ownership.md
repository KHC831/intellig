# ADR-009: Webview state ownership — host leads, JS follows

Status: Accepted (2026-05-22)

## Context

Wave A (multi-select selection UX) shipped the first non-trivial
interactive state machine in the Git Tool Window webview: selection
membership, anchor for shift-click range, and a context menu whose
visibility + enabled flags depend on (selectedCount, contiguity,
HEAD-membership, merge-commit-presence). The R1 review round flagged
that the initial implementation duplicated the rules in two places:

1. **Host-side**, in `services/gitToolWindow/multiSelect.ts` —
   `computeMenuVisibility` + `computeMenuEnableState`, fully unit-tested.
2. **Webview JS**, inside the `_getInlineScript` template literal —
   `updateContextMenuState` + `isSquashEnabled`, hand-mirrored from the
   host helpers because the inline script can't `import` from the
   helper module.

Two copies of the same rules drift. The R1 reviewer (TL-H-2/H-3/H-4 +
Senior M-3) was explicit: every new menu rule, every change to a
contiguity / HEAD / merge predicate, becomes a four-touchpoint edit
(host helper + host test + JS mirror + JS structural assertion). A
future contributor who only updates the host side ships a webview
that's silently wrong; a contributor who only updates the JS side
ships unit tests that pass against stale logic.

The "JS imports the helper module" path is closed: VS Code webviews
load their script via a CSP `nonce-…` policy with no module support,
and even if we bundled, the inline-script template-literal seam would
have to drag the bundler into a per-test build step that nothing else
in this codebase needs.

The other path is to invert the data flow: have the **host** compute
the answer once per state change and post it to the webview, which
just applies. This eliminates the duplicate; it pushes any future rule
change to a single host-side helper + one host-side unit test.

## Decision

### 1. The host owns webview-relevant state derivations

Whenever the webview needs to make a decision based on rules
(visibility, enable, sort order, formatting, etc.), the host computes
the answer once per state change and posts it to the webview as a
typed message. The webview applies the precomputed answer with the
smallest possible amount of logic.

Wave A's concrete shape:

- `multiSelect.ts:computeMenuState({selectedHashes, commitNodes, headHash})`
  returns
  `Record<MultiSelectMenuAction, {visible: boolean; enabled: boolean}>`.
- The host calls it from every selection-mutating method
  (`selectCommit`, `toggleCommitSelection`, `rangeSelectCommit`,
  `addRangeSelectCommit`, `selectCommits`, `selectIfNotSelected`) +
  from `updateLogState` (the rules can change because HEAD or the
  commit set changed).
- The host posts the result via
  `{type: 'updateMenuEnableState', state, selectedCount}`.
- The webview JS caches the most-recent payload in
  `let menuEnableMap` and applies it via `applyMenuEnableMap` when the
  context menu opens. Per-action toggling is a 6-line loop:
  ```js
  function applyMenuEnableMap(menu) {
    menu.querySelectorAll('.context-menu-item').forEach((item) => {
      const action = item.getAttribute('data-action');
      const entry = menuEnableMap?.[action];
      item.classList.toggle('menu-multi-hidden', !entry?.visible);
      item.classList.toggle('disabled', entry && !entry.enabled);
    });
  }
  ```

The webview does NOT compute visibility or enable from scratch.

### 2. State that lives JS-only is restricted to ephemeral UI affordances

The webview is allowed to keep state that the host doesn't need to
know about, as long as that state has no observable consequence on
extension-host-driven actions:

- Hover / focus indicators
- Scroll position within the panel (the host supplies a target via
  `scrollToCommit`; the webview owns the actual scroll position)
- Drag state during a drag-and-drop gesture (the host learns the
  outcome via the drop event, not the in-progress state)
- Anchor mirror for immediate range-selection feedback (`let
  anchorHash`) — but ONLY as a mirror; the host owns the canonical
  value and posts `syncSelection` after every operation that may have
  invalidated it

If a JS-only state value starts driving an action — e.g. "the menu
item is enabled iff the JS thinks the selection is contiguous" — that
value has crossed the line and must be recomputed host-side instead.

#### 2.1 The click-anchor exception (R2 TL-M-2)

There is exactly one place where the JS view is authoritative for a
single host operation: the **click anchor carried in the
`rangeSelectCommit` / `addRangeSelectCommit` message payload**.

When the user shift-clicks, the user's intent is "extend from the
anchor I most recently established with a plain or ctrl click — the
one I see highlighted". The host's cached `anchorHash` can drift one
render behind the JS-side `let anchorHash` mirror (e.g. a refresh
fired between the prior plain-click and the current shift-click).
Trusting the host cache in that window would compute a range from a
stale anchor, producing visibly wrong selection.

The fix: the message carries `anchorHash: string | null` alongside
`commitHash`. The host overwrites
`_extendedLogState.anchorHash = message.anchorHash` BEFORE it computes
the range, then runs the operation. The JS view wins for THIS click,
becomes the new anchor of record, and subsequent operations are
back to host-authoritative.

This is consistent with the rest of the policy because the message IS
host-bound state mutation — the JS isn't deriving a rule from local
state, it's telling the host "here's the user's anchor; use it."
Treating the message field as authoritative is the same as treating
`commitHash` as authoritative: both come from the same gesture.

**Counter-example.** If the JS computed `isSquashEnabled` locally
(walking the rendered rows for contiguity / merge-commit detection)
and posted that boolean alongside the click, that would NOT be a
permitted exception — it's a rule derivation, and rules stay
host-side regardless of how convenient JS-side computation might
look. The exception above narrowly admits user-gesture state
mutations (a click that the user just made, where the JS-side value
IS the freshest source of intent); it does not admit JS-side rule
evaluation. If a future contributor reaches for "we'll just compute
it in the webview and post the answer" for a NEW gating rule, the
correct response is "post the gesture, let the host compute the
answer, and post the answer back via `updateMenuEnableState`."

### 3. Posting contract: one message type per state surface

For each surface the host owns:

- The host MUST post a typed message after every state change that
  could affect the surface.
- The webview MUST cache the latest payload in a single named
  variable (e.g. `menuEnableMap`) and apply it on demand.
- Application MUST be idempotent — if the menu is already open when
  a fresh payload arrives, the apply runs again so the user sees the
  live state.
- **Posting MUST follow any `webview.html` reassignment in the same
  call site.** The pre-reload document may swallow the message — the
  new document starts with an empty cached payload, applies the
  default-allow fallback, and the menu briefly mis-renders until the
  next state change triggers a fresh post. R3-1 (TL2-H-1, Senior L-2
  / L-4) was exactly this bug: four selection-mutating methods
  (`toggleCommitSelection`, `selectCommits`, `rangeSelectCommit`,
  `addRangeSelectCommit`) ran `_postMenuStateUpdate()` BEFORE
  `_updateWebview()`, so the post landed on the doomed document. The
  fix reorders to render-then-post and adds `_postSyncSelection` so
  the new document also rehydrates `let anchorHash` immediately.
  When in doubt: render first, post last.
- **Any host method that calls `_post*` helpers fires
  `onDidChangeState` BEFORE the post sequence.** This generalizes the
  rule beyond the five selection setters: any future method that
  mutates host state and posts a wire message follows the same
  ordering. Subscribers should see "state changed" on the same
  event-loop tick the host knows it; the actual post-to-webview is a
  downstream concern. The full ordering inside such a method is
  therefore: `_updateWebview()` → `this._onDidChangeState.fire()` →
  `_postSyncSelection()` → `_postMenuStateUpdate()`. R4-7 (Senior L-2)
  aligned the four R3 setters with `selectCommit`; R5-1 (TL4-M-1)
  brought `updateLogState` into the same shape so the rule applies
  uniformly across post-emitting methods. (Methods that only call
  `_updateWebview()` + `fire()` without posts — `refresh`,
  `setHasRepository`, `setCherryPickedHashes`,
  `setAvailableRepositories` — are unaffected: there is no post for
  the fire to precede.)

Wave A's surfaces and message types:

| Surface | Message | Owner |
|---|---|---|
| Menu visibility + enable | `updateMenuEnableState` | host |
| Anchor + selection mirror | `syncSelection` | host |
| Details panel HTML | `updateDetailsPanel` | host |
| Graph row highlight | `selectGraphRow` | host |
| Branch focus + on-path set (Wave D / D2 + D3) | `updateBranchFocus` | host |

The list is append-only as new surfaces are added.

> **Wave D — `updateBranchFocus`**: posted by
> `GitToolWindowProvider.setFocusedBranch` after `_focusedPathHashes`
> recomputation. Carries `focusedBranchName: string | null` and
> `focusedHash: string | null`. The webview's inline-script handler
> caches the payload into a `let branchFocus` and toggles
> `branch-label-focused` on every chip whose `data-branch-name`
> matches. Render-time application in `_getBranchLabelsHtml` is the
> source of truth; the partial-update message exists so a focus
> change without a full re-render still updates the chip outline
> (Wave D Trap T-7).
>
> **Wave D R1 / TLD-M-1 — ordering correction**: the Wave D drop
> originally fired + posted BEFORE `_updateWebview()` (Senior
> caught the regression in R1). The corrected `setFocusedBranch`
> tail follows the R5-1 (TL4-M-1) generalisation:
> `_updateWebview()` → `_onDidChangeState.fire()` →
> `_postBranchFocusUpdate()` (render first, fire second, post
> last). This applies to the named-branch path AND the null-clear
> early-return path. The post lands on the new document, not the
> doomed pre-reload one.
>
> **Wave D R1 / Senior M-3 — payload slimmed**: an earlier draft
> of `updateBranchFocus` carried `focusedPathHashes: string[]`. The
> JS handler never read it (the SVG dim/brighten lands during the
> full re-render that follows the post; the path data is host-
> cached in `_focusedPathHashes`). R1 dropped it from the wire.

> **FU (R5-7, TL4-L-4)**: when Wave C adds another sequencing sub-rule,
> consider bifurcating §3 into "§3 Posting contract (basic)" + "§3a
> Sequencing rules", or splitting out a new ADR-N. Five sub-rules is
> the upper edge of tractable for one section.

### 4. Defense in depth at the action boundary

Even with the host as source of truth, the webview can still have
stale state for one render frame between a re-render and the next
posted message. To stop a stale right-click from firing the wrong
action, the host validates again at action-fire time:
`_handleCommitContextMenu` checks every `commitHashes` value against
`commitNodes` and aborts with a "selection changed, please retry"
toast if any is missing. R1 TL-M-4.

### 5. Selection mutations come in two flavors (R3 TL2-M-4)

Wave A's selection setters split along an intentional axis:

- **Partial** (`postMessage`-only) — for the hot single-select path.
  `selectCommit` is the only example: it mutates host state, then
  posts `selectGraphRow` + `updateDetailsPanel` and returns. The
  webview never reloads — the existing document patches its own DOM
  in-place via the message handlers. This preserves graph scroll
  position and is cheap on a 200-row commit list. Use partial when
  ONLY the highlighted row + details pane need to change.
- **Full** (`_updateWebview()`) — for everything else.
  `toggleCommitSelection`, `selectCommits`, `rangeSelectCommit`,
  `addRangeSelectCommit`, and `updateLogState` all rebuild the graph
  panel HTML and reset the inline-script state. Use full when commit
  list, anchor state, or selection cardinality changes — i.e. when
  the host needs the new document to start with a known-good
  `data-anchor-hash` + `data-selected-count` attribute, plus a fresh
  `menuEnableMap` posted right after the reload (§3).

When in doubt, prefer full. Partial is an optimization for the
single-click happy path that has explicit per-message DOM mutations
covering exactly what changes; extending it to multi-row selection
would require a partial-update message for every kind of edit, and
the resulting matrix is what `_updateWebview()` already covers in
one shot.

### 6. Display-order vs replay-order at the git boundary (Wave B R1 TLB-M-2)

The Git Tool Window's commit list is rendered NEWEST-FIRST: the most
recent commit sits at the top, the oldest at the bottom. That's the
"display order." When the user multi-selects commits and triggers a
git operation, each operation expects a specific direction:

- **`git cherry-pick A B C`** replays commits in argument order. The
  user's intent is "redo these commits, oldest first, on top of HEAD."
  Argv MUST be OLDEST-FIRST: `git cherry-pick <oldest> ... <newest>`.
  The Wave A R4-3 WARNING on `getSelectedCommits()` documents the
  newest-first display contract; cherry-pick callers MUST `.reverse()`
  the result before invoking git.
- **`git revert --no-edit A B C`** also replays in argument order, but
  for revert the right direction is NEWEST-FIRST: undoing the most
  recent change first lets each subsequent revert apply to a tree the
  user can mentally check against the displayed log. No `.reverse()`.
- **`git rebase -i …` / `drop` / `squash`** replays oldest-first like
  cherry-pick. Wave C handlers MUST `.reverse()` before issuing the
  rebase plan.
- **`git format-patch <oldest>^..<newest>`** emits one numbered
  `.patch` per commit in the range, in topological (oldest-first)
  order. The endpoints are picked from the display indices: smallest
  index = newest, largest index = oldest.

Wave B made these direction decisions by hand at four call sites
(`_handleCherryPick` reverses; `_handleRevert` doesn't; `_handleCreatePatchMulti`
projects to oldest-first inside; `_handleCompareVersions` swaps
LHS/RHS to OLDER ↔ NEWER). To remove the footgun for future callers
(palette commands, scripted entry points, Wave C's drop/squash), the
provider exposes a typed sibling helper:

- `GitToolWindowProvider.getSelectedCommits()` — newest-first display
  order. Use for revert / clipboard / `Compare Versions` lhs/rhs
  picking / status-bar count.
- `GitToolWindowProvider.getSelectedCommitsOldestFirst()` — chronological
  replay order (the reversed sibling). Use for cherry-pick / drop /
  squash / rebase. The naming makes the direction explicit at the call
  site so a contributor doesn't have to remember to `.reverse()`.

Wave B R1 (TLB-H-2) also pushed display-order forward through the
context-menu dispatch event payload, so handlers receive
`{commitHashes, commitNodes}` directly and don't reach back into
provider state. ADR-009 §1 inversion fix. Wave B R2 (TLBR1-L-1)
collapsed the originally-parallel `displayOrder: string[]` +
`parentCounts: Record<string, number>` records to the typed
`commitNodes: readonly IMenuStateNode[]` (same shape used by the menu
helper) — one lookup, one test-fixture, one source of truth.

The two seams converge: webview-driven flows derive
`displayOrder = commitNodes.map(n => n.hash)` from the event and
`.reverse()` inline at the call site for cherry-pick; external
programmatic callers take `getSelectedCommitsOldestFirst()` (and pass
it straight to git). Both produce the same direction.

## Consequences

### Positive

- **Single source of truth.** Every menu rule lives in one
  module-level helper (`multiSelect.ts`), tested by one set of unit
  tests. No mirror. No drift.
- **Per-FILE behavioral floor honored** (ADR-007). The host helper
  has unit tests; the host wiring has unit tests asserting the message
  is posted with the right payload; the webview apply-loop has a
  structural test asserting it reads `menuEnableMap` and toggles the
  expected classes.
- **Future surfaces ride the same pattern.** Wave B (compare
  versions) and Wave C (squash execution) will add new menu actions —
  each just gets a `MultiSelectMenuAction` enum entry, a rule line in
  `computeMenuState`, and one unit test. Zero JS edits.

### Negative

- **One extra message per selection change.** Cheap (the helper is
  O(N) on `commitNodes.length` and the payload is ~15 entries × 2
  booleans), but it does mean the webview has to handle more message
  types. Acceptable.
- **A malicious/buggy host can post a payload that disables every
  action.** The webview's defensive default ("apply enables" when
  `menuEnableMap` is null) keeps the menu usable on script-execution
  before the first payload arrives, but a poisoned subsequent payload
  could still hide everything. The threat model here is "we own both
  sides of the wire," so this is not a real risk; if it ever became
  one, a payload signature/version check would be additive.

### Neutral

- **The pattern doesn't apply to every webview.** Console / Incoming /
  UpdateInfo / History tabs are render-only — no interactive rules to
  derive. They keep their existing one-direction flow.

## Alternatives considered

### Bundling the helper module into the inline script

Use a build step (e.g. `esbuild` on `multiSelect.ts` → string-injected
into the inline-script template literal). Removes the duplication
without the message round-trip. Rejected because:

- The build step has no other consumer in this codebase. The
  bundler would exist solely for one helper.
- Bundling makes per-test source maps harder; debugging the inline
  script in the VS Code webview devtools would point at minified
  output.
- The host-precomputed-map approach has independent value (the host
  needs `computeMenuState` to validate at action-fire time anyway —
  TL-M-4).

### Polymorphism via per-rule message types

Have the host post `{type: 'setMenuEnabled', action: 'editCommitMessage',
enabled: true}` per rule rather than one big map. Rejected because the
webview would need to cache the partial state in a more complex shape,
and reasoning about "did all the rules update?" would require the host
to send a barrier message — more complexity for no win.

### Keeping the JS-side mirror with a structural-guard test for drift

A test that statically diffs the host helper's case bodies against the
JS switch arms. Rejected because the test is brittle to formatting
changes, and any drift is silent until the test runs (the JS itself
just behaves wrong).

## Cross-references

- ADR-007: Structural guards as a complementary tool — the host helper
  unit tests are the authoritative spec; the structural webview test
  is the floor.
- Wave A spec: tasks #1 (Wave A), #2 (Wave B), #3 (Wave C).
- R1 review findings: TL-H-2, TL-H-3, TL-H-4, TL-M-3, Senior M-3.

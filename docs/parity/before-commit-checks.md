# Parity reference — Before-commit checks (ICheckinHandler)

Status: living document (Wave A — Commit/Changelists)

Layer-3 (ADR-010) parity reference for IntelliG's before-commit check
framework (`src/commits/CheckinHandlers.ts` + `CheckinChecks.ts`), porting
git4idea's `ICheckinHandler` / `CheckinHandlerFactory`
(`GitCheckinHandlerFactory.kt:55-516`).

---

## 1. Model

- An `ICheckinHandler` is a **pure** named check: given an `ICheckinContext`
  snapshot it returns zero or more `ICheckinProblem`s (`error` blocks, `warning`
  advises). No I/O inside a handler.
- `ICheckinContext` is gathered once by `gatherCheckinContext`
  (`CheckinChecks.ts`): git `user.name`/`user.email` (via the `gitCli` escape
  hatch, ADR-001), the committed-path working-tree statuses, and a
  detached-HEAD flag.
- `runCheckinHandlers` runs the chain in order and aggregates problems;
  `runBeforeCommitChecks` presents a modal and returns whether the commit may
  proceed.

## 2. Ported checks (this wave)

| Handler                  | git4idea source                          | Severity | Fires when… |
| ------------------------ | ---------------------------------------- | -------- | ----------- |
| `git.user.name`          | `GitUserNameCheckinHandler`              | error    | `user.name` and/or `user.email` is observably unset. **Never** fires when config could not be read (`userIdentityResolved === false`) — indeterminate ≠ missing. |
| `git.unresolved.merge`   | unmerged-path guard                      | error    | a committed file is still `conflicted` (`U`). |
| `git.detached.root`      | `GitDetachedRootCheckinHandler`          | warning  | HEAD is detached (commit lands on no branch). |

Follow-ups (framework already accepts them without change): CRLF, large-file,
bad-filename (`GitCRLFCheckinHandler` / `GitLargeFileCheckinHandler` /
`GitFileNameCheckinHandler`).

## 3. Trigger / bypass

- Checks run automatically before every commit on:
  - the classic `CommitDialog` (`_handleCommit`),
  - the `CommitToolWindow` (`_handleCommit`),
  - `intellig.changelist.commitOnly`.
- The gear menu's **Run before-commit checks** entry previews the checks
  without committing.
- `--no-verify` (the persisted gear toggle, `intellig.commit.lastNoVerify`)
  bypasses BOTH git's own hooks AND these IDE-side checks — the caller simply
  does not invoke `runBeforeCommitChecks`. This keeps "skip the safety nets"
  consistent across hook and IDE checks.
- A blocking (`error`) problem shows a modal whose proceed button is
  "Commit Anyway"; warnings show "Commit". Declining aborts the commit.

## 4. Test coverage

- `changelistCommit.test.ts` — per-handler unit tests + `runCheckinHandlers`
  aggregation/ordering.
- `checkinChecks.test.ts` — `gatherCheckinContext` (config read, status map,
  detached detection, absent-hatch no-false-positive) + `formatCheckinProblems`
  ordering.
- `changelistCommitPlan.property.test.ts` — `runCheckinHandlers` invariants
  (blocking iff an error exists; never blocks on unresolved identity without a
  conflict; a conflict always blocks).

# ADR-005: Sanitizer pass ordering in `sanitizeGitError`

Status: Accepted (2026-05-12)

## Context

`sanitizeGitError` in `src/git-core/gitError.ts` scrubs two classes of
sensitive fragment out of git stderr before the string reaches a toast,
OutputChannel line, or structured error payload:

- **Credentialed remote URLs** — `git` embeds `user:token@host` in
  `fatal: unable to access …` messages. Tokens in a user's notification
  history, screen recording, or bug report are an exfiltration surface.
- **Absolute home-dir paths** — `fs` errnos print `/Users/<name>/…` or
  `C:\Users\<name>\…` verbatim. Screen recordings and bug reports leak
  the user's real account name plus project-location hints.

The helper is a single function that chains four `replace()` calls.
Order matters in non-obvious ways that earlier iterations got wrong,
and review kept catching the same class of regression. This ADR
documents the ordering rule so the next change touches the function
with the trap already visible.

## Decision

The four passes run in exactly this order:

1. **Credential URL regex** — `https?://user:token@host…` →
   `https?://<redacted>@host…`. Runs first so the absolute-path passes
   that follow cannot accidentally consume a URL fragment that the
   credential pass should have collapsed.

2. **Windows backslash home path** — `C:\Users\<name>\` → `~\`.

3. **Windows forward-slash home path** — `C:/Users/<name>/` → `~/`.
   **Must run before the POSIX pass** because VS Code frequently
   normalises Windows paths to forward slashes, and the POSIX regex
   would otherwise find a match inside the drive-letter-prefixed
   string and leave `C:~/x.ts` as the output. Letting the Windows
   forward-slash pass consume the full `C:/Users/<name>/` prefix
   lets the POSIX pass see no match on that fragment.

4. **POSIX home path** — `/Users/<name>/` or `/home/<name>/` → `~/`.
   Runs last because it is the most general shape.

Every home-path regex is **left-anchored** on group [1]: either
start-of-string or one of `[\s'"([]`. Without the anchor, an earlier
version of the helper rewrote a legitimate substring like
`/repo/Users/alice/data/` into `/repo~/data/` (the `/Users/alice/`
fragment matched mid-path). The anchor preserves repo paths that
legitimately contain a `Users` or `home` directory name. The captured
delimiter is re-emitted via `$1` in the replacement so surrounding
text is untouched.

## Consequences

### Positive

- The order rule is explicit: re-ordering any pair of passes either
  breaks Windows forward-slash collapsing (swap 3 & 4) or lets a
  credentialed URL partially survive (move 1 later). Each swap fails
  an existing unit test, so the ordering is self-enforcing as long as
  the test suite runs.
- The left-anchor rule protects every home-path regex from false
  positives inside legitimate repo paths. Adding a new home-path
  regex (e.g. a new OS prefix) inherits the anchor by convention and
  can reuse the existing test patterns as a template.

### Negative / costs

- Four passes over the string instead of one combined regex. The
  throughput difference is invisible at error-message sizes; we
  prefer the four-pass form because each regex is independently
  reviewable and the test surface per-pass is legible.
- The helper is not i18n-aware. A user whose home directory lives
  under a non-`Users`/`home` prefix (e.g. `/workspace/alice/` in a
  devcontainer) gets no redaction for that shape. This is a
  deliberate scope limit; the helper only promises to catch the
  well-known Unix and Windows shells of home paths. Downstream
  surfaces that need stricter redaction should layer on top.

### Neutral

- The helper is pure and dependency-free. Every git-adjacent surface
  can call it without taking on a service dependency or a setup cost.

## Regressions the ordering prevents

Three specific shapes have historically broken when the ordering or
left-anchor was wrong; each is now pinned by a unit test:

- **Drive-letter escape** (pre-ordering fix): input
  `log:/Users/alice/x` passing through the POSIX regex before the
  Windows forward-slash regex produced `lo~/x` — the POSIX regex
  greedily consumed the `g:` drive-letter as delimiter-adjacent
  whitespace. Now blocked because the forward-slash Windows pass
  (which requires `[A-Za-z]:/Users/…`) runs first, leaving the
  mid-path `Users` in the POSIX phase a non-match (wrong anchor).

- **Mid-path collision** (pre-left-anchor fix): input
  `/repo/Users/alice/data/` produced `/repo~/data/`. Now blocked
  because the POSIX regex requires either start-of-string or a
  delimiter character at group [1]; a `/` alone is not a delimiter.

- **Bracketed URL credentials** (pre-credential-pass fix): input
  `push failed: [https://alice:secret@example.com/repo.git]` bypassed
  earlier regexes that required whitespace on both sides. Now blocked
  because the credential regex is scheme-anchored, not delimiter-
  anchored — `\b(https?)://` matches inside brackets.

## References

- `src/git-core/gitError.ts` — the helper itself, with JSDoc on each
  regex explaining the left-anchor and ordering rationale.
- `test/unit/utils/gitError.test.ts` — pinned regressions for
  each of the three shapes above. Adding a new redaction pass must
  extend this suite first.

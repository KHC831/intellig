# Parity review (Round 2) — <AREA>

_Round-2 deep review by an assigned tech-lead. North-star = IntelliJ git4idea + the
IntelliJ Platform (full clone at `~/Documents/workspace/intellij-community`). Our
extension = `intellig` (VS Code). **You own this component.** Round 1 enumerated gaps;
Round 2 is a fresh, opinionated tech-lead pass — re-verify R1's findings against the
CURRENT code, AND surface whatever you judge important for this component regardless of
whether R1 named it. Do not limit yourself to the gaps the lead called out._

## Mandate (decide what matters for YOUR component)
You are the tech-lead for this area. Cover at least:
- **Feature/behavior gaps** vs IntelliJ — including ones R1 missed.
- **Code differences** — where our impl diverges from git4idea's approach in a way that
  causes wrong/risky behavior (not cosmetic). Cite git4idea file + our file:line.
- **Blockers** — anything that stops a feature from working end-to-end (dead UI,
  unwired handlers, missing service plumbing, F5-only confirmable).
- **Security / abuse gaps** — argv injection, credential leakage in errors/logs,
  unsanitized toasts, CSP/webview holes, path traversal, destructive-op without confirm.
- **Correctness regressions / silent-wrong git ops** — the highest parity weight.
- Anything else you, as owner, judge important (perf, test coverage holes, arch debt).

## Reference map
- **git4idea / platform source reviewed:** `<paths under intellij-community>`
- **intellig source reviewed:** `<paths under intellig/src>`

## R1 follow-up (verify each prior finding against current code)
| R1 gap | R1 status | Current status (re-verified) | Commit that closed it (if any) | Notes |
|---|---|---|---|---|

## Gap table (Round 2 — fresh)
One row per distinct capability/finding. **Source** + **Severity** mandatory.

| Capability / finding | IntelliJ behavior | intellig behavior | Status | Severity | Source | Notes / file refs |
|---|---|---|---|---|---|---|

Status legend: ✅ parity · 🟡 partial · ❌ missing · ➕ ours-only · 🔁 regression-since-R1
Severity legend: 🔴 blocker/silent-wrong/security · 🟠 high (daily-hit feature) · 🟡 medium · ⚪ polish
Source legend: `git4idea` (portable git logic) · `platform` (UI we hand-build) · `mixed`

## Top findings (ranked, this component)
1. **<finding>** — _why it matters_ (parity weight: silent-wrong git op > security > missing feature > visual).
   Severity: 🔴/🟠/🟡/⚪. Source. Effort: S/M/L. Files to touch: …

## Security review (this component)
_Argv injection, credential/path leakage, unsanitized surfaces, CSP, destructive confirms.
"None found" is a valid, useful answer — say so explicitly._

## Blockers
_What prevents end-to-end function: dead/unwired UI, missing plumbing, F5-only items._

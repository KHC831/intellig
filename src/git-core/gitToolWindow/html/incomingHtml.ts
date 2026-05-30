/**
 * Phase 1 stub for the Incoming tab body.
 *
 * Full implementation ships in Phase 2 (design §3.6 staging).
 */

export function renderIncomingTabBody(): string {
  return `
    <div class="intellig-tab-stub" role="status">
      <h3>Incoming</h3>
      <p>The list of unpulled upstream commits is coming soon.</p>
      <p class="intellig-tab-stub-hint">
        Use the status bar incoming badge (↓N) and
        <code>IntelliG: Pull…</code> in the meantime.
      </p>
    </div>
  `;
}

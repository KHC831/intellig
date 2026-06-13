// Type-only import of the log-state shape the provider owns. This is erased
// at compile time, so the provider importing this interface while this file
// imports the provider's type is NOT a runtime cycle — both directions must
// stay `import type` to keep it erasable.
import type { ICommitDetails } from '../../../services/interfaces';
import type { IExtendedLogState } from '../GitToolWindowProvider';

/**
 * The slice of the Git tool window provider that extracted builder and
 * handler modules need to reach back into. The provider class implements this
 * interface, so passing `this` to an extracted function gives it a narrowed,
 * read-only-by-default view — it can call the listed methods but cannot reach
 * the provider's private fields.
 *
 * The interface grows as more code is extracted: a member is added only when
 * a moved function actually needs it.
 */
export interface IGtwControllerContext {
  /** Per-render Content-Security-Policy nonce (from the webview base class). */
  getNonce(): string;
  /** The shared inline CSS injected into every webview HTML document. */
  getInlineStyles(): string;
  /**
   * Fire the "load more commits" request event. Exposes only the fire
   * capability — the EventEmitter itself stays private to the provider so
   * extracted handlers can request more commits without gaining subscribe or
   * dispose access to the emitter.
   */
  fireLoadMoreCommits(): void;
  /**
   * Apply new graph/details panel width percentages. Exposed as a mutation
   * method rather than a writable property because the in-memory write and
   * the workspace-state persistence are a coupled invariant the provider
   * owns — a bare setter would let a caller update the widths without
   * persisting them. The handler states the intent; the provider keeps the
   * write + persist atomic and keeps workspace state encapsulated.
   */
  setPanelWidths(widths: [number, number]): void;
  /**
   * The LIVE extended log state — the same object the provider holds, not a
   * copy. Extracted handlers read and mutate it field-by-field (selection
   * set, anchor, expanded commit, filter, …) exactly as the in-class code
   * did. Exposed as a read-accessor over the single class-owned field rather
   * than per-field mutation methods: the state is poked across many sites, so
   * a method per mutation would explode the interface, and the live reference
   * means there is no second copy to keep in sync. Side-effects that used to
   * accompany those mutations (state-change event, webview posts) become
   * their own context methods as later handlers reach them.
   */
  get extendedLogState(): IExtendedLogState;
  /** Single-select the given commit (pass-through to the in-class method). */
  selectCommit(hash: string): void;
  // The capability methods below each delegate to the matching in-class impl
  // (or emitter) so the webview reference and the EventEmitter stay
  // encapsulated on the provider, and so those instance methods remain
  // patchable — the render-then-post ordering tests reassign them on the
  // instance and observe the call order through these delegations.
  /** Re-render the webview document (full template refresh). */
  updateWebview(): void;
  /** Fire the onDidChangeState event. */
  fireDidChangeState(): void;
  /** Post the host's anchor + selection to the webview's JS-side mirror. */
  postSyncSelection(): void;
  /** Post the recomputed context-menu enable map to the webview. */
  postMenuStateUpdate(): void;
  /** Post the details-panel payload for the currently-expanded commit. */
  postDetailsForExpandedCommit(): void;
  /**
   * Clear the pending changed-files payload + its error together. Exposed as
   * a single mutation method (not two writable fields) because the two
   * always clear as a pair — a partial clear would leak a half-loaded
   * changed-files payload into the next details-panel render.
   */
  clearPendingChangedFiles(): void;
  /**
   * Whether a webview view is currently attached. Lets handlers gate the
   * graph-row + details-panel posts on a live view without exposing the
   * webview reference itself.
   */
  hasView(): boolean;
  /**
   * Send a raw message to the attached webview. Only the send routes through
   * the context — the message objects are constructed by the handler — so the
   * webview reference stays encapsulated on the provider while the payload
   * shape stays at the call site.
   */
  postToWebview(msg: unknown): void;
  /**
   * Fire the onDidSelectCommit event with the single-selected hash. Exposes
   * only the fire capability so handlers can announce the click-driven
   * selection without gaining subscribe or dispose access to the emitter.
   */
  fireDidSelectCommit(hash: string): void;
  /** Render the details-panel HTML for the given commit. */
  getDetailsPanelHtml(details: ICommitDetails): string;
  /** Render the empty/placeholder details-panel HTML. */
  getDetailsPanelPlaceholderHtml(): string;
}

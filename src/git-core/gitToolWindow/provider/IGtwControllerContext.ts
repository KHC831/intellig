/**
 * The slice of the Git tool window provider that extracted builder and
 * handler modules need to reach back into. The provider class implements this
 * interface, so passing `this` to an extracted function gives it a narrowed,
 * read-only-by-default view — it can call the listed methods but cannot reach
 * the provider's private fields.
 *
 * The interface grows as more code is extracted: a member is added only when
 * a moved function actually needs it. It currently exposes the two callbacks
 * the relocated HTML view builders depend on — the per-render nonce and the
 * shared inline style sheet (whose color literals stay owned by the class).
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
}

// Type-only import of the log-state shape the provider owns. This is erased
// at compile time, so the provider importing this interface while this file
// imports the provider's type is NOT a runtime cycle — both directions must
// stay `import type` to keep it erasable.
import type * as vscode from 'vscode';
import type { ICommitDetails } from '../../../services/interfaces';
import type { IExtendedLogState } from '../GitToolWindowProvider';
import type { IRemoteUrl } from '../../../utils/remoteUrl';
import type { DetailsGroupBy } from './detailsPanelModel.types';
import type { DetailsPanelModel } from './detailsPanelModel';
import type { GitToolWindowOutbound } from '../gitToolWindow.protocol';

/**
 * The slice of the Git tool window provider that extracted builder and
 * handler modules need to reach back into. The provider class implements this
 * interface, so passing `this` to an extracted function gives it a narrowed
 * view — the read accessors plus the specific mutation, fire, and post
 * capabilities each extracted handler needs — without exposing the provider's
 * private fields, emitters, or webview reference.
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
   * `asWebviewUri` of the bundled `media/webview/gitToolWindow.js` entry for the
   * given webview, as a string. The pre-graph documents (loading / no-repo /
   * undocked) load the same bundle so the tool window ships one client script;
   * the entry no-ops on the panels those documents lack and wires their action
   * buttons (init-repo / focus-undocked).
   */
  getWebviewBundleUri(webview: vscode.Webview): string;
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
  postToWebview(msg: GitToolWindowOutbound): void;
  /**
   * Fire the onDidSelectCommit event with the single-selected hash. Exposes
   * only the fire capability so handlers can announce the click-driven
   * selection without gaining subscribe or dispose access to the emitter.
   */
  fireDidSelectCommit(hash: string): void;
  /** Build the details-panel render-model for the given commit. */
  getDetailsPanelModel(details: ICommitDetails): DetailsPanelModel;
  /** Build the empty/placeholder details-panel render-model. */
  getDetailsPanelPlaceholderModel(): DetailsPanelModel;
  /**
   * Whether issue/PR auto-linking is enabled. Delegates to the provider's
   * config read so the `intellig.commitMessageIssueLinks` flag lookup stays
   * encapsulated; the details-panel builder consults it to decide whether to
   * turn commit-message refs into links or fall back to plain escaping.
   */
  isIssueLinkingEnabled(): boolean;
  /**
   * The parsed remote URL for the currently-selected repository, or undefined
   * when there is none / it can't be parsed. Delegates to the provider so the
   * parsed-remote cache keyed on the repo root stays owned by the provider;
   * the details-panel builder uses it to resolve issue/PR link targets.
   */
  getSelectedRepoRemote(): IRemoteUrl | undefined;
  /**
   * Display identity of the currently-selected repository — its root basename
   * (`name`) and home-abbreviated root path (`path`) — or undefined when there
   * is no selected repo. The details-panel builder uses it for the changed-files
   * heading ("<name> (<n> files) <path>").
   */
  getSelectedRepoProject(): { name: string; path: string } | undefined;
  /**
   * Whether a hex run from a commit message names a commit in the loaded
   * graph; the details builder links only resolvable runs, leaving hex-ish
   * words inert.
   */
  isKnownCommitHash(hash: string): boolean;
  /** Current Group By mode for the details panel's changed-file list. */
  getDetailsGroupBy(): DetailsGroupBy;
}

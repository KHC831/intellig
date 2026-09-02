/**
 * What a context-menu row is, as data.
 *
 * Deliberately free of DOM types and of the `/// <reference lib="dom" />` the
 * widget carries: the hosts that COMPUTE menu contents are extension-side
 * modules, and they must be able to describe a row without importing anything
 * that expects a `document` to exist.
 */

export interface IContextMenuItem {
  /** A divider rule. Every other field is ignored. */
  separator?: boolean;
  label?: string;
  /** Identifies the row to the pick handler. */
  action?: string;
  /** Right-aligned key hint. */
  shortcut?: string;
  /** Rendered greyed and inert. */
  disabled?: boolean;
  /** Destructive action: rendered in the error tint. */
  danger?: boolean;
  /**
   * Rendered hidden. The Git tool window reveals these through its
   * multi-select enable map once it knows how many commits are selected.
   */
  hiddenByDefault?: boolean;
}

/** Per-action gating a host computes for the current selection. */
export interface IContextMenuRowState {
  visible?: boolean;
  enabled?: boolean;
  /** Why it is unavailable; surfaced as a tooltip on a visible-disabled row. */
  reason?: string;
}

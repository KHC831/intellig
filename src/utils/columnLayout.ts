/**
 * Log-column layout utilities for the Git Tool Window commit list.
 *
 * The commit rows lay out three columns: a flexible title column plus two
 * fixed-width metadata columns — author and date. These helpers own the pure
 * clamp logic for the two resizable fixed columns and persist their widths to
 * workspace state so a user's drag survives re-render and commit-switch.
 *
 * Kept separate from `panelLayout.ts` because the contracts differ: panel
 * widths are two percentages that must sum to the container; column widths are
 * two independent pixel widths each bounded by a per-column min/max, with the
 * title column absorbing the remaining space (flex). There is no sum
 * invariant to preserve here.
 */

import * as vscode from 'vscode';

/** Minimum pixel width for a resizable log column — keeps content legible and
 * guarantees the drag handle can never collapse a column to zero. */
export const MIN_COLUMN_WIDTH = 40;

/** Maximum pixel width for a resizable log column — a hard ceiling so a column
 * can't be dragged so wide it crowds the flexible title column off-screen. */
export const MAX_COLUMN_WIDTH = 600;

/** Workspace state key for persisted log-column widths. */
const COLUMN_WIDTHS_KEY = 'intellig.columnWidths';

/** Default fixed-column pixel widths: [author 120px, date 145px]. Mirrors the
 * historical hardcoded CSS widths so first render is byte-for-byte unchanged. */
export const DEFAULT_COLUMN_WIDTHS: [number, number] = [120, 145];

/**
 * Clamps log-column widths to the per-column [MIN, MAX] pixel bounds.
 *
 * Pure — returns a new tuple and never mutates the input. A non-finite width
 * (NaN/±Infinity) is treated as "no usable value" and falls back to that
 * column's default rather than clamping a garbage number. Finite widths are
 * rounded to whole pixels so the persisted value and the inline CSS stay
 * integer-clean.
 *
 * @param widths - Requested [author, date] widths in pixels.
 * @returns A clamped, whole-pixel [author, date] tuple within bounds.
 */
export function clampColumnWidths(widths: [number, number]): [number, number] {
  return [
    clampOne(widths[0], DEFAULT_COLUMN_WIDTHS[0]),
    clampOne(widths[1], DEFAULT_COLUMN_WIDTHS[1]),
  ];
}

/** Clamp a single column width to [MIN, MAX], substituting `fallback` for any
 * non-finite input, and round to a whole pixel. */
function clampOne(value: number, fallback: number): number {
  const usable = Number.isFinite(value) ? value : fallback;
  const bounded = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, usable));
  return Math.round(bounded);
}

/** Type guard: a stored value is a pair of numbers (range is enforced by the
 * clamp on load, not here, so a slightly-stale persisted value is salvaged
 * rather than discarded). */
function isColumnWidthsTuple(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  );
}

/**
 * Saves log-column widths to VS Code workspace state. Widths are clamped
 * before persisting so the stored value is always within bounds.
 *
 * @param state - The VS Code Memento (workspace state) to persist to.
 * @param widths - The [author, date] column widths in pixels.
 */
export function saveColumnWidths(state: vscode.Memento, widths: [number, number]): void {
  void state.update(COLUMN_WIDTHS_KEY, clampColumnWidths(widths));
}

/**
 * Loads log-column widths from VS Code workspace state.
 *
 * Falls back to DEFAULT_COLUMN_WIDTHS when no value is stored or the stored
 * value is not a pair of numbers. A stored pair is re-clamped on load so an
 * out-of-range value from an older build is corrected rather than trusted.
 *
 * @param state - The VS Code Memento (workspace state) to load from.
 * @returns A valid [author, date] column-width tuple in pixels.
 */
export function loadColumnWidths(state: vscode.Memento): [number, number] {
  const stored = state.get<unknown>(COLUMN_WIDTHS_KEY);

  if (isColumnWidthsTuple(stored)) {
    return clampColumnWidths([stored[0], stored[1]]);
  }

  return [...DEFAULT_COLUMN_WIDTHS];
}

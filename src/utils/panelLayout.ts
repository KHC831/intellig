/**
 * Panel layout utility functions for the 2-panel Git Tool Window.
 * Contains pure functions for panel width constraint logic and
 * panel width persistence helpers.
 */

import * as vscode from 'vscode';

/** Minimum width in pixels for any single panel. */
const MIN_PANEL_WIDTH = 100;

/** Number of panels in the layout. */
const PANEL_COUNT = 2;

/** Minimum container width that can accommodate all panels at their minimum size. */
const MIN_CONTAINER_WIDTH = MIN_PANEL_WIDTH * PANEL_COUNT; // 200px

/**
 * Clamps panel widths to enforce the minimum width constraint and ensure
 * the sum of all panel widths equals the container width.
 *
 * This is a pure function with no side effects.
 *
 * Algorithm:
 * 1. If container width < 200px, distribute equally (each gets containerWidth / 2).
 * 2. Clamp any negative or below-minimum widths to 100px.
 * 3. Adjust the remaining panels proportionally so the total equals containerWidth.
 * 4. If proportional redistribution causes any panel to drop below minimum,
 *    iteratively clamp and redistribute until all constraints are satisfied.
 *
 * @param containerWidth - The total available width in pixels.
 * @param widths - The requested widths for [Graph, Details] panels in pixels.
 * @returns A tuple of two panel widths that satisfy all constraints.
 */
export function clampPanelWidths(
  containerWidth: number,
  widths: [number, number]
): [number, number] {
  // Handle non-positive container width: return minimums (best effort)
  if (containerWidth <= 0) {
    return [0, 0];
  }

  // If container is too small for all panels at minimum, distribute equally
  if (containerWidth < MIN_CONTAINER_WIDTH) {
    const equalWidth = containerWidth / PANEL_COUNT;
    return [equalWidth, equalWidth];
  }

  // Work with a mutable copy
  const result: [number, number] = [...widths];

  // Phase 1: Clamp all panels to at least the minimum
  for (let i = 0; i < PANEL_COUNT; i++) {
    if (!Number.isFinite(result[i]) || result[i] < MIN_PANEL_WIDTH) {
      result[i] = MIN_PANEL_WIDTH;
    }
  }

  // Phase 2: Adjust so the sum equals containerWidth
  const currentSum = result[0] + result[1];
  const diff = containerWidth - currentSum;

  if (Math.abs(diff) < 1e-9) {
    // Already sums correctly
    return result;
  }

  if (diff > 0) {
    // We need to distribute extra space. Add proportionally to panels
    // based on their current share of the total.
    const sumCurrent = result[0] + result[1];
    for (let i = 0; i < PANEL_COUNT; i++) {
      result[i] += diff * (result[i] / sumCurrent);
    }
  } else {
    // We need to remove space. Subtract proportionally from the excess
    // above minimum for each panel.
    const deficit = -diff;
    redistributeDeficit(result, deficit);
  }

  // Final safety: ensure exact sum via rounding adjustment on the last panel
  const finalSum = result[0] + result[1];
  const roundingError = containerWidth - finalSum;
  if (Math.abs(roundingError) > 1e-9) {
    result[1] += roundingError;
  }

  // Final safety: ensure no panel is below minimum (can happen due to floating point)
  for (let i = 0; i < PANEL_COUNT; i++) {
    if (result[i] < MIN_PANEL_WIDTH) {
      result[i] = MIN_PANEL_WIDTH;
    }
  }

  return result;
}

/**
 * Redistributes a deficit (amount to subtract) from panel widths,
 * taking proportionally from each panel's excess above the minimum.
 * Iterates until all panels are at or above minimum and the deficit is consumed.
 */
function redistributeDeficit(
  result: [number, number],
  deficit: number
): void {
  let remaining = deficit;
  const maxIterations = 10; // Safety guard against infinite loops

  for (let iter = 0; iter < maxIterations && remaining > 1e-9; iter++) {
    // Calculate excess above minimum for each panel
    const excesses: number[] = result.map((w) => Math.max(0, w - MIN_PANEL_WIDTH));
    const totalExcess = excesses.reduce((sum, e) => sum + e, 0);

    if (totalExcess < 1e-9) {
      // No excess left to take from — all panels are at minimum
      break;
    }

    // Take proportionally from each panel's excess
    const takeRatio = Math.min(1, remaining / totalExcess);
    let taken = 0;

    for (let i = 0; i < PANEL_COUNT; i++) {
      const take = excesses[i] * takeRatio;
      result[i] -= take;
      taken += take;
    }

    remaining -= taken;
  }
}

/** Workspace state key for persisted panel widths. */
const PANEL_WIDTHS_KEY = 'intellig.panelWidths';

/** Default panel width ratios: [Graph 60%, Details 40%]. */
export const DEFAULT_PANEL_WIDTHS: [number, number] = [60, 40];

/**
 * Validates whether a value is a valid panel width tuple.
 *
 * A valid tuple is an array of exactly 2 numbers where:
 * - Each value is between 5 and 90 (inclusive)
 * - The values sum to approximately 100 (within ±1 tolerance for floating point)
 *
 * @param value - The value to validate.
 * @returns True if the value is a valid panel width tuple.
 */
function isValidPanelWidths(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    return false;
  }

  for (let i = 0; i < 2; i++) {
    if (typeof value[i] !== 'number' || !Number.isFinite(value[i])) {
      return false;
    }
    if (value[i] < 5 || value[i] > 90) {
      return false;
    }
  }

  const sum = (value[0] as number) + (value[1] as number);
  if (Math.abs(sum - 100) > 1) {
    return false;
  }

  return true;
}

/**
 * Saves panel width ratios to VS Code workspace state.
 *
 * @param state - The VS Code Memento (workspace state) to persist to.
 * @param widths - The panel width ratios as percentages, e.g. [60, 40].
 */
export function savePanelWidths(
  state: vscode.Memento,
  widths: [number, number]
): void {
  void state.update(PANEL_WIDTHS_KEY, widths);
}

/**
 * Loads panel width ratios from VS Code workspace state.
 *
 * Falls back to DEFAULT_PANEL_WIDTHS ([60, 40]) if:
 * - No value is stored
 * - The stored value is not an array of 2 numbers
 * - Any value is outside the range [5, 90]
 * - The values do not sum to approximately 100
 *
 * @param state - The VS Code Memento (workspace state) to load from.
 * @returns A valid panel width ratio tuple.
 */
export function loadPanelWidths(
  state: vscode.Memento
): [number, number] {
  const stored = state.get<unknown>(PANEL_WIDTHS_KEY);

  if (isValidPanelWidths(stored)) {
    return [stored[0], stored[1]];
  }

  return [...DEFAULT_PANEL_WIDTHS];
}

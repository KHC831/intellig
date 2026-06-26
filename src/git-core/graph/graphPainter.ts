/**
 * Layer 4 — the graph PAINTER (dumb).
 *
 * Turns a {@link IRowPrintModel} into an SVG string. No topology logic: no active
 * lanes, no continuity inference, no bezier-target/bend heuristics. It only
 * applies geometry (column X, row halves), the single L4 color rule, the
 * focus dim/brighten treatment, and the node-icon/chevron shapes. Mirrors
 * IntelliJ's `GraphCellPainter` consuming PrintElements.
 */

import { getColumnColor } from '../commitGraph';
import { IGraphRenderConfig, getColumnX, isValidLane } from '../../utils/graphRenderer';
import { IRowPrintModel, IRowEdgeElement } from './printModel';

/**
 * Edge stroke color. The print model resolves the owning-branch color and carries
 * it on the element; when absent (test-constructed elements / no branch coloring)
 * fall back to the L4 lane rule: source lane for first-parent/straight strokes,
 * dest lane for merge/branch bends.
 */
function edgeColor(el: IRowEdgeElement): string {
  if (el.color !== undefined) {
    return el.color;
  }
  const colorSource = el.type === 'commit' || !el.curved ? el.fromLane : el.targetLane;
  return getColumnColor(colorSource);
}

export function paintRow(model: IRowPrintModel, config: IGraphRenderConfig): string {
  const { rowHeight, nodeRadius, lineWidth } = config;
  const centerY = rowHeight / 2;
  const bottomY = rowHeight;
  const elements: string[] = [];

  // Focus-aware stroke + opacity (no-op when no branch is focused).
  const onPath = model.node.onFocusedBranchPath;
  const effectiveStroke = model.hasFocusedBranch && onPath ? lineWidth * 1.5 : lineWidth;
  const effectiveOpacity = model.hasFocusedBranch ? (onPath ? 1.0 : 0.6) : 1.0;
  const opacityAttr = model.hasFocusedBranch ? ` opacity="${effectiveOpacity}"` : '';

  // --- Edge segments (verticals + beziers), in builder order ---
  for (const el of model.edges) {
    const color = edgeColor(el);
    const dashAttr = el.style === 'dashed' ? ` stroke-dasharray="4,3"` : '';
    if (!el.curved) {
      const x = getColumnX(el.lane, config);
      const [y1, y2] =
        el.half === 'full' ? [0, bottomY] : el.half === 'up' ? [0, centerY] : [centerY, bottomY];
      elements.push(
        `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${color}" stroke-width="${effectiveStroke}" stroke-linecap="round"${dashAttr}${opacityAttr}/>`
      );
    } else {
      const fromX = getColumnX(el.fromLane, config);
      const toX = getColumnX(el.targetLane, config);
      const d =
        el.half === 'up'
          ? `M ${fromX},0 C ${fromX},${centerY} ${toX},0 ${toX},${centerY}`
          : `M ${fromX},${centerY} C ${fromX},${bottomY} ${toX},${centerY} ${toX},${bottomY}`;
      elements.push(
        `<path d="${d}" stroke="${color}" fill="none" stroke-width="${effectiveStroke}" stroke-linecap="round"${dashAttr}${opacityAttr}/>`
      );
    }
  }

  // --- Commit node icon (on top) ---
  const lane = model.node.lane;
  if (isValidLane(lane)) {
    const cx = getColumnX(lane, config);
    const cy = centerY;
    const fillColor = model.node.color ?? getColumnColor(lane);

    if (model.node.isMerge) {
      const side = nodeRadius * 1.8;
      const bgRadius = side * 0.72;
      elements.push(
        `<circle cx="${cx}" cy="${cy}" r="${bgRadius}" fill="${fillColor}" stroke="none"${opacityAttr}/>`
      );
      elements.push(
        `<rect x="${cx - side / 2}" y="${cy - side / 2}" width="${side}" height="${side}" fill="${fillColor}" stroke="#ffffff" stroke-width="1.5" transform="rotate(45, ${cx}, ${cy})"${opacityAttr}/>`
      );
    } else if (model.node.isBranchSplit) {
      elements.push(
        `<circle cx="${cx}" cy="${cy}" r="${nodeRadius}" fill="${fillColor}" stroke="${fillColor}" stroke-width="2"${opacityAttr}/>`
      );
      const tickLength = nodeRadius * 0.8;
      const bottomX = cx;
      const bottomCY = cy + nodeRadius;
      const angleLeft = Math.PI / 6;
      const leftEndX = bottomX - tickLength * Math.sin(angleLeft);
      const leftEndY = bottomCY + tickLength * Math.cos(angleLeft);
      const rightEndX = bottomX + tickLength * Math.sin(angleLeft);
      const rightEndY = bottomCY + tickLength * Math.cos(angleLeft);
      elements.push(
        `<line x1="${bottomX}" y1="${bottomCY}" x2="${leftEndX}" y2="${leftEndY}" stroke="${fillColor}" stroke-width="${effectiveStroke}" stroke-linecap="round"${opacityAttr}/>`
      );
      elements.push(
        `<line x1="${bottomX}" y1="${bottomCY}" x2="${rightEndX}" y2="${rightEndY}" stroke="${fillColor}" stroke-width="${effectiveStroke}" stroke-linecap="round"${opacityAttr}/>`
      );
    } else {
      elements.push(
        `<circle cx="${cx}" cy="${cy}" r="${nodeRadius}" fill="${fillColor}" stroke="${fillColor}" stroke-width="2"${opacityAttr}/>`
      );
    }

    if (model.node.isTerminal) {
      // The tip/terminal node is emphasized with a white ring just OUTSIDE the
      // colored disc. The disc is filled out to the ring radius so the node
      // reads as one solid dot with a white outline.
      const ringRadius = nodeRadius + 1.5;
      elements.push(
        `<circle cx="${cx}" cy="${cy}" r="${ringRadius}" fill="${fillColor}" stroke="${fillColor}" stroke-width="1.5"${opacityAttr}/>`
      );
      elements.push(
        `<circle cx="${cx}" cy="${cy}" r="${ringRadius}" fill="none" stroke="#ffffff" stroke-width="1.5"${opacityAttr}/>`
      );
      elements.push(
        `<circle cx="${cx}" cy="${cy}" r="${nodeRadius}" fill="${fillColor}" stroke="${fillColor}" stroke-width="1"${opacityAttr}/>`
      );
    }
  }

  // --- Off-window "more history below" chevrons ---
  if (model.chevronLanes.length > 0) {
    const armW = nodeRadius;
    const armH = nodeRadius;
    const tipY = rowHeight - 1;
    for (let ci = 0; ci < model.chevronLanes.length; ci++) {
      const cl = model.chevronLanes[ci];
      if (!isValidLane(cl)) {
        continue;
      }
      const x = getColumnX(cl, config);
      const color = model.chevronColors?.[ci] ?? getColumnColor(cl);
      elements.push(
        `<path d="M ${x - armW},${tipY - armH} L ${x},${tipY} L ${x + armW},${tipY - armH}" stroke="${color}" fill="none" stroke-width="${effectiveStroke}" stroke-linecap="round" stroke-linejoin="round"${opacityAttr}/>`
      );
    }
  }

  // --- SVG width: max inked lane across THIS row (matches the legacy per-row sizing) ---
  let maxCol = 0;
  for (const l of model.inkedLanes) {
    if (isValidLane(l) && l > maxCol) {
      maxCol = l;
    }
  }
  const svgWidth = (maxCol + 1) * config.columnWidth + config.padding * 2;

  return `<svg width="${svgWidth}" height="${rowHeight}">${elements.join('')}</svg>`;
}

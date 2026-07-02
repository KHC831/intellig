// Line mapping between two merge panes for scroll sync: anchors are the
// aligned change ranges (half-open, sorted); lines between anchors keep the
// running shift, lines inside an anchor map proportionally. Lines may be
// fractional (scroll positions between line tops) and map continuously, so
// synced panes glide instead of snapping a line at a time.

export interface IAlignAnchor {
  readonly start1: number;
  readonly end1: number;
  readonly start2: number;
  readonly end2: number;
}

/** Maps a side-1 line to its aligned side-2 line. Invert anchors to map back. */
export function mapLine(anchors: readonly IAlignAnchor[], line: number): number {
  let shift = 0;
  for (const anchor of anchors) {
    if (line < anchor.start1) {
      break;
    }
    if (line < anchor.end1) {
      const size1 = anchor.end1 - anchor.start1;
      const size2 = anchor.end2 - anchor.start2;
      return anchor.start2 + ((line - anchor.start1) / size1) * size2;
    }
    shift = anchor.end2 - anchor.end1;
  }
  return line + shift;
}

/** Swaps the two sides of each anchor, for mapping in the other direction. */
export function invertAnchors(anchors: readonly IAlignAnchor[]): IAlignAnchor[] {
  return anchors.map((a) => ({ start1: a.start2, end1: a.end2, start2: a.start1, end2: a.end1 }));
}

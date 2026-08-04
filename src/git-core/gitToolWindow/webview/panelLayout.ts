/// <reference lib="dom" />
/**
 * Panel-geometry wiring for the Git tool window webview: the graph/details
 * divider (drag + arrow keys, vertical-layout switch) and the Author/Date
 * log-column resize handles. Both post their final sizes so the host persists
 * them across renders. Extracted verbatim from the entry.
 */

import type { GitToolWindowInbound } from '../gitToolWindow.protocol';

type PostLog = (message: GitToolWindowInbound) => void;

// ─── Panel divider drag (graph ↔ details) ────────────────────────
// Drag or arrow-key the `.panel-divider` to repartition the two panels; the
// final percentages post as `panelResize` so they persist across renders.
export function setupDividerDrag(post: PostLog): void {
  const layoutMaybe = document.querySelector<HTMLElement>('.three-panel-layout');
  if (!layoutMaybe) {
    return;
  }
  // Bind a non-null local: the hoisted `checkVerticalLayout` closure below
  // otherwise re-widens the guarded const back to `HTMLElement | null`.
  const layout: HTMLElement = layoutMaybe;
  const panels = layout.querySelectorAll<HTMLElement>('.panel');
  const dividers = layout.querySelectorAll<HTMLElement>('.panel-divider');
  let activeDivider: HTMLElement | null = null;
  let startX = 0;
  let startWidths: number[] = [];
  const MIN_PANEL_PX = 100;

  function checkVerticalLayout(): void {
    const width = layout.getBoundingClientRect().width;
    if (width < 500) {
      layout.classList.add('vertical-layout');
    } else {
      layout.classList.remove('vertical-layout');
    }
  }
  checkVerticalLayout();
  window.addEventListener('resize', checkVerticalLayout);
  if (typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver(function () {
      checkVerticalLayout();
    });
    resizeObserver.observe(layout);
  }

  function panelWidths(): [number, number] {
    const w = Array.from(panels).map(function (p) {
      return parseFloat(p.style.width) || 0;
    });
    return [w[0] ?? 0, w[1] ?? 0];
  }

  dividers.forEach(function (divider) {
    divider.addEventListener('mousedown', function (e) {
      e.preventDefault();
      activeDivider = divider;
      startX = e.clientX;
      startWidths = Array.from(panels).map(function (p) {
        return p.getBoundingClientRect().width;
      });
      document.body.classList.add('resizing');
      divider.classList.add('dragging');
    });

    divider.addEventListener('keydown', function (e) {
      const dividerIndex = parseInt(divider.getAttribute('data-divider') || '0', 10);
      const leftPanel = panels[dividerIndex];
      const rightPanel = panels[dividerIndex + 1];
      if (!leftPanel || !rightPanel) {
        return;
      }
      const step = 10;
      let delta = 0;
      switch (e.key) {
        case 'ArrowLeft':
          delta = -step;
          e.preventDefault();
          break;
        case 'ArrowRight':
          delta = step;
          e.preventDefault();
          break;
        default:
          return;
      }
      const leftWidth = leftPanel.getBoundingClientRect().width + delta;
      const rightWidth = rightPanel.getBoundingClientRect().width - delta;
      if (leftWidth >= MIN_PANEL_PX && rightWidth >= MIN_PANEL_PX) {
        const totalWidth = layout.getBoundingClientRect().width;
        leftPanel.style.width = (leftWidth / totalWidth) * 100 + '%';
        rightPanel.style.width = (rightWidth / totalWidth) * 100 + '%';
        post({ type: 'panelResize', widths: panelWidths() });
      }
    });
  });

  document.addEventListener('mousemove', function (e) {
    if (!activeDivider) {
      return;
    }
    const dividerIndex = parseInt(activeDivider.getAttribute('data-divider') || '0', 10);
    const delta = e.clientX - startX;
    const leftWidth = startWidths[dividerIndex] + delta;
    const rightWidth = startWidths[dividerIndex + 1] - delta;
    if (leftWidth >= MIN_PANEL_PX && rightWidth >= MIN_PANEL_PX) {
      const totalWidth = layout.getBoundingClientRect().width;
      panels[dividerIndex].style.width = (leftWidth / totalWidth) * 100 + '%';
      panels[dividerIndex + 1].style.width = (rightWidth / totalWidth) * 100 + '%';
    }
  });

  document.addEventListener('mouseup', function () {
    if (!activeDivider) {
      return;
    }
    document.body.classList.remove('resizing');
    activeDivider.classList.remove('dragging');
    activeDivider = null;
    post({ type: 'panelResize', widths: panelWidths() });
  });
}

// ─── Log column resize (Author / Date) ───────────────────────────
// Drag or arrow-key the `.log-column-resize-handle` to resize the fixed
// Author/Date columns via the panel's CSS custom properties; the clamped
// widths post as `columnResize` so they persist across renders.
export function setupColumnResize(post: PostLog): void {
  const MIN_COL = 40;
  const MAX_COL = 600;
  const VAR_BY_COLUMN: Record<string, string> = {
    author: '--col-author-width',
    date: '--col-date-width',
  };

  function panelFor(el: Element): HTMLElement | null {
    return el.closest<HTMLElement>('.graph-panel');
  }
  function currentWidth(panel: HTMLElement, column: string): number {
    const raw = window.getComputedStyle(panel).getPropertyValue(VAR_BY_COLUMN[column]);
    const n = parseFloat(raw);
    return isFinite(n) ? n : column === 'author' ? 120 : 145;
  }
  function clamp(px: number): number {
    return Math.round(Math.min(MAX_COL, Math.max(MIN_COL, px)));
  }
  function applyAndPost(panel: HTMLElement, column: string, px: number): number {
    const clamped = clamp(px);
    panel.style.setProperty(VAR_BY_COLUMN[column], clamped + 'px');
    post({
      type: 'columnResize',
      widths: [currentWidth(panel, 'author'), currentWidth(panel, 'date')],
    });
    return clamped;
  }

  let active: HTMLElement | null = null;
  let activePanel: HTMLElement | null = null;
  let activeColumn: string | null = null;
  let startX = 0;
  let startWidth = 0;

  document.addEventListener('mousedown', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    const handle = target ? target.closest<HTMLElement>('.log-column-resize-handle') : null;
    if (!handle) {
      return;
    }
    const panel = panelFor(handle);
    if (!panel) {
      return;
    }
    e.preventDefault();
    active = handle;
    activePanel = panel;
    activeColumn = handle.getAttribute('data-column-resize');
    startX = e.clientX;
    startWidth = currentWidth(panel, activeColumn || '');
    document.body.classList.add('resizing-column');
    handle.classList.add('dragging');
  });

  document.addEventListener('mousemove', function (e) {
    if (!active || !activePanel || activeColumn === null) {
      return;
    }
    const delta = e.clientX - startX;
    applyAndPost(activePanel, activeColumn, startWidth - delta);
  });

  document.addEventListener('mouseup', function () {
    if (!active) {
      return;
    }
    document.body.classList.remove('resizing-column');
    active.classList.remove('dragging');
    active = null;
    activePanel = null;
    activeColumn = null;
  });

  document.addEventListener('keydown', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    const handle = target ? target.closest<HTMLElement>('.log-column-resize-handle') : null;
    if (!handle) {
      return;
    }
    let step = 0;
    if (e.key === 'ArrowLeft') {
      step = -10;
    } else if (e.key === 'ArrowRight') {
      step = 10;
    } else {
      return;
    }
    e.preventDefault();
    const panel = panelFor(handle);
    if (!panel) {
      return;
    }
    const column = handle.getAttribute('data-column-resize') || '';
    applyAndPost(panel, column, currentWidth(panel, column) + step);
  });
}

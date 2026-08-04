/// <reference lib="dom" />
/**
 * Collapsed-ref popup for the Git tool window webview: the branch-label "+N"
 * chip opens a focusable menu of the hidden refs; picking one posts
 * `branchClick`. Owns the open/close state, outside-click dismissal, and the
 * menu keyboard pattern (arrows cycle, Enter/Space pick, Escape restores
 * focus to the chip). Extracted verbatim from the entry.
 */

import type { GitToolWindowInbound } from '../gitToolWindow.protocol';

type PostLog = (message: GitToolWindowInbound) => void;

export function setupRefPopup(post: PostLog): void {
  let refPopupOpener: HTMLElement | null = null;

  function closeRefPopup(restoreFocus: boolean): void {
    const popup = document.getElementById('ref-popup');
    if (popup) {
      popup.hidden = true;
    }
    if (refPopupOpener) {
      refPopupOpener.setAttribute('aria-expanded', 'false');
      if (restoreFocus && typeof refPopupOpener.focus === 'function') {
        refPopupOpener.focus();
      }
    }
    refPopupOpener = null;
  }

  function openRefPopup(chip: HTMLElement, clientX: number, clientY: number): void {
    const popup = document.getElementById('ref-popup');
    if (!popup) {
      return;
    }
    const raw = chip.getAttribute('data-collapsed-branches') || '';
    let names: string[] = [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        names = (parsed as unknown[]).filter(
          (n): n is string => typeof n === 'string' && n.length > 0
        );
      }
    } catch (err) {
      names = [];
    }
    if (names.length === 0) {
      return;
    }

    popup.innerHTML = '';
    names.forEach(function (name) {
      const row = document.createElement('div');
      row.className = 'context-menu-item';
      row.setAttribute('role', 'menuitem');
      row.setAttribute('tabindex', '0');
      row.setAttribute('data-branch-name', name);
      row.textContent = name;
      popup.appendChild(row);
    });

    const menuWidth = 220;
    const menuHeight = 400;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const left = clientX + menuWidth > viewportWidth ? viewportWidth - menuWidth - 10 : clientX;
    const top = clientY + menuHeight > viewportHeight ? viewportHeight - menuHeight - 10 : clientY;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    popup.hidden = false;

    refPopupOpener = chip;
    chip.setAttribute('aria-expanded', 'true');
    const firstRow = popup.querySelector<HTMLElement>('.context-menu-item');
    if (firstRow && typeof firstRow.focus === 'function') {
      firstRow.focus();
    }
  }

  function selectRefRow(row: Element): void {
    const name = row.getAttribute('data-branch-name');
    if (name) {
      post({ type: 'branchClick', branchName: name });
    }
    closeRefPopup(true);
  }

  document.addEventListener('click', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    const popup = document.getElementById('ref-popup');
    if (!popup) {
      return;
    }

    const chip = target
      ? target.closest<HTMLElement>('.branch-label-collapsed[data-collapsed-branches]')
      : null;
    if (chip) {
      openRefPopup(chip, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
      return;
    }

    if (popup.hidden) {
      return;
    }

    const row = target ? target.closest('#ref-popup .context-menu-item') : null;
    if (row) {
      selectRefRow(row);
      return;
    }

    if (!popup.contains(target as Node)) {
      closeRefPopup(false);
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') {
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    const chip = target
      ? target.closest<HTMLElement>('.branch-label-collapsed[data-collapsed-branches]')
      : null;
    if (!chip) {
      return;
    }
    e.preventDefault();
    const rect = chip.getBoundingClientRect();
    openRefPopup(chip, rect.left, rect.bottom);
  });

  document.addEventListener('keydown', function (e) {
    const popup = document.getElementById('ref-popup');
    if (!popup || popup.hidden) {
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      closeRefPopup(true);
      return;
    }

    const target = e.target instanceof Element ? e.target : null;
    const row = target ? target.closest('#ref-popup .context-menu-item') : null;
    if (!row) {
      return;
    }

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectRefRow(row);
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = Array.from(popup.querySelectorAll<HTMLElement>('.context-menu-item'));
      const idx = rows.indexOf(row as HTMLElement);
      if (idx === -1) {
        return;
      }
      const nextIdx =
        e.key === 'ArrowDown' ? (idx + 1) % rows.length : (idx - 1 + rows.length) % rows.length;
      const next = rows[nextIdx];
      if (next && typeof next.focus === 'function') {
        next.focus();
      }
    }
  });
}

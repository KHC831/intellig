/// <reference lib="dom" />
/**
 * Collapsed-ref popup for the Git tool window webview: the branch-label "+N"
 * chip opens a focusable menu of the hidden refs; picking one posts
 * `branchClick`. Owns the open/close state, outside-click dismissal, and the
 * menu keyboard pattern (arrows cycle, Enter/Space pick, Escape restores
 * focus to the chip). Extracted verbatim from the entry.
 */

import type { GitToolWindowInbound } from '../gitToolWindow.protocol';
import { ContextMenu } from '../../../webview-common/contextMenu';

/** Height the ref popup is expected to reach once laid out. */
const POPUP_HEIGHT = 400;

type PostLog = (message: GitToolWindowInbound) => void;

export function setupRefPopup(post: PostLog): void {
  let refPopupOpener: HTMLElement | null = null;

  const popup = new ContextMenu({
    id: 'ref-popup',
    ariaLabel: 'Branches at this commit',
    actionAttr: 'data-branch-name',
    expectedHeight: POPUP_HEIGHT,
    onPick: (name): void => {
      post({ type: 'branchClick', branchName: name });
    },
    // Runs however the popup closed, including when another menu opening
    // dismissed it — so the chip can never be left claiming it is expanded.
    onHide: (): void => {
      if (refPopupOpener) {
        refPopupOpener.setAttribute('aria-expanded', 'false');
      }
      refPopupOpener = null;
    },
  });

  function openRefPopup(
    chip: HTMLElement,
    clientX: number,
    clientY: number,
    openedFor?: Event
  ): void {
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

    popup.render(
      names.map(function (name) {
        return { action: name, label: name };
      })
    );
    // The chip is the opener: dismissing hands focus back to it.
    popup.showAt(clientX, clientY, chip, openedFor);

    refPopupOpener = chip;
    chip.setAttribute('aria-expanded', 'true');
  }

  document.addEventListener('click', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    const chip = target
      ? target.closest<HTMLElement>('.branch-label-collapsed[data-collapsed-branches]')
      : null;
    if (chip) {
      openRefPopup(chip, (e as MouseEvent).clientX, (e as MouseEvent).clientY, e);
      return;
    }
    // Picking a row is the widget's own click handler, which stops the event;
    // anything that reaches here is a click away from the popup.
    if (popup.isOpen && target && !popup.contains(target)) {
      popup.hide();
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
    openRefPopup(chip, rect.left, rect.bottom, e);
  });
}

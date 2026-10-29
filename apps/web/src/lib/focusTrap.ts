import { useEffect, type RefObject } from 'react';

/**
 * Keep the keyboard inside an open dialog (audit item 13, 2026-10-28).
 *
 * Before this helper, Tab from the last control of a modal walked into the page
 * behind it: the backdrop covers the page visually, so focus landed on controls
 * nobody could see — a “keyboard trap” in reverse. `aria-modal="true"` tells
 * assistive technology that the rest is inert; the tab order has to say the same.
 *
 * What it does, and only that: while `active`, Tab/Shift+Tab wrap at the ends of
 * the dialog; on activation focus moves inside if it was outside; on deactivation
 * it returns to the control that opened the dialog (if that control still exists).
 * Escape handling stays with each dialog — the three dialogs close differently
 * (one saves nothing, one cancels an export, one only cancels a confirmation).
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Visible controls only: `display:none` subtrees and hidden tabs must not take focus. */
function focusableInside(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => el.getClientRects().length > 0);
}

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusableInside(node);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (!(current instanceof HTMLElement) || !node.contains(current)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (!e.shiftKey && current === last) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && current === first) { e.preventDefault(); last.focus(); }
    };

    document.addEventListener('keydown', onKey, true);
    // Defer: the dialog's own open effect may focus a specific control (the close
    // button in the invite history) — that choice must win over “first focusable”.
    const t = window.setTimeout(() => {
      if (!node.contains(document.activeElement)) focusableInside(node)[0]?.focus();
    }, 0);

    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [ref, active]);
}

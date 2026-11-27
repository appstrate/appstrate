// SPDX-License-Identifier: Apache-2.0

/**
 * Where the focus goes after a chip's X: the chip leaves the DOM with the button that held the
 * focus, which would drop it on the page. Once the chip is gone, the control now at its place in
 * its row takes it (the next chip), else the one before (at worst the settings button). The chip
 * may leave later than the click (a limit lifts once its PATCH lands), so the row is watched until
 * it does; a user who moved the focus elsewhere meanwhile keeps it there.
 */

/** The row the composer's chips sit in, with the buttons before them: `data-chip-row`. */
const CHIP_ROW = "[data-chip-row]";
/** A chip's own root, whose X is pressed: `data-removable-chip`. */
const CHIP = "[data-removable-chip]";

/** A chip that never leaves (its default restored elsewhere, a failed request) stops the watch. */
const WATCH_MS = 10_000;

const focusable = (row: Element): HTMLButtonElement[] =>
  [...row.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => !button.disabled && button.offsetParent !== null,
  );

/** Called from the X's click, before the removal it triggers. */
export function handOverFocusOnRemoval(remove: HTMLElement): void {
  const row = remove.closest(CHIP_ROW);
  const chip = remove.closest(CHIP);
  if (!row || !chip) return;
  // The controls before the chip stay; whatever stands at this index afterwards came after it.
  const place = focusable(row).filter(
    (button) =>
      !chip.contains(button) &&
      chip.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_PRECEDING,
  ).length;
  const observer = new MutationObserver(() => {
    if (chip.isConnected) return;
    stop();
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const now = focusable(row);
    (now[place] ?? now[place - 1])?.focus();
  });
  const timer = setTimeout(() => stop(), WATCH_MS);
  function stop() {
    observer.disconnect();
    clearTimeout(timer);
  }
  observer.observe(row, { childList: true, subtree: true });
}

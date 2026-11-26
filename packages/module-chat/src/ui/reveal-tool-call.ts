// SPDX-License-Identifier: Apache-2.0

/**
 * Bring a tool call's card into view in the thread, from the context panel.
 *
 * Motion is the design system's (`apps/web/DESIGN_SYSTEM.md`, Motion): the scroll takes the
 * thread's own `scroll-behavior`, and the ring that marks the card fades on `duration-fast` with
 * `ease-surface`; reduced motion is handled once by the stylesheet, never here.
 */

/** A focus moved by script draws no ring: this one marks the card until the focus leaves it. */
const REVEALED = ["ring-2", "ring-ring"] as const;
const FADE = ["transition-shadow", "duration-fast", "ease-surface"] as const;

/**
 * Bring the card of the call `toolCallId` into view and give it focus, falling back to the message
 * `messageId` that holds it (a card drawn without the anchor). False when neither is on the page.
 */
export function revealToolCall(call: { toolCallId: string; messageId: string }): boolean {
  const thread = document.querySelector("[data-chat-thread]");
  if (!thread) return false;
  const target =
    thread.querySelector<HTMLElement>(`[data-tool-call-id="${CSS.escape(call.toolCallId)}"]`) ??
    thread.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(call.messageId)}"]`);
  if (!target) return false;
  target.scrollIntoView({ block: "center" });
  target.classList.add(...FADE, ...REVEALED);
  target.addEventListener("focusout", () => target.classList.remove(...REVEALED), { once: true });
  // The card's own control takes the focus: a keyboard reader lands where the eye does. A
  // message holds none, so it takes the focus itself, out of the tab order.
  const control = target.querySelector<HTMLElement>("button, a[href]");
  if (!control && !target.hasAttribute("tabindex")) target.tabIndex = -1;
  (control ?? target).focus({ preventScroll: true });
  return true;
}

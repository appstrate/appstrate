// SPDX-License-Identifier: Apache-2.0

/**
 * Text sizes of the chat that a phone types in or reads. iOS Safari zooms the page on focus of a
 * field whose font is under 16 px and never zooms back, and 14 px is small for running text held
 * at arm's length: every size here is 16 px (`text-base`) below `md` and the dense size from `md`
 * up, the same rule as the design system's `Input` and `Textarea`. `test/phone-text.test.ts`
 * holds the rule.
 */

/** The composer's `<textarea>`: compact, borderless, inside the composer card. */
export const COMPOSER_INPUT_CLASS =
  "placeholder:text-muted-foreground max-h-40 min-h-9 w-full resize-none border-0 bg-transparent px-0 py-1 text-base shadow-none outline-none focus:ring-0 focus-visible:ring-0 focus-visible:outline-none md:text-sm";

/** The conversation search field of the sidebar (a sheet below `md`, 40 px tall there). */
export const SEARCH_INPUT_CLASS =
  "h-10 pr-9 pl-7 text-base md:h-7 md:pr-7 md:text-xs [&::-webkit-search-cancel-button]:hidden";

/** The user's bubble. */
export const USER_MESSAGE_CLASS =
  "bg-card text-foreground max-w-[80%] rounded-2xl border px-4 py-2 text-base whitespace-pre-wrap shadow-sm md:text-sm";

/** The assistant's turn (the markdown renderer sizes its own prose: `MARKDOWN_PROSE_CLASS`). */
export const ASSISTANT_MESSAGE_CLASS = "text-foreground text-base leading-relaxed md:text-sm";

/** Rendered markdown: the body, inline code and code blocks follow the message size. */
export const MARKDOWN_PROSE_CLASS =
  "prose prose-base md:prose-sm dark:prose-invert max-w-none break-words [&_code]:text-[0.85em] [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:text-sm md:[&_pre]:text-xs";

/** The transcript scroller: it keeps its scroll to itself (no rubber-band or pull-to-refresh of the page). */
export const THREAD_VIEWPORT_CLASS =
  "relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto overscroll-contain px-4 pt-6";

/** The sticky footer holding the composer; `group/footer` lets the disclaimer react to the focus. */
export const THREAD_FOOTER_CLASS =
  "group/footer bg-canvas sticky bottom-0 mt-2 flex w-full max-w-(--thread-max-width) flex-col items-center gap-2 pb-4";

/** Under the composer; on a phone it steps aside while the composer has the focus (the keyboard is up). */
export const DISCLAIMER_CLASS =
  "text-muted-foreground/70 px-4 text-center text-xs max-md:group-focus-within/footer:hidden";

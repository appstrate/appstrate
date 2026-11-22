// SPDX-License-Identifier: Apache-2.0

// A landscape phone can cross md. Keep both editable fields at 1rem at every width.

/**
 * The composer's editor (a Lexical content-editable in a scrolling wrapper): compact, borderless,
 * inside the composer card. The library draws no styles of its own: the field and its placeholder
 * are styled through their `aui-lexical-*` classes.
 */
export const COMPOSER_INPUT_CLASS =
  "relative [grid-area:input] max-h-40 w-full px-0 text-base [&_.aui-lexical-input]:min-h-10 desktop-pointer:[&_.aui-lexical-input]:min-h-9 [&_.aui-lexical-input]:py-1 [&_.aui-lexical-input]:break-words [&_.aui-lexical-input]:whitespace-pre-wrap [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:text-muted-foreground [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:inset-x-0 [&_.aui-lexical-placeholder]:top-1 [&_.aui-lexical-placeholder]:truncate";

/** Running text a phone reads (a hint, a state, a message): 16 px, the dense size from `md`. */
export const READING_TEXT_CLASS = "text-base md:text-sm";

/** The same, where the desktop is denser still (the sidebar's states and actions). */
export const READING_TEXT_DENSE_CLASS = "text-base md:text-xs";

/** Secondary text (a chip, a meta line, a status): 14 px on a phone, never smaller. */
export const NOTE_TEXT_CLASS = "text-sm md:text-xs";

/** The conversation search field of the sidebar (a sheet below `md`, 40 px tall there). */
export const SEARCH_INPUT_CLASS =
  "h-10 pr-9 pl-7 text-base md:h-8 md:pr-7 md:py-0 md:text-base [&::-webkit-search-cancel-button]:hidden";

/** The user's bubble. */
export const USER_MESSAGE_CLASS =
  "bg-card text-foreground max-w-[80%] rounded-2xl border px-4 py-2 text-base whitespace-pre-wrap shadow-sm md:text-sm";

/** The assistant's turn (the markdown renderer sizes its own prose: `MARKDOWN_PROSE_CLASS`). */
export const ASSISTANT_MESSAGE_CLASS = "text-foreground text-base leading-relaxed md:text-sm";

/** Rendered markdown: the body, inline code and code blocks follow the message size. */
export const MARKDOWN_PROSE_CLASS =
  "prose prose-base md:prose-sm dark:prose-invert max-w-none break-words [&_code]:text-[0.85em] [&_pre>code]:text-[1em] [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:text-sm md:[&_pre]:text-xs";

/** The transcript scroller: it keeps its scroll to itself (no rubber-band or pull-to-refresh of the page). */
export const THREAD_VIEWPORT_CLASS =
  "relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto overscroll-contain px-4 pt-6";

/** The sticky footer holding the composer; `group/footer` lets the disclaimer react to the focus. */
export const THREAD_FOOTER_CLASS =
  "group/footer bg-canvas sticky bottom-0 mt-2 flex w-full max-w-(--thread-max-width) flex-col items-center gap-2 pb-4";

/** The line under the composer, as the conversation skeleton draws it too. */
export const DISCLAIMER_TEXT_CLASS = "text-muted-foreground/70 px-4 text-center text-xs";

/** Under the composer; on a phone it steps aside while the composer has the focus (the keyboard is up). */
export const DISCLAIMER_CLASS = `${DISCLAIMER_TEXT_CLASS} max-md:group-focus-within/footer:hidden`;

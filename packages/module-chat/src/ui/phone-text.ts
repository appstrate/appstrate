// SPDX-License-Identifier: Apache-2.0

// A landscape phone can cross md. Keep both editable fields at 1rem at every width.

/** The composer's `<textarea>`: compact, borderless, inside the composer card. */
export const COMPOSER_INPUT_CLASS =
  "placeholder:text-muted-foreground max-h-40 min-h-10 desktop-pointer:min-h-9 w-full resize-none border-0 bg-transparent px-0 py-1 text-base shadow-none outline-none focus:ring-0 focus-visible:ring-0 focus-visible:outline-none";

/** Running text a phone reads (a hint, a state, a message): 16 px, the dense size from `md`. */
export const READING_TEXT_CLASS = "text-base md:text-sm";

/** The same, where the desktop is denser still (the sidebar's states and actions). */
export const READING_TEXT_DENSE_CLASS = "text-base md:text-xs";

/** Secondary text (a chip, a meta line, a status): 14 px on a phone, never smaller. */
export const NOTE_TEXT_CLASS = "text-sm md:text-xs";

/**
 * The composer's row, below the field's own text. From `md` up the field takes a line to itself
 * with the tools, the model picker and send on the line under it. On a phone it is ONE line, always:
 * the "+" (all the tools), the field, the model picker, send. The row keeps its bottom edge when the
 * field grows to several lines.
 */
export const COMPOSER_ROW_CLASS =
  "flex items-center gap-x-2 gap-y-1 md:flex-wrap max-md:flex-nowrap max-md:items-end";

/**
 * The field: a line of its own from `md`, the stretchy cell of the phone's line (as tall as its
 * buttons). Empty, it shows one line of its placeholder, never the two a narrow screen would wrap.
 */
export const COMPOSER_FIELD_CLASS =
  "md:order-first md:basis-full max-md:min-h-10 max-md:min-w-0 max-md:flex-1 max-md:py-2 max-md:[&:placeholder-shown]:max-h-10 max-md:[&:placeholder-shown]:overflow-hidden max-md:[&:placeholder-shown]:py-0 max-md:[&:placeholder-shown]:leading-10 short-landscape:basis-0 short-landscape:grow";

/** Send's cell: with the field on the same line in a short landscape (the keyboard leaves a sliver). */
export const COMPOSER_SEND_CLASS = "flex shrink-0 items-center gap-2 short-landscape:order-first";

/** The tools' cell: the desktop's settings and chips (`flex-1`), on a phone just the "+". */
export const COMPOSER_TOOLS_CLASS = "min-w-0 flex-1 max-md:flex-none";

/**
 * The model picker's cell: pushed right on a desktop; on a phone it takes only what it needs, at
 * most 40 % of the line (the field keeps the rest), and its name truncates.
 */
export const COMPOSER_SLOT_CLASS = "ml-auto min-w-0 max-md:ml-0 max-md:max-w-[40%] max-md:shrink-0";

/** "New conversation" in the sidebar: a row aligned left like the conversations below it on a phone. */
export const NEW_CONVERSATION_CLASS = "max-md:justify-start max-md:gap-3 max-md:font-medium";

/** The conversation search field of the sidebar (a sheet below `md`, 40 px tall there). */
export const SEARCH_INPUT_CLASS =
  "h-10 pr-9 pl-7 text-base max-md:h-11 max-md:rounded-xl max-md:border-transparent max-md:bg-muted max-md:pl-10 max-md:shadow-none md:h-8 md:pr-7 md:py-0 md:text-base [&::-webkit-search-cancel-button]:hidden";

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

/** Under the composer from `md` up; a phone has it as the last line of the "+" panel. */
export const DISCLAIMER_CLASS = `${DISCLAIMER_TEXT_CLASS} max-md:hidden`;

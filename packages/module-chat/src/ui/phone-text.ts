// SPDX-License-Identifier: Apache-2.0

// A landscape phone can cross md. Editable fields stay at 1rem on touch (iOS zooms into smaller
// ones); the pointer decides, never the width. The composer and the user's bubble share one size.

/** The composer's Lexical editor, styled through the library's `aui-lexical-*` classes. */
export const COMPOSER_INPUT_CLASS =
  "relative max-h-40 w-full overflow-y-auto px-0 text-base desktop-pointer:text-sm [&_.aui-lexical-input]:min-h-11 desktop-pointer:[&_.aui-lexical-input]:min-h-9 [&_.aui-lexical-input]:py-2.5 md:[&_.aui-lexical-input]:py-1 [&_.aui-lexical-input]:break-words [&_.aui-lexical-input]:whitespace-pre-wrap [&_.aui-lexical-input]:outline-none";

/** The field's placeholder, laid over the editor's first line (`ComposerPlaceholder`). */
export const COMPOSER_PLACEHOLDER_CLASS =
  "text-muted-foreground pointer-events-none absolute inset-x-0 top-2.5 truncate text-base desktop-pointer:text-sm md:top-1";

/** Running text a phone reads (a hint, a state, a message): 16 px, the dense size from `md`. */
export const READING_TEXT_CLASS = "text-base md:text-sm";

/** The same, where the desktop is denser still (the sidebar's states and actions). */
export const READING_TEXT_DENSE_CLASS = "text-base md:text-xs";

/** Secondary text (a chip, a meta line, a status): 14 px on a phone, never smaller. */
export const NOTE_TEXT_CLASS = "text-sm md:text-xs";

/**
 * The composer's row, below the field's own text. From `md` up the field takes a line to itself
 * with the tools and send on the line under it. On a phone it is ONE line, always: the "+" (all
 * the tools), the field, send. The row keeps its bottom edge when the field grows to several lines.
 */
export const COMPOSER_ROW_CLASS = "flex items-center gap-x-2 gap-y-1 md:flex-wrap max-md:items-end";

/** The field: a line of its own from `md`, the stretchy cell of the phone's line. */
export const COMPOSER_FIELD_CLASS =
  "min-w-0 md:order-first md:basis-full max-md:flex-1 md-short:basis-0 md-short:grow";

/** Send's cell: on the field's line on a wide but short screen (the keyboard leaves a sliver). */
export const COMPOSER_SEND_CLASS = "flex shrink-0 items-center gap-2 md-short:order-first";

/**
 * The tools' cell: the desktop's settings and chips (`flex-1`), on a phone just the "+". On a wide
 * but short screen it keeps the line under the field and Send: `flex-1` alone starts it at zero
 * width, so it would squeeze in after Send.
 */
export const COMPOSER_TOOLS_CLASS = "min-w-0 flex-1 max-md:flex-none md-short:basis-full";

/** "New conversation" in the sidebar: a row aligned left like the conversations below it on a phone. */
export const NEW_CONVERSATION_CLASS = "max-md:justify-start max-md:gap-3 max-md:font-medium";

/** The phone's « new conversation » icon, in a round tile as the rows below it have theirs. */
export const NEW_CONVERSATION_ICON_CLASS =
  "max-md:bg-sidebar-accent max-md:flex max-md:size-8 max-md:items-center max-md:justify-center max-md:rounded-full md:contents";

/** The phone's search toggle, beside « new conversation »: a thumb's 44px. */
export const SEARCH_TOGGLE_CLASS =
  "text-sidebar-foreground/70 flex size-11 items-center justify-center rounded-md md:hidden";

/** The conversation search field of the sidebar (a filled field below `md`, 44 px tall there). */
export const SEARCH_INPUT_CLASS =
  "pr-9 pl-7 text-base max-md:h-11 max-md:rounded-xl max-md:border-0 max-md:bg-muted max-md:focus-visible:ring-0 max-md:focus-visible:ring-offset-0 max-md:pl-10 max-md:shadow-none md:h-8 md:pr-7 md:py-0 md:text-base [&::-webkit-search-cancel-button]:hidden";

/** The user's bubble: the composer's size, so a message keeps its size when sent. */
export const USER_MESSAGE_CLASS =
  "bg-card text-foreground max-w-[80%] rounded-2xl border px-4 py-2 text-base desktop-pointer:text-sm whitespace-pre-wrap shadow-sm";

/** The assistant's turn (the markdown renderer sizes its own prose: `MARKDOWN_PROSE_CLASS`). */
export const ASSISTANT_MESSAGE_CLASS = "text-foreground text-base leading-relaxed md:text-sm";

/** Rendered markdown: the body, inline code and code blocks follow the message size. */
export const MARKDOWN_PROSE_CLASS =
  "prose prose-base md:prose-sm dark:prose-invert max-w-none break-words [&_code]:text-[0.85em] [&_pre>code]:text-[1em] [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:text-sm md:[&_pre]:text-xs";

/**
 * The conversation's side padding. The host's context panel floats over the thread's right side and
 * publishes the width it takes as `--chat-context-inset` (unset while it is closed): the thread keeps
 * its full width, so its scrollbar stays at the window's right edge, and reserves that width on its
 * right, so the column stays centered in what the panel leaves.
 */
export const THREAD_SIDE_PADDING_CLASS =
  "pl-4 pr-[calc(1rem+var(--chat-context-inset,0px))] duration-base ease-surface transition-[padding]";

/** The transcript scroller: it keeps its scroll to itself (no rubber-band or pull-to-refresh of the page). */
export const THREAD_VIEWPORT_CLASS = `relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto overscroll-contain pt-6 ${THREAD_SIDE_PADDING_CLASS}`;

/** The sticky footer holding the composer; `group/footer` lets the disclaimer react to the focus. */
export const THREAD_FOOTER_CLASS =
  "group/footer bg-canvas sticky bottom-0 mt-2 flex w-full max-w-(--thread-max-width) flex-col items-center gap-2 pb-4";

/** The line under the composer, as the conversation skeleton draws it too. */
const DISCLAIMER_TEXT_CLASS = "text-muted-foreground/70 px-4 text-center text-xs";

/** Under the composer from `md` up; a phone has it as the last line of the "+" panel. */
export const DISCLAIMER_CLASS = `${DISCLAIMER_TEXT_CLASS} max-md:hidden`;

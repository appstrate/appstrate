// SPDX-License-Identifier: Apache-2.0

/** Streaming-aware markdown renderer for assistant messages (GFM + prose). */

import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Open links in a new tab so a click never navigates the chat SPA away — the
 * conversation stays mounted.
 *
 * Declared at module scope, NOT inline in the `components` object below. An
 * arrow function written there is a NEW function identity on every render, so
 * React sees a new component TYPE and unmounts/remounts every anchor in the
 * answer on each frame — and the primitive's own `useMemo` over the component
 * map misses every time. During a stream that is once per animation frame.
 */
function MarkdownLink({
  node: _node,
  href,
  children,
  ...props
}: {
  node?: unknown;
  href?: string;
  children?: React.ReactNode;
}) {
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** Stable identity for the same reason as {@link MarkdownLink}. */
const MARKDOWN_COMPONENTS = { a: MarkdownLink };

const REMARK_PLUGINS = [remarkGfm];

export function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={REMARK_PLUGINS}
      // `smooth` defaults to true, and its first `requestAnimationFrame` tick
      // reveals ZERO characters — it only schedules the next one. So the first
      // character of an answer paints a frame after the byte arrived, and the
      // display then trails the stream by up to `drainMs` (250 ms by default)
      // while re-rendering at 60 fps regardless of the token rate. On a path
      // whose whole point is time-to-first-token, that is latency we add
      // ourselves, after the network already delivered.
      //
      // Kept as smoothing rather than switched off outright: a raw chunk feed
      // reads as jittery. Retuned so the animation tracks the stream instead of
      // buffering it — one character per frame at most, and a quarter of the
      // former backlog window.
      smooth={{ drainMs: 60, maxCharIntervalMs: 1 }}
      className="prose prose-sm dark:prose-invert max-w-none break-words [&_code]:text-[0.85em] [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:text-xs"
      components={MARKDOWN_COMPONENTS}
    />
  );
}

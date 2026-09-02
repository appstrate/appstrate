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
      // buffering it: at most one character per MILLISECOND, and a quarter of
      // the former backlog window.
      //
      // `maxCharIntervalMs` is the ceiling on the gap BETWEEN characters, not a
      // per-frame cap — the per-frame cap is `maxCharsPerFrame`, deliberately
      // left at its default. `useSmooth`'s animator computes
      // `baseTimePerChar = min(maxCharIntervalMs, drainMs / remaining)` and then
      // reveals `deltaTime / baseTimePerChar` characters per frame, so this
      // yields ~16 at 60 fps with a short backlog and proportionally more with
      // a long one — which is the point: the reveal rate follows the stream
      // rather than a fixed budget. Reading this as a frame cap and raising
      // `drainMs` to slow the reveal does the opposite of what it looks like.
      //
      // `minCommitMs` bounds the COMMIT cadence, not the reveal. The animator
      // still advances `currentText` every rAF by the rule above, but only
      // calls `setText` (a React commit + a full `react-markdown` reparse of
      // the whole answer) when `now - lastCommitTime >= minCommitMs` — or when
      // the reveal catches up with the stream, which always commits so the
      // final text is never held back. At the default `0` every rAF with
      // pending characters commits (60 reparses/s while the text is behind);
      // at 32 ms that is ~30/s, with the characters revealed in between
      // simply landing in the next commit. Visible rate unchanged, half the
      // remark work.
      smooth={{ drainMs: 60, maxCharIntervalMs: 1, minCommitMs: 32 }}
      className="prose prose-sm dark:prose-invert max-w-none break-words [&_code]:text-[0.85em] [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:text-xs"
      components={MARKDOWN_COMPONENTS}
    />
  );
}

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
      // The typewriter reveal (`useSmooth`) is what makes a token feed read as
      // continuous, and it only works while it has a BACKLOG: its animator runs
      // one `requestAnimationFrame` loop that reveals
      // `deltaTime / min(maxCharIntervalMs, drainMs / remaining)` characters per
      // frame, and the moment it catches up with the stream it stops — the next
      // delivery restarts it, and that first frame reveals nothing. So a reveal
      // rate above the arrival rate paints exactly when the network delivers
      // (one frame late, with an idle frame after each catch-up) and the
      // smoothing is effectively off: the text advances in lots at whatever
      // cadence the provider and the transport batch it.
      //
      // `maxCharIntervalMs` is the ceiling on the gap BETWEEN characters, so
      // it is the reveal's top speed: 10 ms is ~1.6 characters per frame at
      // 60 fps, ~100 characters/s (~25 tokens/s) — below the output rate of
      // any model worth streaming, so a backlog persists and every frame
      // paints. `drainMs` is the second term of the same formula and takes
      // over whenever the backlog exceeds that pace: it is how long the
      // animator gives itself to clear what it holds, so in steady state the
      // reveal tracks the arrival rate exactly and trails it by `drainMs`.
      // 150 ms also bounds how long the tail takes to land after the stream
      // ends. The first character still paints on the frame after its byte
      // arrived — the top speed only applies once there is a backlog.
      //
      // `minCommitMs` stays at its default (0): the animator only paints on a
      // commit, so a commit floor below the frame rate turns the reveal into
      // steps.
      smooth={{ drainMs: 150, maxCharIntervalMs: 10 }}
      className="prose prose-sm dark:prose-invert max-w-none break-words [&_code]:text-[0.85em] [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:text-xs"
      components={MARKDOWN_COMPONENTS}
    />
  );
}

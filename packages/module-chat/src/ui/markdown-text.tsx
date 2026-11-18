// SPDX-License-Identifier: Apache-2.0

/** Streaming-aware markdown renderer for assistant messages (GFM + prose). */

import type { ReactNode } from "react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { cn } from "@appstrate/ui/cn";
import { parseFileUri } from "@appstrate/core/file-uri";
import remarkGfm from "remark-gfm";
import { fileActivation } from "./file-activation.ts";
import { urlTransform } from "./markdown-url.ts";
import { useAuiState } from "@assistant-ui/react";
import { fileSpaceOf } from "./conversation-scope.ts";
import { useChatHost } from "./runtime-context.ts";

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
  children?: ReactNode;
}) {
  const fileId = href ? parseFileUri(href) : null;
  if (fileId) return <MarkdownFileLink id={fileId}>{children}</MarkdownFileLink>;
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * The space of a file the answer references, from the part of the thread that brought it in
 * ({@link fileSpaceOf}): the same space its chip opens it in. A string or `undefined`, so the
 * selector does not re-render on unrelated thread changes.
 */
function useFileSpace(id: string): string | undefined {
  return useAuiState((s) => fileSpaceOf(s.thread.messages, id));
}

/**
 * A link to an `appfile://` file: the platform's own file, so a click opens the host's preview
 * (or its authenticated download), never the raw URI, which no browser can navigate.
 */
function MarkdownFileLink({ id, children }: { id: string; children?: ReactNode }) {
  const { openFile, downloadFile, t } = useChatHost();
  const spaceId = useFileSpace(id);
  const name = typeof children === "string" ? children : "";
  const { onActivate, label } = fileActivation(
    { id, name, ...(spaceId && { spaceId }) },
    openFile,
    downloadFile,
    t,
  );
  return (
    <button
      type="button"
      onClick={onActivate}
      title={label}
      className="text-primary cursor-pointer underline underline-offset-2"
    >
      {children}
    </button>
  );
}

/**
 * `![alt](appfile://…)`: the image, fetched through the host's authenticated image hook (the
 * content route needs the session, so a plain `<img src>` could not load it). Inline elements
 * only: a markdown image sits inside a paragraph. While it loads, or when it cannot be shown,
 * the alt text stands in, as for any broken image.
 */
function MarkdownFileImage({ id, alt }: { id: string; alt: string }) {
  const { useFileImageSrc, openFile, downloadFile, t } = useChatHost();
  const spaceId = useFileSpace(id);
  const src = useFileImageSrc(id, spaceId);
  if (!src) return <span className="text-muted-foreground">{alt || "image"}</span>;
  const { onActivate, label } = fileActivation(
    { id, name: alt, ...(spaceId && { spaceId }) },
    openFile,
    downloadFile,
    t,
  );
  return (
    <button type="button" onClick={onActivate} title={label} aria-label={label}>
      <img
        src={src}
        alt={alt}
        className="my-1 max-h-96 max-w-full rounded-lg border object-contain"
      />
    </button>
  );
}

function MarkdownImage({
  node: _node,
  src,
  alt,
  ...props
}: {
  node?: unknown;
  src?: string;
  alt?: string;
}) {
  const fileId = src ? parseFileUri(src) : null;
  if (fileId) return <MarkdownFileImage id={fileId} alt={alt ?? ""} />;
  return <img {...props} src={src} alt={alt} />;
}

/** Stable identity for the same reason as {@link MarkdownLink}. */
const MARKDOWN_COMPONENTS = { a: MarkdownLink, img: MarkdownImage };

const REMARK_PLUGINS = [remarkGfm];

export function MarkdownText() {
  return <Markdown />;
}

/** The reasoning part: same renderer, read as secondary. */
export function ReasoningText() {
  return <Markdown className="text-muted-foreground prose-p:my-1.5" />;
}

function Markdown({ className }: { className?: string }) {
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
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none break-words [&_code]:text-[0.85em] [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:text-xs",
        className,
      )}
      components={MARKDOWN_COMPONENTS}
      urlTransform={urlTransform}
    />
  );
}

// SPDX-License-Identifier: Apache-2.0

/**
 * In-browser file viewer branching on the server-supplied `preview_kind`: `html` (sandboxed
 * iframe), `image`, `pdf` (native-viewer iframe), `text` (`<pre>`).
 *
 * SECURITY — the `html` iframe renders UNTRUSTED agent-generated HTML; its isolation is
 * load-bearing and MUST NOT be loosened:
 *
 *  - `sandbox="allow-scripts"` EXACTLY: scripts run but the frame keeps an OPAQUE origin.
 *    `allow-same-origin` (the classic sandbox-defeat, fatal combined with `allow-scripts`) would
 *    expose the app's cookies/DOM; `allow-popups`/`allow-forms`/`allow-top-navigation`/`allow-modals`
 *    re-open exfiltration and navigation vectors.
 *  - `referrerPolicy="no-referrer"`: the preview URL carries a signed token.
 *  - `src` is the server-minted `preview_url` on a cookie-less route with a strict CSP + meta CSP
 *    (`file-preview.ts` on the API).
 *  - Where the frame may NAVIGATE is bounded only by the SPA document's CSP `frame-src <preview
 *    origin>` (`buildSpaCsp()` in `apps/api/src/routes/spa.ts`): neither `sandbox` nor the preview
 *    CSP can stop a sandboxed navigable navigating ITSELF. It bounds cross-origin navigation only,
 *    not exfiltration generally (WebRTC/STUN is a known residual, `buildPreviewCsp`). Navigation
 *    within the allowed origin is harmless: the frame is opaque-origin (no SameSite cookies) and
 *    `frame-src` is re-enforced across a 302. **Framing any NEW origin requires widening
 *    `frame-src` first**, or the frame will not load.
 *
 * The `pdf` iframe is DELIBERATELY sandboxless: Chrome will not render its native PDF viewer in a
 * sandbox without `allow-same-origin`. Safe because a PDF is inert in the embedding origin and the
 * response carries `nosniff` + `inline` + `default-src 'none'`, so a mislabelled body renders as a
 * broken PDF, never HTML. `image`/`pdf`/`text` are inert and need no sandbox.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import { Markdown } from "./markdown";
import { ErrorState } from "./page-states";
import { TextSkeleton } from "./loading-skeletons";
import { isMarkdownFile } from "../lib/files";
import { client } from "../api/client";

/** The EXACT iframe sandbox token set; the server ships the same in its CSP `sandbox` directive — move both or neither. */
export const PREVIEW_IFRAME_SANDBOX = "allow-scripts";

/** Inline-render cap for sanitized markdown. */
const INLINE_MARKDOWN_MAX_BYTES = 1_048_576; // 1 MiB

export interface ViewableFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  preview_url?: string | null;
  preview_kind: "html" | "image" | "pdf" | "text" | null;
}

/** Loads remote text with a cancel guard; any error is `failed`. `load` must be memoised: it is the effect's only dependency. */
function useRemoteText(load: (signal: { cancelled: boolean }) => Promise<string | undefined>): {
  text?: string;
  failed?: boolean;
} {
  const [state, setState] = useState<{ text?: string; failed?: boolean }>({});

  useEffect(() => {
    const token = { cancelled: false };
    void (async () => {
      try {
        const text = await load(token);
        if (token.cancelled) return;
        setState(text === undefined ? { failed: true } : { text });
      } catch {
        if (!token.cancelled) setState({ failed: true });
      }
    })();
    return () => {
      token.cancelled = true;
    };
  }, [load]);

  return state;
}

function MarkdownPreview({ id, unavailable }: { id: string; unavailable: string }) {
  const load = useCallback(async () => {
    const { data } = await client.GET("/api/files/{id}/content", {
      params: { path: { id } },
      parseAs: "text",
    });
    return data;
  }, [id]);
  const state = useRemoteText(load);

  if (state.failed) return <ErrorState message={unavailable} />;
  if (state.text === undefined) return <TextSkeleton lines={6} />;
  return (
    <div className="bg-background size-full overflow-auto p-4">
      <Markdown>{state.text}</Markdown>
    </div>
  );
}

function TextPreview({ url, unavailable }: { url: string; unavailable: string }) {
  const load = useCallback(async () => {
    const response = await fetch(url, { referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error("preview fetch failed");
    return await response.text();
  }, [url]);
  const state = useRemoteText(load);

  if (state.failed) return <ErrorState message={unavailable} />;
  if (state.text === undefined) return <TextSkeleton lines={6} />;
  return (
    <pre className="text-foreground size-full overflow-auto p-4 font-mono text-xs break-words whitespace-pre-wrap">
      {state.text}
    </pre>
  );
}

function UnavailablePreview({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center p-6 text-center">
      <p>{message}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function FileViewer({
  fileId,
  file,
  isLoading,
  error,
  unavailableAction,
  className,
}: {
  fileId: string;
  file?: ViewableFile;
  isLoading: boolean;
  error: unknown;
  unavailableAction?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation("files");

  function renderBody() {
    if (isLoading) return <TextSkeleton lines={6} />;
    if (error) return <ErrorState error={error} />;
    if (!file?.preview_url) {
      return <UnavailablePreview message={t("preview.unavailable")} action={unavailableAction} />;
    }

    const previewUrl = file.preview_url;
    const frameTitle = t("preview.frameTitle", { name: file.name });

    if (isMarkdownFile(file.mime, file.name) && file.size <= INLINE_MARKDOWN_MAX_BYTES) {
      return <MarkdownPreview key={fileId} id={fileId} unavailable={t("preview.unavailable")} />;
    }

    if (file.preview_kind === "image") {
      return (
        <img
          src={previewUrl}
          alt={file.name}
          className="mx-auto max-h-full max-w-full object-contain"
        />
      );
    }
    if (file.preview_kind === "pdf") {
      return (
        // SECURITY: intentionally NO sandbox — see file header.
        <iframe
          referrerPolicy="no-referrer"
          src={previewUrl}
          title={frameTitle}
          className="size-full border-0 bg-white"
        />
      );
    }
    if (file.preview_kind === "text") {
      return (
        <TextPreview key={previewUrl} url={previewUrl} unavailable={t("preview.unavailable")} />
      );
    }
    return (
      <iframe
        // SECURITY: do not change these attributes — see file header.
        sandbox={PREVIEW_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        src={previewUrl}
        title={frameTitle}
        className="size-full border-0 bg-white"
      />
    );
  }

  return (
    <div
      className={cn("bg-muted h-full min-h-0 flex-1 overflow-hidden rounded-md border", className)}
    >
      {renderBody()}
    </div>
  );
}

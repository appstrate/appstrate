// SPDX-License-Identifier: Apache-2.0

/**
 * Reusable in-browser viewer for a document, branching on the server-supplied
 * `preview_kind`: `html` (sandboxed iframe), `image` (`<img>`), `pdf`
 * (native-viewer iframe), `text` (plaintext `<pre>`).
 *
 * SECURITY — the `html` iframe renders UNTRUSTED agent-generated HTML. Its
 * isolation is load-bearing and MUST NOT be loosened:
 *
 *  - `sandbox="allow-scripts"` EXACTLY — scripts run (the page needs them) but
 *    the frame keeps an OPAQUE origin. Adding `allow-same-origin` would let the
 *    page reach the app's cookies/DOM and is the classic sandbox-defeat; adding
 *    `allow-popups`/`allow-forms`/`allow-top-navigation`/`allow-modals` re-opens
 *    exfiltration and navigation vectors. Combining `allow-scripts` with
 *    `allow-same-origin` is the single most dangerous mistake here — never do it.
 *  - `referrerPolicy="no-referrer"` — the preview URL (which carries a signed
 *    token) never leaks via the Referer header.
 *  - `src` is the server-minted `preview_url` on a cookie-less route hardened
 *    with a strict CSP + injected meta CSP (see `document-preview.ts` on the API).
 *  - Where this frame may NAVIGATE is bounded by the SPA document's own CSP,
 *    which the API sends on the `index.html` response: `frame-src <preview
 *    origin>` and nothing else (`buildSpaCsp()` in `apps/api/src/routes/spa.ts`).
 *    Neither the `sandbox` attribute nor the preview response's CSP can close
 *    that channel — a sandboxed navigable may always navigate ITSELF, and
 *    navigation is covered by no `connect-src`/`form-action`. Verified in Chrome:
 *    a cross-origin self-navigation out of this frame is blocked with no network
 *    request to the target, while the initial load still succeeds. What it bounds
 *    is cross-origin NAVIGATION and nothing more — it is not a general
 *    exfiltration control (WebRTC/STUN is a named, pre-existing residual: see
 *    `buildPreviewCsp` on the API). Navigation WITHIN the allowed origin stays
 *    possible: in `USERCONTENT_URL` mode that origin is nothing but token-bound
 *    preview bytes, and in the default mode (`frame-src 'self'`) it is the whole
 *    app origin — still harmless, because the frame is opaque-origin so SameSite
 *    cookies are not sent, and `frame-src` is re-enforced across a 302 so an open
 *    redirect cannot launder the navigation back out. **Framing any NEW origin
 *    from the SPA therefore requires widening `frame-src` first**, or the frame
 *    will not load.
 *
 * The `pdf` iframe is DELIBERATELY sandboxless — Chrome refuses to render its
 * native PDF viewer inside a sandboxed iframe without `allow-same-origin`, and
 * loosening the html sandbox is not an option. This is safe: a PDF is not active
 * content in the embedding origin (browser-native viewer, no script access to
 * the parent), and the response carries `nosniff` + `inline` disposition + a
 * `default-src 'none'` CSP, so a body mislabelled `application/pdf` renders as a
 * broken PDF, never as HTML. So `image`/`pdf`/`text` are all inert and need no
 * sandbox.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getErrorMessage } from "@appstrate/core/errors";
import { cn } from "@appstrate/ui/cn";
import { Markdown } from "./markdown";
import { LoadingState, ErrorState } from "./page-states";
import { isMarkdownDoc } from "../lib/documents";
import { client } from "../api/client";

/**
 * The EXACT iframe sandbox token set for the HTML preview. The server ships the
 * same set in its CSP `sandbox` directive; move both or neither.
 */
export const PREVIEW_IFRAME_SANDBOX = "allow-scripts";

/** Inline-render cap for sanitized markdown. */
const INLINE_MARKDOWN_MAX_BYTES = 1_048_576; // 1 MiB

export interface ViewableDocument {
  id: string;
  name: string;
  mime: string;
  size: number;
  preview_url?: string | null;
  preview_kind: "html" | "image" | "pdf" | "text" | null;
}

function MarkdownPreview({ id, unavailable }: { id: string; unavailable: string }) {
  const [state, setState] = useState<{ text?: string; failed?: boolean }>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await client.GET("/api/documents/{id}/content", {
          params: { path: { id } },
          parseAs: "text",
        });
        if (cancelled) return;
        if (error || data === undefined) setState({ failed: true });
        else setState({ text: data });
      } catch {
        if (!cancelled) setState({ failed: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state.failed) return <ErrorState message={unavailable} />;
  if (state.text === undefined) return <LoadingState />;
  return (
    <div className="bg-background h-full w-full overflow-auto p-4">
      <Markdown>{state.text}</Markdown>
    </div>
  );
}

function TextPreview({ url, unavailable }: { url: string; unavailable: string }) {
  const [state, setState] = useState<{ text?: string; failed?: boolean }>({});

  useEffect(() => {
    let cancelled = false;
    fetch(url, { referrerPolicy: "no-referrer" })
      .then((response) =>
        response.ok ? response.text() : Promise.reject(new Error("preview fetch failed")),
      )
      .then((text) => {
        if (!cancelled) setState({ text });
      })
      .catch(() => {
        if (!cancelled) setState({ failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (state.failed) return <ErrorState message={unavailable} />;
  if (state.text === undefined) return <LoadingState />;
  return (
    <pre className="text-foreground h-full w-full overflow-auto p-4 font-mono text-xs break-words whitespace-pre-wrap">
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

export function DocumentViewer({
  documentId,
  document,
  isLoading,
  error,
  unavailableAction,
  className,
}: {
  documentId: string;
  document?: ViewableDocument;
  isLoading: boolean;
  error: unknown;
  unavailableAction?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation("documents");

  function renderBody() {
    if (isLoading) return <LoadingState />;
    if (error) return <ErrorState message={getErrorMessage(error)} />;
    if (!document?.preview_url) {
      return <UnavailablePreview message={t("preview.unavailable")} action={unavailableAction} />;
    }

    const previewUrl = document.preview_url;
    const frameTitle = t("preview.frameTitle", { name: document.name });

    if (isMarkdownDoc(document.mime, document.name) && document.size <= INLINE_MARKDOWN_MAX_BYTES) {
      return (
        <MarkdownPreview key={documentId} id={documentId} unavailable={t("preview.unavailable")} />
      );
    }

    if (document.preview_kind === "image") {
      return (
        <img
          src={previewUrl}
          alt={document.name}
          className="mx-auto max-h-full max-w-full object-contain"
        />
      );
    }
    if (document.preview_kind === "pdf") {
      return (
        // SECURITY: intentionally NO sandbox — see file header.
        <iframe
          referrerPolicy="no-referrer"
          src={previewUrl}
          title={frameTitle}
          className="h-full w-full border-0 bg-white"
        />
      );
    }
    if (document.preview_kind === "text") {
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
        className="h-full w-full border-0 bg-white"
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

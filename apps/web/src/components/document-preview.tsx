// SPDX-License-Identifier: Apache-2.0

/**
 * In-browser preview modal for a document, branching on the server-supplied
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
 *
 * The `pdf` iframe is DELIBERATELY sandboxless — Chrome refuses to render its
 * native PDF viewer inside a sandboxed iframe without `allow-same-origin`, and
 * loosening the html sandbox is not an option. This is safe: a PDF is not active
 * content in the embedding origin (browser-native viewer, no script access to
 * the parent), and the response carries `nosniff` + `inline` disposition + a
 * `default-src 'none'` CSP, so a body mislabelled `application/pdf` renders as a
 * broken PDF, never as HTML. So `image`/`pdf`/`text` are all inert and need no
 * sandbox.
 *
 * The DTO is refetched on each open so the short-lived preview token is fresh.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DownloadIcon } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { Button } from "@appstrate/ui/components/button";
import { Modal } from "./modal";
import { LoadingState, ErrorState } from "./page-states";
import { useDocument, useDocumentDownload } from "../hooks/use-documents";

/**
 * The EXACT iframe sandbox token set for the HTML preview. Exported (and asserted
 * in a unit test) so a regression that widens the sandbox is caught: it must stay
 * `"allow-scripts"` and nothing else. Applies ONLY to the html iframe — the pdf
 * iframe is intentionally sandboxless (see file header).
 */
export const PREVIEW_IFRAME_SANDBOX = "allow-scripts";

/**
 * Fetch a text/plaintext preview and render it in a scrollable monospace `<pre>`.
 * Client-side rendering (no execution): the server serves the bytes as
 * `text/plain` and this only shows them as text. The token in `url` is short-lived
 * and refetched with the DTO on each open.
 */
function TextPreview({ url, unavailable }: { url: string; unavailable: string }) {
  const [state, setState] = useState<{ text?: string; failed?: boolean }>({});

  // A `url` change remounts the component (keyed by the caller), so state
  // starts empty per URL — no synchronous reset needed inside the effect.
  useEffect(() => {
    let cancelled = false;
    fetch(url, { referrerPolicy: "no-referrer" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("preview fetch failed"))))
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

export function DocumentPreview({
  doc,
  open,
  onClose,
}: {
  // Only id + name are needed here (the DTO satisfies this structurally); the
  // rest is refetched via `useDocument`. Keeping the surface minimal lets the
  // chat pass a bare `{ id, name }` without importing the full DTO type.
  doc: { id: string; name: string };
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("documents");
  const download = useDocumentDownload();
  // Refetch the DTO on open for a fresh preview token (tokens are short-lived).
  const { data, isLoading, error } = useDocument(doc.id, open);
  const previewUrl = data?.preview_url;
  const kind = data?.preview_kind;
  const frameTitle = t("preview.frameTitle", { name: doc.name });

  // The single previewable-vs-download branch for EVERY consumer of this modal.
  // "Click a document" resolves to: preview when the server minted a
  // `preview_url`, download otherwise. Library rows gate their eye button on
  // `previewable`, so they almost never reach the download side here; chat chips
  // always open blind (no DTO in hand) and rely on this fallback. Keeping the
  // decision HERE (not duplicated per caller) is the whole point.
  //
  // Once-per-open guard: `autoDownloadedRef` is set the moment we fire and reset
  // only when `open` flips false, so unrelated re-renders (token refetch, parent
  // state) never re-trigger, and a NEW open of another non-previewable doc — a
  // fresh false→true transition — fires again.
  const autoDownloadedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      autoDownloadedRef.current = false;
      return;
    }
    // Wait until the DTO query settles successfully; a query `error` (403/404)
    // is NOT a download signal — it keeps the ErrorState below.
    if (isLoading || error || !data) return;
    if (data.preview_url) return; // previewable → the modal renders the preview
    if (autoDownloadedRef.current) return;
    autoDownloadedRef.current = true;
    void download(doc.id, doc.name);
    onClose();
  }, [open, isLoading, error, data, download, doc.id, doc.name, onClose]);

  function renderBody() {
    if (isLoading) return <LoadingState />;
    if (error) return <ErrorState message={getErrorMessage(error)} />;
    // Non-previewable docs are handled by the auto-download effect above (fire
    // download + onClose), so this ErrorState is effectively never seen. It
    // stays only to keep renderBody total for the pathological frame where the
    // effect hasn't run yet while still mounted.
    if (!previewUrl) return <ErrorState message={t("preview.unavailable")} />;

    if (kind === "image") {
      return (
        <img
          src={previewUrl}
          alt={doc.name}
          className="mx-auto max-h-full max-w-full object-contain"
        />
      );
    }
    if (kind === "pdf") {
      return (
        // SECURITY: intentionally NO sandbox — see file header (Chrome PDF
        // viewer + inert content). Do not add a sandbox attribute here.
        <iframe
          referrerPolicy="no-referrer"
          src={previewUrl}
          title={frameTitle}
          className="h-full w-full border-0 bg-white"
        />
      );
    }
    if (kind === "text") {
      return (
        <TextPreview key={previewUrl} url={previewUrl} unavailable={t("preview.unavailable")} />
      );
    }
    // Default: html — untrusted active content in the hardened sandbox.
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
    <Modal
      open={open}
      onClose={onClose}
      title={doc.name}
      className="h-[85vh] max-w-5xl"
      actions={
        <Button variant="outline" onClick={() => void download(doc.id, doc.name)}>
          <DownloadIcon className="size-4" />
          {t("row.download")}
        </Button>
      }
    >
      <div className="bg-muted h-full min-h-0 flex-1 overflow-hidden rounded-md border">
        {renderBody()}
      </div>
    </Modal>
  );
}

// SPDX-License-Identifier: Apache-2.0

/**
 * Sandboxed HTML preview modal for an agent-generated document.
 *
 * SECURITY: the iframe renders UNTRUSTED agent-generated HTML. Its isolation is
 * load-bearing and MUST NOT be loosened:
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
 * The DTO is refetched on each open so the short-lived preview token is fresh.
 */

import { useTranslation } from "react-i18next";
import { getErrorMessage } from "@appstrate/core/errors";
import { Modal } from "./modal";
import { LoadingState, ErrorState } from "./page-states";
import { useDocument, type DocumentDto } from "../hooks/use-documents";

/**
 * The EXACT iframe sandbox token set. Exported (and asserted in a unit test) so a
 * regression that widens the sandbox is caught: it must stay `"allow-scripts"`
 * and nothing else.
 */
export const PREVIEW_IFRAME_SANDBOX = "allow-scripts";

export function DocumentPreview({
  doc,
  open,
  onClose,
}: {
  doc: DocumentDto;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("documents");
  // Refetch the DTO on open for a fresh preview token (tokens are short-lived).
  const { data, isLoading, error } = useDocument(doc.id, open);
  const previewUrl = data?.preview_url;

  return (
    <Modal open={open} onClose={onClose} title={doc.name} className="h-[85vh] max-w-5xl">
      <div className="bg-muted h-full min-h-0 flex-1 overflow-hidden rounded-md border">
        {isLoading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={getErrorMessage(error)} />
        ) : previewUrl ? (
          <iframe
            // SECURITY: do not change these attributes — see file header.
            sandbox={PREVIEW_IFRAME_SANDBOX}
            referrerPolicy="no-referrer"
            src={previewUrl}
            title={t("preview.frameTitle", { name: doc.name })}
            className="h-full w-full border-0 bg-white"
          />
        ) : (
          <ErrorState message={t("preview.unavailable")} />
        )}
      </div>
    </Modal>
  );
}

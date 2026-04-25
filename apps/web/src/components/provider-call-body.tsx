// SPDX-License-Identifier: Apache-2.0

/**
 * Renders a provider call response body returned by the AFPS runtime
 * `<provider>_call` tools. The runtime serialises responses as JSON
 * containing `body` shaped as a discriminated union — see
 * `ProviderCallResponseBody` in
 * `packages/afps-runtime/src/resolvers/provider-tool.ts`:
 *   - `kind: "text"`   → UTF-8 textual payload (JSON, XML, plain text…)
 *   - `kind: "inline"` → small binary, base64-encoded, with mime type + size
 *   - `kind: "file"`   → large or `responseMode.toFile`-routed body
 *                        materialised in the run workspace
 *
 * The component is a leaf renderer: callers narrow `unknown` to
 * `ProviderCallBody` themselves (typically via `asProviderCallBody`
 * from `provider-call-body-utils`).
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  base64ToBytes,
  extForMime,
  formatBytes,
  type ProviderCallBody as ProviderCallBodyType,
} from "./provider-call-body-utils";

/** Cap above which we lazy-render `image/*` inline previews. */
const IMAGE_INLINE_PREVIEW_LIMIT = 256 * 1024;

interface ProviderCallBodyProps {
  body: ProviderCallBodyType;
  className?: string;
}

export function ProviderCallBody({ body, className }: ProviderCallBodyProps) {
  if (body.kind === "text") {
    return <TextBody text={body.text} className={className} />;
  }
  if (body.kind === "inline") {
    return <InlineBody body={body} className={className} />;
  }
  return <FileBody body={body} className={className} />;
}

function TextBody({ text, className }: { text: string; className?: string }) {
  return (
    <pre
      className={cn(
        "border-border bg-muted/30 text-foreground max-h-96 overflow-auto rounded-md border p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap",
        className,
      )}
    >
      {text}
    </pre>
  );
}

function InlineBody({
  body,
  className,
}: {
  body: Extract<ProviderCallBodyType, { kind: "inline" }>;
  className?: string;
}) {
  const { t } = useTranslation("agents");
  const [renderImage, setRenderImage] = useState(body.size <= IMAGE_INLINE_PREVIEW_LIMIT);
  const isImage = body.mimeType.startsWith("image/");
  const dataUrl = useMemo(
    () => (isImage && renderImage ? `data:${body.mimeType};base64,${body.data}` : null),
    [isImage, renderImage, body.mimeType, body.data],
  );

  const onDownload = () => {
    const bytes = base64ToBytes(body.data);
    // Workaround for Bun/Browser typing mismatch on BlobPart — copy into
    // a fresh ArrayBuffer so the Blob constructor is unambiguous.
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const blob = new Blob([ab], { type: body.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inline-${Date.now()}${extForMime(body.mimeType)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={cn("border-border bg-card overflow-hidden rounded-md border", className)}>
      <div className="border-border flex items-center gap-2 border-b px-3 py-2 text-xs">
        <span aria-hidden>📦</span>
        <span className="text-foreground font-medium">{t("providerBody.inline")}</span>
        <span className="text-muted-foreground font-mono">{body.mimeType}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground font-mono">{formatBytes(body.size)}</span>
        <Button variant="outline" size="sm" className="ml-auto h-7 text-xs" onClick={onDownload}>
          {t("providerBody.download")}
        </Button>
      </div>
      <div className="bg-muted/20 p-3">
        {isImage && dataUrl ? (
          <img
            src={dataUrl}
            alt={t("providerBody.inlineImageAlt")}
            className="max-h-96 max-w-full object-contain"
          />
        ) : isImage ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRenderImage(true)}
            className="text-muted-foreground text-xs"
          >
            {t("providerBody.renderImage")}
          </Button>
        ) : (
          <p className="text-muted-foreground text-xs">{t("providerBody.binaryNoPreview")}</p>
        )}
      </div>
    </div>
  );
}

function FileBody({
  body,
  className,
}: {
  body: Extract<ProviderCallBodyType, { kind: "file" }>;
  className?: string;
}) {
  const { t } = useTranslation("agents");
  const shaShort = body.sha256.length > 12 ? `${body.sha256.slice(0, 12)}…` : body.sha256;
  return (
    <div
      className={cn(
        "border-border bg-card flex flex-col gap-1 rounded-md border px-3 py-2 text-xs",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden>📄</span>
        <span className="text-foreground font-mono break-all">{body.path}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground font-mono">{formatBytes(body.size)}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground font-mono">{body.mimeType}</span>
      </div>
      <div className="text-muted-foreground/80 font-mono text-[10px]">
        {t("providerBody.sha256")}: {shaShort}
      </div>
    </div>
  );
}

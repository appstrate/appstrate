// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { normalizeHttpUrl } from "@appstrate/core/url";
import { substituteCallbackUrl } from "../../lib/callback-url-hint";

/**
 * Publisher-authored `callback_url_hint` (AFPS §7.10); the consumer substitutes `{{callback_url}}`
 * because only it knows the deployment URL. Linkified only when the result is a whole http(s) URL,
 * so a publisher-controlled string never becomes a navigation sink.
 */
export function CallbackUrlHint({
  hint,
  callbackUrl,
  authKey,
}: {
  hint: string;
  callbackUrl: string;
  authKey: string;
}) {
  const { t } = useTranslation("settings");
  const resolved = substituteCallbackUrl(hint, callbackUrl);
  const href = normalizeHttpUrl(resolved);
  return (
    <p className="text-muted-foreground text-[0.7rem]" data-testid={`callback-url-hint-${authKey}`}>
      <span className="font-semibold">{t("integration.oauthClient.callbackUrlHint")}:</span>{" "}
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
          {resolved}
        </a>
      ) : (
        <span className="font-mono">{resolved}</span>
      )}
    </p>
  );
}

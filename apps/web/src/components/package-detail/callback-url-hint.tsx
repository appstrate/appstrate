// SPDX-License-Identifier: Apache-2.0

/**
 * Publisher-authored callback-registration hint from an integration manifest
 * (`auths.<key>.callback_url_hint`, AFPS §7.10).
 *
 * The hint carries a `{{callback_url}}` placeholder that the CONSUMER
 * substitutes — the callback URL depends on the deployment (`APP_URL`) and on
 * whether the resolved OAuth client overrides it, neither of which a publisher
 * can know when authoring the manifest. Rendering the placeholder verbatim
 * shows the admin a literal `{{callback_url}}` in the middle of the one string
 * they are supposed to copy into the provider's console, which is worse than
 * showing nothing.
 *
 * Separate from the page for the same reason `SetupGuideSteps` is: the URL
 * crosses a navigation trust boundary. The substitution itself lives in
 * `lib/callback-url-hint` so it can be exercised as a plain function.
 */

import { useTranslation } from "react-i18next";
import { normalizeHttpUrl } from "@appstrate/core/url";
import { substituteCallbackUrl } from "../../lib/callback-url-hint";

/**
 * Render the hint, linkified when the substituted result is a whole http(s)
 * URL. Anything else — prose, a mailto:, a javascript: URL — stays plain text,
 * so a publisher-controlled string can never become a navigation sink.
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

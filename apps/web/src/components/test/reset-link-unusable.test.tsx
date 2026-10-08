// SPDX-License-Identifier: Apache-2.0

/**
 * A reset refused with `credential_change_revocation_failed` wrote the password
 * and spent the link: the page drops the form and offers a new reset link,
 * which signs the other devices out again, instead of calling the link invalid.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { ResetLinkUnusable } from "../reset-link-unusable.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

describe("a reset whose sign-out did not complete", () => {
  it("says the password changed and leads to a new reset link", () => {
    const html = render(
      <ResetLinkUnusable message={i18n.t("resetPassword.revocationFailed", { ns: "settings" })} />,
    );
    expect(html).toContain("pas tous pu être déconnectés");
    expect(html).toContain('href="/forgot-password"');
  });
});

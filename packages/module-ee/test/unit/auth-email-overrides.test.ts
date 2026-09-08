// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The four platform email templates this module overrides (`emailOverrides`).
 * Every one of them carries a single-use credential in its link, so the
 * assertion that matters is escaping: the URL must reach the reader intact.
 */

import { describe, expect, it } from "bun:test";
import { renderEeVerificationEmail } from "../../src/emails/templates/verification.ts";
import { renderEeInvitationEmail } from "../../src/emails/templates/invitation.ts";
import { renderEeMagicLinkEmail } from "../../src/emails/templates/magic-link.ts";
import { renderEeResetPasswordEmail } from "../../src/emails/templates/reset-password.ts";
import type { RenderedEmail, SupportedLocale } from "../../src/emails/types.ts";

// The `&` is what makes the escaping assertion discriminate: an unescaped body
// would contain this string verbatim, an escaped one contains `&amp;`.
const URL_WITH_AMPERSAND = "https://app.example.com/auth?token=abc123&callback=%2Fspaces";
const ESCAPED_URL = "https://app.example.com/auth?token=abc123&amp;callback=%2Fspaces";

const LOCALES: readonly SupportedLocale[] = ["fr", "en"];

const renderers: Record<string, (locale: SupportedLocale) => RenderedEmail> = {
  verification: (locale) =>
    renderEeVerificationEmail({
      user: { name: "Ada", email: "ada@example.com" },
      url: URL_WITH_AMPERSAND,
      locale,
    }),
  invitation: (locale) =>
    renderEeInvitationEmail({
      email: "ada@example.com",
      inviteUrl: URL_WITH_AMPERSAND,
      orgName: "Acme Corp",
      inviterName: "Grace",
      role: "member",
      locale,
    }),
  "magic-link": (locale) =>
    renderEeMagicLinkEmail({ email: "ada@example.com", url: URL_WITH_AMPERSAND, locale }),
  "reset-password": (locale) =>
    renderEeResetPasswordEmail({ email: "ada@example.com", url: URL_WITH_AMPERSAND, locale }),
};

describe("EE platform email overrides", () => {
  for (const [name, render] of Object.entries(renderers)) {
    describe(name, () => {
      for (const locale of LOCALES) {
        it(`renders a subject and an escaped link in ${locale}`, () => {
          const result = render(locale);

          expect(result.subject.length).toBeGreaterThan(0);
          expect(result.subject).not.toMatch(/[\r\n]/);
          expect(result.html).toContain("<!DOCTYPE html");
          expect(result.html).toContain(`<html lang="${locale}"`);

          // The fallback line renders the URL as text, so it must be escaped.
          expect(result.html).toContain(ESCAPED_URL);
          // And the CTA must still link to the URL itself.
          expect(result.html).toContain(`href="${URL_WITH_AMPERSAND}"`);
        });
      }

      it("renders different copy per locale", () => {
        expect(render("fr").subject).not.toBe(render("en").subject);
      });
    });
  }
});

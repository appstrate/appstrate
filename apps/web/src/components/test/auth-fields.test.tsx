// SPDX-License-Identifier: Apache-2.0

/**
 * The password minimum the sign-in / sign-up forms declare must be the one the
 * server enforces.
 *
 * It was not. Both forms restated the rule inline as `minLength: 6` and told
 * the user so (`validation.minLength` with `min: 6`), while Better Auth
 * (`minPasswordLength`, packages/db/src/auth.ts), the two OpenAPI request
 * schemas and the server-rendered OIDC signup page all said 8. A 6-character
 * password therefore passed the SPA's own validation, was submitted, and came
 * back rejected. The number now has one home
 * (`packages/db/src/password-policy.ts`, re-exported to the SPA through
 * `@appstrate/shared-types`) and one consumer — the shared field component
 * asserted here.
 *
 * Same no-DOM harness as the other component suites (this repo has no jsdom):
 * `renderToStaticMarkup` via `test/render.tsx`, asserted on the emitted HTML.
 * The fields are rendered directly rather than through `LoginForm` /
 * `RegisterForm`, whose import graph reaches the theme store and dereferences
 * `window` at module scope.
 */

import { describe, it, expect } from "bun:test";
import { useForm } from "react-hook-form";
import { MIN_PASSWORD_LENGTH } from "@appstrate/shared-types";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import { EmailField, PasswordField } from "../auth-fields.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

type Fields = { email: string; password: string };

function PasswordHarness({ autoComplete }: { autoComplete: "current-password" | "new-password" }) {
  const { register } = useForm<Fields>();
  return (
    <PasswordField
      register={register}
      name="password"
      label="Mot de passe"
      invalid={false}
      autoComplete={autoComplete}
    />
  );
}

function EmailHarness({ fixedValue }: { fixedValue?: string }) {
  const { register } = useForm<Fields>();
  return (
    <EmailField
      register={register}
      name="email"
      label="Email"
      invalid={false}
      error={undefined}
      fixedValue={fixedValue}
    />
  );
}

describe("shared auth fields", () => {
  it("declares the server's minimum on a new password, in the markup", () => {
    // Lower-cased before matching: React emits the JSX prop spelling here
    // (`minLength`), the browser reads the attribute case-insensitively, and
    // this assertion is about the VALUE, not React's casing of the day.
    const html = render(<PasswordHarness autoComplete="new-password" />).toLowerCase();
    // Parity with the server-rendered OIDC signup page, which has always
    // carried `minlength` — the two signup surfaces now refuse the same input.
    expect(html).toContain(`minlength="${MIN_PASSWORD_LENGTH}"`);
    expect(html).toContain('autocomplete="new-password"');
  });

  it("attaches NO native minimum on sign-in", () => {
    // The minimum describes what may be CREATED. Enforcing it on sign-in would
    // lock out an account whose password predates the rule.
    const html = render(<PasswordHarness autoComplete="current-password" />).toLowerCase();
    expect(html).not.toContain("minlength");
    expect(html).toContain('autocomplete="current-password"');
  });

  it("renders the email field read-only when the address is imposed", () => {
    const html = render(<EmailHarness fixedValue="invited@example.com" />).toLowerCase();
    expect(html).toContain('value="invited@example.com"');
    expect(html).toContain("readonly");
  });

  it("renders an editable email field otherwise", () => {
    const html = render(<EmailHarness />).toLowerCase();
    expect(html).not.toContain("readonly");
    expect(html).toContain('autocomplete="email"');
  });
});

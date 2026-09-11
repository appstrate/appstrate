// SPDX-License-Identifier: Apache-2.0

/**
 * The signup policy of an OAuth client: what the operator may answer, and when.
 * The policy is what a signup WOULD receive, so an org-level client edits it
 * whether or not signups are currently allowed. `SignupPolicyFields` is rendered
 * rather than the modal, whose Radix chrome needs a DOM.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../../../i18n.ts";
import { render } from "../../../../test/render.tsx";
import { SignupPolicyFields } from "../oauth-client-form-modal.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const SPACES = [{ id: "spc_1", name: "Production" }];
const ROLE_OPTIONS = [{ value: "preset:viewer", label: "viewer" }];

function renderFields(overrides: { isOrgLevel?: boolean; allowSignup?: boolean } = {}): string {
  return render(
    <SignupPolicyFields
      isOrgLevel={overrides.isOrgLevel ?? true}
      allowSignup={overrides.allowSignup ?? false}
      onAllowSignupChange={() => {}}
      signupRole="member"
      onSignupRoleChange={() => {}}
      assignments={[]}
      onAssignmentsChange={() => {}}
      isPending={false}
      spaces={SPACES}
      roleOptions={ROLE_OPTIONS}
      catalogLoading={false}
      catalogError={null}
      onRetryCatalog={() => {}}
    />,
  );
}

/**
 * The `<select>` opening tag, so `disabled` is read off the element itself.
 * Absent is not "not disabled", so presence is asserted before attributes are.
 */
function signupRoleSelect(html: string): string | null {
  const start = html.indexOf('<select id="oauth-client-signup-role"');
  return start === -1 ? null : html.slice(start, html.indexOf(">", start));
}

describe("org-level signup policy", () => {
  it("edits the role and the space grants while signup is off", () => {
    const html = renderFields({ allowSignup: false });
    expect(html).toContain("Rôle attribué à l'auto-inscription");
    const select = signupRoleSelect(html);
    expect(select).not.toBeNull();
    expect(select).not.toContain('disabled=""');
    expect(html).toContain("<legend");
    expect(html).toContain("Espaces");
  });
});

describe("space-level signup policy", () => {
  it("offers the opt-in alone — the role and the grants are org policy", () => {
    const html = renderFields({ isOrgLevel: false, allowSignup: true });
    expect(html).toContain("Autoriser l'inscription de nouveaux utilisateurs");
    expect(html).not.toContain("Rôle attribué à l'auto-inscription");
    expect(html).not.toContain("<legend");
  });
});

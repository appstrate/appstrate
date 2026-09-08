// SPDX-License-Identifier: Apache-2.0

/**
 * The signup policy of an OAuth client: what the operator may answer, and when.
 *
 * The policy is what a signup WOULD receive, so an org-level client edits it
 * whether or not signups are currently allowed — the server stores and
 * validates it the same way either side of the opt-in.
 *
 * `SignupPolicyFields` is rendered rather than the modal, whose Radix dialog
 * chrome renders nothing without a DOM (the web runner has none).
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../../../i18n.ts";
import { render } from "../../../../test/render.tsx";
import { SignupPolicyFields } from "../oauth-client-form-modal.tsx";
import { validateSpaceAssignments } from "../../../../lib/space-assignments.ts";

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

/** The `<select>` opening tag, so `disabled` is read off the element itself. */
function signupRoleSelect(html: string): string {
  const start = html.indexOf('<select id="oauth-client-signup-role"');
  return start === -1 ? "" : html.slice(start, html.indexOf(">", start));
}

describe("org-level signup policy", () => {
  it("edits the role and the space grants while signup is off", () => {
    const html = renderFields({ allowSignup: false });
    expect(html).toContain("Rôle attribué à l'auto-inscription");
    expect(signupRoleSelect(html)).not.toContain('disabled=""');
    expect(html).toContain("<legend");
    expect(html).toContain("Espaces");
  });

  it("still requires a space for a guest policy while signup is off", () => {
    expect(validateSpaceAssignments("guest", [], "pick at least one space")).toBe(
      "pick at least one space",
    );
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

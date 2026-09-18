// SPDX-License-Identifier: Apache-2.0

/**
 * The one credential-entry surface. Its whole job is turning an auth manifest
 * into inputs, and it used to read only the property NAMES — so a manifest's
 * `title` and `description` reached nobody, and every integration declaring
 * them showed its users a bare `snake_case` key with no explanation.
 *
 * Two behaviours are load-bearing enough to pin: what is shown (labels,
 * descriptions, declared defaults) and what is NOT (credentials the platform
 * mints for itself — asking someone to type a value about to be generated is
 * worse than useless, it suggests they should have one).
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { CredentialFields } from "../credential-fields.tsx";
import { initialCredentialValues } from "../credential-schema.ts";
import type { IntegrationManifestAuth } from "../../../hooks/use-integrations.ts";

await i18nReady;
await i18n.changeLanguage("fr");

/** An auth shaped like @appstrate/ssh: four fields typed, three provisioned. */
const SSH_AUTH = {
  type: "custom",
  credentials: {
    schema: {
      type: "object",
      required: ["host", "user"],
      properties: {
        private_key: { type: "string", title: "Clé privée Appstrate" },
        host: { type: "string", title: "Hôte", description: "Nom DNS ou adresse IP publique." },
        port: { type: "string", title: "Port SSH", default: "22" },
        user: { type: "string", title: "Compte Unix sur la cible" },
        host_key: { type: "string", title: "Clé publique de l'hôte" },
        allowed_verbs: { type: "string", title: "Verbes autorisés", default: '["hostname"]' },
        read_only: { type: "string", title: "Lecture seule", default: "1" },
      },
    },
  },
  _meta: {
    "dev.appstrate/provisioning": {
      kind: "ssh_keypair",
      provides: ["private_key", "host_key", "read_only"],
    },
  },
} as unknown as IntegrationManifestAuth;

const noop = () => {};

/** The harness renders to STATIC MARKUP — there is no DOM to query here. */
const html = (auth: IntegrationManifestAuth, values: Record<string, string> = {}) =>
  render(<CredentialFields auth={auth} values={values} onChange={noop} />);

/** The rendered `<input>`/`<textarea>` tag for one field, or null. */
function inputTag(markup: string, field: string): string | null {
  const m = markup.match(
    new RegExp(`<(?:input|textarea)[^>]*data-testid="field-input-${field}"[^>]*>`),
  );
  return m ? m[0] : null;
}

describe("CredentialFields — provisioned credentials", () => {
  it("renders no input for a credential the platform mints", () => {
    const markup = html(SSH_AUTH);
    for (const hidden of ["private_key", "host_key", "read_only"]) {
      expect(inputTag(markup, hidden)).toBeNull();
    }
  });

  it("still renders the fields only the user can answer", () => {
    const markup = html(SSH_AUTH);
    for (const shown of ["host", "port", "user", "allowed_verbs"]) {
      expect(inputTag(markup, shown)).not.toBeNull();
    }
  });

  it("keeps every field when the auth declares no provisioning", () => {
    const plain = { ...SSH_AUTH, _meta: {} } as unknown as IntegrationManifestAuth;
    expect(inputTag(html(plain), "private_key")).not.toBeNull();
  });
});

describe("CredentialFields — manifest-declared presentation", () => {
  it("labels a field with the manifest title rather than its raw name", () => {
    const markup = html(SSH_AUTH);
    expect(markup).toContain(">Compte Unix sur la cible</label>");
    expect(markup).not.toContain(">user</label>");
  });

  it("renders the declared description under the input", () => {
    const markup = html(SSH_AUTH);
    expect(markup).toContain("Nom DNS ou adresse IP publique.");
    expect(markup).toContain('data-testid="field-description-host"');
    // A field with no description must not leave an empty paragraph behind.
    expect(markup).not.toContain('data-testid="field-description-user"');
  });

  it("prefills a declared default", () => {
    expect(inputTag(html(SSH_AUTH), "port")).toContain('value="22"');
  });

  it("lets a submitted empty value win over the default", () => {
    // Clearing a prefilled field must stay cleared, or the box cannot be
    // emptied at all.
    expect(inputTag(html(SSH_AUTH, { port: "" }), "port")).not.toContain('value="22"');
  });
});

describe("initialCredentialValues", () => {
  it("seeds exactly the defaults that are shown, and nothing provisioned", () => {
    // A default the form displays but does not seed would be a value under the
    // user's eyes that never reaches the server.
    expect(initialCredentialValues(SSH_AUTH)).toEqual({
      port: "22",
      allowed_verbs: '["hostname"]',
    });
  });
});

// SPDX-License-Identifier: Apache-2.0

/**
 * The credential form renders the auth `GET /api/integrations/connect/context`
 * serves: every declared field, with its declared label and description.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { CredentialFields } from "../credential-fields.tsx";
import { initialCredentialValues } from "../credential-schema.ts";
import type { IntegrationManifestAuth } from "../../../hooks/use-integrations.ts";

await i18nReady;
await i18n.changeLanguage("fr");

/** The @appstrate/ssh auth as the context endpoint serves it (minted key stripped). */
const SSH_AUTH = {
  type: "custom",
  credentials: {
    schema: {
      type: "object",
      required: ["host", "user"],
      properties: {
        host: { type: "string", title: "Hôte", description: "Nom DNS ou adresse IP publique." },
        port: { type: "string", title: "Port SSH", default: "22" },
        user: { type: "string", title: "Compte Unix sur la cible" },
        host_key: { type: "string", title: "Clé publique de l'hôte" },
      },
    },
  },
  _meta: {
    "dev.appstrate/provisioning": {
      kind: "ssh_keypair",
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

describe("CredentialFields — the served schema, verbatim", () => {
  it("renders an input for every field the auth declares", () => {
    const markup = html(SSH_AUTH);
    for (const shown of ["host", "port", "user", "host_key"]) {
      expect(inputTag(markup, shown)).not.toBeNull();
    }
    // Nothing undeclared: not the minted key, not an auth-type default field.
    for (const hidden of ["private_key", "api_key", "password"]) {
      expect(inputTag(markup, hidden)).toBeNull();
    }
  });

  it("renders no input for an auth whose declared properties are empty", () => {
    // Every field minted server-side leaves `properties: {}` — not a cue to
    // fall back on the auth type's default fields.
    const allMinted = {
      type: "api_key",
      credentials: { schema: { type: "object", properties: {} } },
    } as unknown as IntegrationManifestAuth;
    expect(html(allMinted)).not.toContain("field-input-");
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
});

describe("CredentialFields — values belong to the caller", () => {
  it("renders the value it is given, a cleared one included", () => {
    const seeded = html(SSH_AUTH, initialCredentialValues(SSH_AUTH));
    expect(inputTag(seeded, "port")).toContain('value="22"');
    const cleared = html(SSH_AUTH, { ...initialCredentialValues(SSH_AUTH), port: "" });
    expect(inputTag(cleared, "port")).not.toContain('value="22"');
  });
});

describe("initialCredentialValues", () => {
  it("seeds exactly the defaults the auth declares", () => {
    // A default the form displays but does not seed would be a value under the
    // user's eyes that never reaches the server.
    expect(initialCredentialValues(SSH_AUTH)).toEqual({
      port: "22",
    });
  });
});

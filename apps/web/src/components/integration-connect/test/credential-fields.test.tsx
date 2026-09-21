// SPDX-License-Identifier: Apache-2.0

/**
 * The one credential-entry surface. Its whole job is turning the auth served by
 * `GET /api/integrations/connect/context` into inputs — every declared field,
 * and only those, with the labels and descriptions it declares. Values are the
 * caller's: the form seeds them with `initialCredentialValues` and owns them
 * from there.
 *
 * It filters NOTHING. A credential the platform mints for itself is already
 * absent from that schema, stripped server-side, because which names a
 * provisioning kind owns is a property of the provisioner rather than of the
 * manifest. A second filter here could only ever disagree with the first.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { CredentialFields } from "../credential-fields.tsx";
import { initialCredentialValues } from "../credential-schema.ts";
import type { IntegrationManifestAuth } from "../../../hooks/use-integrations.ts";

await i18nReady;
await i18n.changeLanguage("fr");

/**
 * The @appstrate/ssh auth AS THE CONTEXT ENDPOINT SERVES IT: the minted
 * `private_key` is already gone, so these four are what the form must ask for.
 */
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
    // And nothing it does not declare.
    expect(inputTag(markup, "private_key")).toBeNull();
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
  it("renders the value it is given", () => {
    const seeded = html(SSH_AUTH, initialCredentialValues(SSH_AUTH));
    expect(inputTag(seeded, "port")).toContain('value="22"');
  });

  it("lets a cleared field stay cleared", () => {
    // Clearing a seeded field must stay cleared, or the box cannot be emptied
    // at all.
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

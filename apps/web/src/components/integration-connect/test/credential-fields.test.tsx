// SPDX-License-Identifier: Apache-2.0

/**
 * The credential form renders the auth `GET /api/integrations/connect/context`
 * serves: every declared field, with its declared label and description.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { CredentialFields } from "../credential-fields.tsx";
import { deriveFieldNames, initialCredentialValues } from "../credential-schema.ts";
import type { IntegrationManifestAuth } from "../../../hooks/use-integrations.ts";

await i18nReady;
await i18n.changeLanguage("fr");

/** The @appstrate/ssh auth as the context endpoint serves it (minted key stripped). */
const SSH_AUTH = {
  type: "custom",
  credentials: {
    schema: {
      type: "object",
      required: ["host", "user", "host_key"],
      properties: {
        host: { type: "string", title: "Hôte", description: "Nom DNS ou adresse IP publique." },
        port: { type: "string", title: "Port SSH", default: "22" },
        user: { type: "string", title: "Compte Unix sur la cible" },
        host_key: { type: "string", title: "Clé publique de l'hôte" },
      },
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

  it("orders required fields by `required`, whatever order `properties` arrives in", () => {
    // jsonb hands `properties` back shortest key first: `auth_token` before `account_sid`.
    const twilio = {
      type: "api_key",
      credentials: {
        schema: {
          type: "object",
          required: ["account_sid", "auth_token"],
          properties: { auth_token: { type: "string" }, account_sid: { type: "string" } },
        },
      },
    } as unknown as IntegrationManifestAuth;
    const markup = html(twilio);
    expect(markup.indexOf("field-input-account_sid")).toBeGreaterThan(-1);
    expect(markup.indexOf("field-input-account_sid")).toBeLessThan(
      markup.indexOf("field-input-auth_token"),
    );
    // Optional fields follow the required ones.
    const ssh = html(SSH_AUTH);
    expect(ssh.indexOf("field-input-host_key")).toBeLessThan(ssh.indexOf("field-input-port"));
  });

  it("ignores a `required` entry naming no declared field, and a non-array `required`", () => {
    const auth = (required: unknown) =>
      ({
        type: "custom",
        credentials: {
          schema: { type: "object", required, properties: { b: { type: "string" }, a: {} } },
        },
      }) as unknown as IntegrationManifestAuth;
    expect(deriveFieldNames(auth(["a", "ghost"]))).toEqual(["a", "b"]);
    expect(deriveFieldNames(auth("a"))).toEqual(["b", "a"]);
    expect(deriveFieldNames(auth({ 0: "a" }))).toEqual(["b", "a"]);
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

describe("CredentialFields — widget per field", () => {
  type Widget = "password" | "textarea" | "text";
  const SECRET = { type: "string", writeOnly: true };
  const PLAIN = { type: "string" };
  // Masking follows the manifest; a multi-line widget follows the name.
  const FIELDS: Record<string, [schema: Record<string, unknown>, widget: Widget]> = {
    api_key: [SECRET, "password"],
    passcode: [SECRET, "password"],
    pin: [{ type: "string", format: "password" }, "password"],
    // A secret-sounding name the manifest does not mark stays readable.
    secret_header_name: [PLAIN, "text"],
    consumer_key: [PLAIN, "text"],
    host_key: [PLAIN, "text"],
    host: [PLAIN, "text"],
    username: [PLAIN, "text"],
    client_key: [SECRET, "textarea"],
    private_key: [SECRET, "textarea"],
    client_cert: [PLAIN, "textarea"],
    certificate: [PLAIN, "textarea"],
    key: [PLAIN, "textarea"],
    ssh_public_key: [PLAIN, "textarea"],
  };
  const auth = {
    type: "custom",
    credentials: {
      schema: {
        type: "object",
        properties: Object.fromEntries(Object.entries(FIELDS).map(([f, [schema]]) => [f, schema])),
      },
    },
  } as unknown as IntegrationManifestAuth;

  function expectWidget(markup: string, field: string, widget: Widget) {
    const tag = inputTag(markup, field);
    if (widget === "textarea") {
      expect(tag).toStartWith("<textarea");
    } else {
      expect(tag).toStartWith("<input");
      expect(tag).toContain(`type="${widget}"`);
    }
  }

  for (const [field, [, widget]] of Object.entries(FIELDS)) {
    it(`renders ${field} as ${widget}`, () => expectWidget(html(auth), field, widget));
  }

  it("masks the secret of an api_key or basic auth with no declared schema", () => {
    expectWidget(
      html({ type: "api_key" } as unknown as IntegrationManifestAuth),
      "api_key",
      "password",
    );
    const basic = html({ type: "basic" } as unknown as IntegrationManifestAuth);
    expectWidget(basic, "username", "text");
    expectWidget(basic, "password", "password");
  });

  it("renders the PEM fields of an mtls auth with no declared schema as textareas", () => {
    const markup = html({ type: "mtls" } as unknown as IntegrationManifestAuth);
    expectWidget(markup, "client_key", "textarea");
    expectWidget(markup, "client_cert", "textarea");
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

// SPDX-License-Identifier: Apache-2.0

/**
 * Connection variables (AFPS §7.12) in the connect form and on connection
 * rows: the served `variables.schema` becomes one required input per variable,
 * prefilled from the reconnected connection then the declared default.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../../i18n.ts";
import { render } from "../../../test/render.tsx";
import { VariableFields } from "../variable-fields.tsx";
import { ConnectionVariablesLine } from "../connection-variables-line.tsx";
import {
  initialVariableValues,
  variableFields,
  type ConnectContextVariables,
} from "../connection-variables-schema.ts";

await i18nReady;
await i18n.changeLanguage("fr");

/** The GitLab system package's declaration, as `GET /connect/context` serves it. */
const SCHEMA = {
  type: "object",
  properties: {
    base_url: {
      type: "string",
      format: "uri",
      pattern: "^https?://",
      title: "URL de l'instance GitLab",
      description: "Racine de votre instance, sans chemin.",
      default: "https://gitlab.com",
    },
    group: { type: "string", examples: ["acme"] },
  },
  required: ["base_url", "group"],
};

const ctx = (values: Record<string, string> = {}): ConnectContextVariables => ({
  schema: SCHEMA,
  values,
});

const noop = () => {};

function inputTag(markup: string, name: string): string | null {
  const m = markup.match(new RegExp(`<input[^>]*data-testid="variable-input-${name}"[^>]*>`));
  return m ? m[0] : null;
}

describe("variableFields", () => {
  it("reads every declared variable, in declaration order, with its presentation", () => {
    expect(variableFields(SCHEMA)).toEqual([
      {
        name: "base_url",
        title: "URL de l'instance GitLab",
        description: "Racine de votre instance, sans chemin.",
        placeholder: "https://gitlab.com",
        format: "uri",
      },
      {
        name: "group",
        title: undefined,
        description: undefined,
        placeholder: "acme",
        format: undefined,
      },
    ]);
  });
});

describe("initialVariableValues", () => {
  it("seeds the declared default on a fresh connect", () => {
    expect(initialVariableValues(ctx())).toEqual({ base_url: "https://gitlab.com" });
  });

  it("prefers the reconnected connection's value over the default", () => {
    expect(
      initialVariableValues(ctx({ base_url: "https://git.example.com", group: "ops" })),
    ).toEqual({ base_url: "https://git.example.com", group: "ops" });
  });

  it("never seeds a value the manifest no longer declares", () => {
    expect(initialVariableValues(ctx({ retired: "x" }))).toEqual({
      base_url: "https://gitlab.com",
    });
  });

  it("seeds nothing for an integration without variables", () => {
    expect(initialVariableValues(null)).toEqual({});
    expect(initialVariableValues(undefined)).toEqual({});
  });
});

describe("VariableFields", () => {
  const html = (
    values: Record<string, string>,
    errors: Record<string, string> = {},
    readOnly?: boolean,
  ) =>
    render(
      <VariableFields
        fields={variableFields(SCHEMA)}
        values={values}
        onChange={noop}
        errors={errors}
        readOnly={readOnly}
      />,
    );

  it("renders one required input per variable, prefilled, labelled by its title", () => {
    const markup = html(initialVariableValues(ctx()));
    const baseUrl = inputTag(markup, "base_url");
    expect(baseUrl).toContain('value="https://gitlab.com"');
    expect(baseUrl).toContain("required");
    expect(baseUrl).toContain('inputMode="url"');
    expect(markup).toContain(">URL de l'instance GitLab</label>");
    expect(markup).toContain("Racine de votre instance, sans chemin.");
    // No title: the raw name, and the example as placeholder.
    expect(markup).toContain(">group</label>");
    expect(inputTag(markup, "group")).toContain('placeholder="acme"');
  });

  it("shows a refusal under its input and ties it to the input", () => {
    const markup = html({}, { base_url: "Adresse refusée" });
    expect(markup).toContain('data-testid="variable-error-base_url"');
    expect(markup).toContain("Adresse refusée");
    const baseUrl = inputTag(markup, "base_url")!;
    expect(baseUrl).toContain('aria-invalid="true"');
    expect(baseUrl).toContain("variable-base_url-error");
    expect(markup).not.toContain('data-testid="variable-error-group"');
  });

  it("is editable on a fresh connect, with no hint", () => {
    const markup = html(initialVariableValues(ctx()));
    expect(inputTag(markup, "base_url")).not.toContain("readOnly");
    expect(markup).not.toContain('data-testid="variables-locked-hint"');
  });

  it("keeps a reconnect on its instance: read-only inputs and a hint to add a connection", () => {
    const markup = html({ base_url: "https://git.example.com", group: "ops" }, {}, true);
    expect(inputTag(markup, "base_url")).toContain("readOnly");
    expect(inputTag(markup, "group")).toContain("readOnly");
    expect(markup).toContain("ajoutez une nouvelle connexion");
  });
});

describe("ConnectionVariablesLine", () => {
  it("lists the values under the connection's label, the names in the tooltip", () => {
    const markup = render(
      <ConnectionVariablesLine
        variables={{ base_url: "https://git.example.com", group: "ops" }}
        testId="vars"
      />,
    );
    expect(markup).toContain("https://git.example.com · ops");
    expect(markup).toContain('title="base_url: https://git.example.com\ngroup: ops"');
  });

  it("renders nothing for an integration that declares none", () => {
    expect(render(<ConnectionVariablesLine variables={null} />)).toBe("");
    expect(render(<ConnectionVariablesLine variables={{}} />)).toBe("");
  });
});

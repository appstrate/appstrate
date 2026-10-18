// SPDX-License-Identifier: Apache-2.0

/**
 * The hosted connect form's `POST /connect/submit`: the body it sends for each
 * auth shape, where an oauth2 answer takes the window, and which refusals land
 * beside a variable input.
 */

import { describe, expect, it } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { toApiError } from "../../api/client.ts";
import {
  connectSubmitBody,
  hostedConnectErrorMessage,
  missingVariables,
  submitHostedConnect,
  usesAuthorizationFlow,
  variableFieldErrors,
} from "../hosted-connect-submit.ts";

await i18nReady;
await i18n.changeLanguage("fr");

const VARS = ["base_url"];

describe("usesAuthorizationFlow", () => {
  it("redirects an authorization-code oauth2 auth", () => {
    expect(usesAuthorizationFlow({ type: "oauth2" })).toBe(true);
  });

  it("collects an oauth2 connect.login grant as a credential form", () => {
    const login = { request: { url: "https://idp.example.test/token" } };
    expect(usesAuthorizationFlow({ type: "oauth2", connect: { login } })).toBe(false);
  });

  it("collects credentials for a non-oauth auth", () => {
    expect(usesAuthorizationFlow({ type: "api_key" })).toBe(false);
  });
});

describe("connectSubmitBody", () => {
  it("sends the credentials and the trimmed declared variables for a non-oauth auth", () => {
    expect(
      connectSubmitBody({
        authorizationFlow: false,
        credentials: { api_key: "tok" },
        variableNames: VARS,
        variableValues: { base_url: "  https://coolify.example.com ", stale: "x" },
      }),
    ).toEqual({
      credentials: { api_key: "tok" },
      variables: { base_url: "https://coolify.example.com" },
    });
  });

  it("sends the variables alone for an oauth2 auth", () => {
    expect(
      connectSubmitBody({
        authorizationFlow: true,
        credentials: {},
        variableNames: VARS,
        variableValues: { base_url: "https://gitlab.com" },
      }),
    ).toEqual({ variables: { base_url: "https://gitlab.com" } });
  });

  it("sends no variables member for an integration that declares none", () => {
    expect(
      connectSubmitBody({
        authorizationFlow: false,
        credentials: { username: "u", password: "p" },
        variableNames: null,
        variableValues: {},
      }),
    ).toEqual({ credentials: { username: "u", password: "p" } });
  });
});

describe("missingVariables", () => {
  it("names every variable left empty or blank", () => {
    expect(missingVariables(["a", "b", "c"], { a: "x", b: "  " })).toEqual(["b", "c"]);
  });
});

describe("submitHostedConnect", () => {
  it("oauth2: navigates to the authorization server and stores nothing", async () => {
    const sent: unknown[] = [];
    const visited: string[] = [];
    const outcome = await submitHostedConnect(
      {
        authorizationFlow: true,
        credentials: {},
        variableNames: VARS,
        variableValues: { base_url: "https://git.example.com" },
      },
      {
        post: async (body) => {
          sent.push(body);
          return { ok: true, redirect_url: "https://git.example.com/oauth/authorize?state=s" };
        },
        navigate: (url) => visited.push(url),
      },
    );
    expect(sent).toEqual([{ variables: { base_url: "https://git.example.com" } }]);
    expect(visited).toEqual(["https://git.example.com/oauth/authorize?state=s"]);
    expect(outcome).toEqual({ kind: "redirected" });
  });

  it("oauth2: refuses an answer without a redirect, without navigating", async () => {
    const visited: string[] = [];
    await expect(
      submitHostedConnect(
        { authorizationFlow: true, credentials: {}, variableNames: VARS, variableValues: {} },
        { post: async () => ({ ok: true }), navigate: (url) => visited.push(url) },
      ),
    ).rejects.toThrow();
    expect(visited).toEqual([]);
  });

  it("non-oauth: the connection is stored, with its minted steps", async () => {
    const visited: string[] = [];
    const outcome = await submitHostedConnect(
      {
        authorizationFlow: false,
        credentials: { api_key: "tok" },
        variableNames: null,
        variableValues: {},
      },
      { post: async () => ({ ok: true }), navigate: (url) => visited.push(url) },
    );
    expect(outcome).toEqual({ kind: "stored", handoffSteps: [] });
    expect(visited).toEqual([]);
  });
});

/** A problem body as the client receives it, turned into the error the SPA handles. */
function problem(body: Record<string, unknown>): Promise<Error> {
  return toApiError(
    new Response(JSON.stringify(body), {
      status: 400,
      headers: { "content-type": "application/problem+json" },
    }),
  );
}

describe("variableFieldErrors", () => {
  const LABELS = { base_url: "URL de l'instance" };

  it("puts each variables.<name> refusal beside its input, named by its label", async () => {
    const err = await problem({
      code: "validation_failed",
      detail:
        "variables.base_url: renders https://10.0.0.1/mcp, which this platform does not reach",
      errors: [
        {
          field: "variables.base_url",
          code: "egress_blocked",
          message: "renders https://10.0.0.1/mcp, which this platform does not reach",
        },
        { field: "variables.base_url", code: "unrenderable_variable", message: "second" },
      ],
    });
    const { byName, complete } = variableFieldErrors(err, LABELS);
    expect(complete).toBe(true);
    // First refusal per variable.
    expect(byName).toEqual({
      base_url:
        "Champ « URL de l'instance » : cette plateforme ne joint pas l'adresse obtenue (renders https://10.0.0.1/mcp, which this platform does not reach)",
    });
  });

  it("leaves a refusal about anything else to the form", async () => {
    const err = await problem({
      code: "validation_failed",
      detail: "credentials.api_key: Required (+1 more)",
      errors: [
        { field: "credentials.api_key", code: "required", message: "Required" },
        {
          field: "variables.base_url",
          code: "invalid_variable",
          message: 'must match "^https?://"',
        },
      ],
    });
    const { byName, complete } = variableFieldErrors(err, LABELS);
    expect(complete).toBe(false);
    expect(byName).toEqual({
      base_url: 'Champ « URL de l\'instance » : valeur invalide (must match "^https?://")',
    });
  });

  it("maps nothing from a refusal that is not a validation failure", async () => {
    const err = await problem({ code: "forbidden", status: 403, detail: "no" });
    expect(variableFieldErrors(err, LABELS)).toEqual({ byName: {}, complete: false });
    expect(variableFieldErrors(new Error("offline"), LABELS)).toEqual({
      byName: {},
      complete: false,
    });
  });
});

describe("hostedConnectErrorMessage", () => {
  const upstream = (extensions: Record<string, unknown>) =>
    toApiError(
      new Response(
        JSON.stringify({
          status: 502,
          code: "login_upstream_unavailable",
          detail: "The service could not complete the login. Try again later.",
          ...extensions,
        }),
        { status: 502, headers: { "content-type": "application/problem+json" } },
      ),
    );

  it("adds that the grant may be spent when the server flags it", async () => {
    expect(hostedConnectErrorMessage(await upstream({ grant_may_be_redeemed: true }))).toBe(
      "Le service n'a pas pu terminer la connexion. Réessayez plus tard. " +
        "Le service a peut-être déjà consommé ce jeton : si une nouvelle tentative est refusée, obtenez-en un nouveau.",
    );
  });

  it("says only the refusal otherwise", async () => {
    expect(hostedConnectErrorMessage(await upstream({}))).toBe(
      "Le service n'a pas pu terminer la connexion. Réessayez plus tard.",
    );
  });
});

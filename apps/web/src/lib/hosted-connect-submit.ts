// SPDX-License-Identifier: Apache-2.0

// `POST /api/integrations/connect/submit`. An oauth2 auth reaches the form for connection variables, or
// for the grant its `connect.login` submits.

import { acquiresByConnectLogin } from "@appstrate/core/integration";
import i18n from "../i18n";
import type { paths } from "../api/client";
import { ApiError } from "../api/errors";
import type { HandoffStep } from "../components/integration-connect/handoff-steps";
import { errorMessage, refusalMessage, validationFieldErrors } from "./mutation-error";

type SubmitPath = paths["/api/integrations/connect/submit"]["post"];
type ConnectSubmitBody = SubmitPath["requestBody"]["content"]["application/json"];
type ConnectSubmitResponse = SubmitPath["responses"][200]["content"]["application/json"];

interface HostedConnectInput {
  /** The auth connects through an authorization server (oauth2, not acquired by connect.login). */
  authorizationFlow: boolean;
  credentials: Record<string, string>;
  variableNames: string[] | null;
  variableValues: Record<string, string>;
}

/** oauth2 redirects to its authorization server, unless acquired by connect.login: that grant is a credential. */
export function usesAuthorizationFlow(auth: { type?: unknown; connect?: unknown }): boolean {
  return auth.type === "oauth2" && !acquiresByConnectLogin(auth);
}

/** Credentials unless an authorization flow (which refuses them); one trimmed value per declared variable. */
export function connectSubmitBody(input: HostedConnectInput): ConnectSubmitBody {
  const body: ConnectSubmitBody = {};
  if (!input.authorizationFlow) body.credentials = input.credentials;
  if (input.variableNames) {
    body.variables = Object.fromEntries(
      input.variableNames.map((name) => [name, (input.variableValues[name] ?? "").trim()]),
    );
  }
  return body;
}

/** The declared variables left empty — every one is required (§7.12). */
export function missingVariables(names: string[], values: Record<string, string>): string[] {
  return names.filter((name) => (values[name] ?? "").trim() === "");
}

type HostedConnectOutcome =
  { kind: "redirected" } | { kind: "stored"; handoffSteps: HandoffStep[] };

/** oauth2 navigates to `redirect_url`: nothing is stored yet, so no completion is announced. */
export async function submitHostedConnect(
  input: HostedConnectInput,
  deps: {
    post: (body: ConnectSubmitBody) => Promise<ConnectSubmitResponse | undefined>;
    navigate: (url: string) => void;
  },
): Promise<HostedConnectOutcome> {
  const data = await deps.post(connectSubmitBody(input));
  if (input.authorizationFlow) {
    // An empty message renders the generic sentence, not an English one.
    if (!data?.redirect_url) throw new Error("");
    deps.navigate(data.redirect_url);
    return { kind: "redirected" };
  }
  return { kind: "stored", handoffSteps: data?.handoff_steps ?? [] };
}

/** First refusal per `variables.<name>`; `complete` when every item landed beside an input, so the form needs no message of its own. */
export function variableFieldErrors(
  err: unknown,
  labels: Readonly<Record<string, string>>,
): { byName: Record<string, string>; complete: boolean } {
  const items = validationFieldErrors(err);
  const byName: Record<string, string> = {};
  let complete = items.length > 0;
  for (const item of items) {
    const name = item.field?.startsWith("variables.")
      ? item.field.slice("variables.".length)
      : undefined;
    const label = name === undefined ? undefined : labels[name];
    if (name === undefined || label === undefined) {
      complete = false;
      continue;
    }
    if (byName[name] !== undefined) continue;
    const sentence = refusalMessage({ code: item.code, field: label, message: item.message });
    if (sentence === null && !item.message) {
      complete = false;
      continue;
    }
    byName[name] = sentence ?? item.message!;
  }
  return { byName, complete };
}

/**
 * What the form says on a failure: the translated refusal, and — when the server flags
 * `grant_may_be_redeemed` (an oauth2 `connect.login` whose token request may have spent the
 * grant) — that the submitted token may need replacing, which no translation of the code says.
 */
export function hostedConnectErrorMessage(err: unknown): string {
  const message = errorMessage(err);
  if (!(err instanceof ApiError) || err.details?.grant_may_be_redeemed !== true) return message;
  return `${message} ${i18n.t("integration.connect.hosted.grantMayBeRedeemed", { ns: "settings" })}`;
}

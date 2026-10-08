// SPDX-License-Identifier: Apache-2.0

/**
 * The hosted connect form's submission (`POST /api/integrations/connect/submit`),
 * kept out of the page so the body it sends and what it does with the answer
 * are testable without a DOM: the caller supplies the request and the
 * navigation.
 *
 * Two shapes of the same form. A non-oauth auth submits its credentials (plus
 * the connection variables the integration declares) and the connection is
 * stored. An oauth2 auth reaches this form only when the integration declares
 * variables (AFPS §7.12): it submits the variables alone, and the server answers
 * with the authorization server's URL — the window goes there, and the OAuth
 * callback creates the connection.
 */

import type { paths } from "../api/client";
import type { HandoffStep } from "../components/integration-connect/handoff-steps";
import { refusalMessage, validationFieldErrors } from "./mutation-error";

type SubmitPath = paths["/api/integrations/connect/submit"]["post"];
type ConnectSubmitBody = SubmitPath["requestBody"]["content"]["application/json"];
type ConnectSubmitResponse = SubmitPath["responses"][200]["content"]["application/json"];

interface HostedConnectInput {
  authType: string;
  credentials: Record<string, string>;
  /** The declared variable names, `null` when the integration declares none. */
  variableNames: string[] | null;
  variableValues: Record<string, string>;
}

/**
 * The request body: credentials for a non-oauth auth only (the server refuses
 * them on oauth2), and one trimmed value per declared variable — never a name
 * the manifest does not declare, never a `variables` member when it declares none.
 */
export function connectSubmitBody(input: HostedConnectInput): ConnectSubmitBody {
  const body: ConnectSubmitBody = {};
  if (input.authType !== "oauth2") body.credentials = input.credentials;
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

/**
 * Submit the form. oauth2: navigate to the returned `redirect_url` and report
 * `redirected` — nothing is stored yet, so no completion is announced here.
 * Otherwise the connection is stored; its minted-credential steps, if any, are
 * returned. A refusal propagates (`ApiError`).
 */
export async function submitHostedConnect(
  input: HostedConnectInput,
  deps: {
    post: (body: ConnectSubmitBody) => Promise<ConnectSubmitResponse | undefined>;
    navigate: (url: string) => void;
  },
): Promise<HostedConnectOutcome> {
  const data = await deps.post(connectSubmitBody(input));
  if (input.authType === "oauth2") {
    // The contract always carries it for oauth2; an empty message renders the
    // generic sentence rather than an English one.
    if (!data?.redirect_url) throw new Error("");
    deps.navigate(data.redirect_url);
    return { kind: "redirected" };
  }
  return { kind: "stored", handoffSteps: data?.handoff_steps ?? [] };
}

/**
 * Split a refusal between the variable inputs and the form: each
 * `variables.<name>` item of a `validation_failed` becomes a sentence naming the
 * variable by its label (first refusal per variable). `complete` is true when
 * every item landed beside a field, so the form needs no message of its own.
 */
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

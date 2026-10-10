// SPDX-License-Identifier: Apache-2.0

/**
 * The hosted connect form's submission (`POST /api/integrations/connect/submit`). An oauth2 auth
 * reaches the form only to enter connection variables; it is sent on to the authorization server.
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

/** Credentials unless oauth2 (which refuses them); one trimmed value per declared variable. */
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

/** oauth2 navigates to `redirect_url`: nothing is stored yet, so no completion is announced. */
export async function submitHostedConnect(
  input: HostedConnectInput,
  deps: {
    post: (body: ConnectSubmitBody) => Promise<ConnectSubmitResponse | undefined>;
    navigate: (url: string) => void;
  },
): Promise<HostedConnectOutcome> {
  const data = await deps.post(connectSubmitBody(input));
  if (input.authType === "oauth2") {
    // An empty message renders the generic sentence, not an English one.
    if (!data?.redirect_url) throw new Error("");
    deps.navigate(data.redirect_url);
    return { kind: "redirected" };
  }
  return { kind: "stored", handoffSteps: data?.handoff_steps ?? [] };
}

/**
 * Each `variables.<name>` refusal item as a sentence beside its input (first per variable);
 * `complete` when every item landed beside one, so the form needs no message of its own.
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

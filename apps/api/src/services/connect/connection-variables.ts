// SPDX-License-Identifier: Apache-2.0

/**
 * Connection variables at connection creation and reconnect (AFPS §7.12): the non-secret values a
 * user submits to choose a connection's upstream (`{$variable.<name>}`). Every acquisition door
 * goes through {@link resolveConnectionVariables} before anything is sent upstream or stored, and
 * the values it returns are persisted in the same write as the credential.
 */

import {
  isVariableTemplate,
  renderUrlTemplate,
  unrenderableUrlTemplateVariables,
  variableRefs,
} from "@appstrate/afps-shared/connection-variables";
import { unrenderableAuthorizedUriFields } from "@appstrate/afps-shared/credential-template";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { ValidationFieldError } from "@appstrate/core/api-errors";
import { validationFailed } from "../../lib/errors.ts";
import { checkEgressUrl } from "../../lib/egress-host-guard.ts";
import { validateConnectionCredentials } from "../schema.ts";
import {
  getRemoteSource,
  getVariablesSchema,
  type AfpsManifestAuth,
  type AfpsManifestConnect,
} from "../integration-manifest-helpers.ts";

export type ConnectionVariables = Record<string, string>;

const TITLE = "Invalid Connection Variable";

const EXPECTED_URL =
  "an absolute https:// URL without userinfo, query string, fragment or '*' (http:// only for a host the operator trusts)";
const EXPECTED_HOST =
  "a host name: '.'-separated labels of 1 to 63 letters, digits and '-', none starting or ending with '-'";

/**
 * The URL templates choosing the upstream of a connection made with `auth`: the integration's
 * `source.remote.url`, the auth's oauth2 `issuer`, its `connect.login.request.url` — those that
 * reference a variable.
 */
export function authUrlTemplates(
  manifest: IntegrationManifest,
  auth: Pick<AfpsManifestAuth, "type" | "issuer" | "connect">,
): string[] {
  const loginUrl = (auth.connect as AfpsManifestConnect | undefined)?.login?.request?.url;
  return [
    getRemoteSource(manifest)?.url,
    auth.type === "oauth2" ? auth.issuer : undefined,
    loginUrl,
  ].filter(isVariableTemplate);
}

/** Injectable for tests: the egress decision for a rendered URL (DNS-resolving by default). */
export interface ConnectionVariablesDeps {
  isEgressAllowed: (url: string) => Promise<boolean>;
}

const defaultDeps: ConnectionVariablesDeps = {
  isEgressAllowed: async (url) =>
    (await checkEgressUrl(url, { requireHttpsForUntrustedHost: true })).ok,
};

/**
 * Validate the variables submitted for a connection of `auth` and return the values to persist —
 * `null` when the integration declares none. Refuses (400 `validation_failed`, one entry per
 * `variables.<name>`): variables submitted to an integration that declares none, an undeclared
 * name, a value its schema refuses or a missing one, a value leaving a URL template unrenderable,
 * a rendered URL the platform's egress controls refuse (§8.6/§8.7: a user-chosen host earns no
 * author trust), and a value leaving an `authorized_uris` entry of the auth unrenderable. Never
 * echoes a value.
 */
export async function resolveConnectionVariables(
  manifest: IntegrationManifest,
  auth: AfpsManifestAuth,
  submitted: Readonly<Record<string, string>> | undefined,
  deps: ConnectionVariablesDeps = defaultDeps,
): Promise<ConnectionVariables | null> {
  const schema = getVariablesSchema(manifest);
  if (!schema) {
    if (submitted === undefined) return null;
    throw validationFailed([
      {
        field: "variables",
        code: "variables_not_declared",
        title: TITLE,
        message: "must be absent: this integration declares no connection variables",
      },
    ]);
  }
  const values: ConnectionVariables = { ...submitted };
  const declared = new Set(Object.keys(schema.properties ?? {}));
  const errors: ValidationFieldError[] = Object.keys(values)
    .filter((name) => !declared.has(name))
    .map((name) => ({
      field: `variables.${name}`,
      code: "unknown_variable",
      title: TITLE,
      message: "is not a variable this integration declares",
    }));
  const verdict = validateConnectionCredentials(schema, values);
  if (!verdict.valid) {
    for (const { field, message } of verdict.errors) {
      errors.push({ field: `variables.${field}`, code: "invalid_variable", title: TITLE, message });
    }
  }
  if (errors.length > 0) throw validationFailed(errors);

  for (const template of authUrlTemplates(manifest, auth)) {
    const [blamed] = unrenderableUrlTemplateVariables(template, values);
    if (blamed !== undefined) {
      errors.push({
        field: `variables.${blamed}`,
        code: "unrenderable_variable",
        title: TITLE,
        message: `must be ${template.startsWith("{$variable.") ? EXPECTED_URL : EXPECTED_HOST}`,
      });
      continue;
    }
    const url = renderUrlTemplate(template, values)!;
    if (!(await deps.isEgressAllowed(url))) {
      errors.push({
        field: `variables.${variableRefs(template)[0]}`,
        code: "egress_blocked",
        title: TITLE,
        message: `renders ${url}, which this platform does not reach`,
      });
    }
  }
  for (const { root, field, expected } of unrenderableAuthorizedUriFields(
    auth.authorized_uris ?? [],
    {},
    values,
  )) {
    if (root !== "variable") continue;
    errors.push({
      field: `variables.${field}`,
      code: "unrenderable_variable",
      title: TITLE,
      message: `must be ${expected}`,
    });
  }
  if (errors.length > 0) throw validationFailed(dedupeByField(errors));
  return values;
}

function dedupeByField(errors: ValidationFieldError[]): ValidationFieldError[] {
  const seen = new Set<string>();
  return errors.filter((e) => {
    const key = `${e.field}:${e.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

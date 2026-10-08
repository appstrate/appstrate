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
} from "../integration-manifest-helpers.ts";

/** A connection's variables (AFPS §7.12) as the run-time renderers substitute them. */
export type ConnectionVariables = Readonly<Record<string, string>>;

const TITLE = "Invalid Connection Variable";

/** The URL templates choosing the upstream of a connection made with `auth`. */
function authUrlTemplates(
  manifest: IntegrationManifest,
  auth: Pick<AfpsManifestAuth, "type" | "issuer">,
): string[] {
  return [getRemoteSource(manifest)?.url, auth.type === "oauth2" ? auth.issuer : undefined].filter(
    isVariableTemplate,
  );
}

/** Egress decision for a user-chosen URL (§8.7: no author trust); DNS-resolving. */
export async function isUserUrlReachable(url: string): Promise<boolean> {
  return (await checkEgressUrl(url, { requireHttpsForUntrustedHost: true })).ok;
}

/** Injectable for tests: the egress decision for a rendered URL. */
export interface ConnectionVariablesDeps {
  isEgressAllowed: (url: string) => Promise<boolean>;
}

const defaultDeps: ConnectionVariablesDeps = { isEgressAllowed: isUserUrlReachable };

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
  const values: Record<string, string> = { ...submitted };
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
        field: `variables.${blamed.name}`,
        code: "unrenderable_variable",
        title: TITLE,
        message: `must be ${blamed.expected}`,
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

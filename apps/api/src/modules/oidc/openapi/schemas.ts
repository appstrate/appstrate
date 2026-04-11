// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI component schemas for the OIDC module.
 *
 * Derived from the Zod schemas in `../services/oauth-admin.ts` so the
 * shape is defined exactly once — the backend services, the OpenAPI
 * spec, and (transitively, via type inference) the frontend hooks all
 * read from the same single source of truth.
 */

import { z } from "zod";
import { oauthClientSchema, oauthClientWithSecretSchema } from "../services/oauth-admin.ts";

export const oidcSchemas = {
  OAuthClientObject: z.toJSONSchema(oauthClientSchema) as Record<string, unknown>,
  OAuthClientWithSecret: z.toJSONSchema(oauthClientWithSecretSchema) as Record<string, unknown>,
};

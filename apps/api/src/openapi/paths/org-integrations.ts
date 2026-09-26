// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS } from "../headers.ts";
import {
  authKeyParam,
  clientIdParam,
  integrationClientsListSchema,
  oauthClientCreateBodySchema,
  oauthClientSchema,
  oauthClientUpdateBodySchema,
  setDefaultClientBodySchema,
} from "./integrations.ts";

/**
 * Org-level integration OAuth clients (org context, no `X-Space-Id`). An org
 * client is inherited by every space of the org; a space's own client
 * (`/api/integrations/...`) overrides it.
 */

const PERMISSION_NOTE =
  "Requires `org-integrations:configure`, which is never granted to an API key.";

const packageParams = [
  { $ref: "#/components/parameters/XOrgId" },
  { $ref: "#/components/parameters/PackageScope" },
  { $ref: "#/components/parameters/PackageName" },
] as const;

const jsonBody = (schema: object) => ({
  required: true,
  content: { "application/json": { schema } },
});

export const orgIntegrationsPaths = {
  "/api/org-integrations/{scope}/{name}/auths/{authKey}/clients": {
    get: {
      operationId: "listOrgIntegrationClients",
      tags: ["Integrations"],
      summary: "List the org-level OAuth clients of an integration auth",
      description:
        "Returns the org's own clients (`org`, oldest first) plus the default it " +
        "inherits, the platform-provided system client (`built-in`), if any. " +
        "`is_default` marks the org-tier default. Secrets are never returned. Only oauth2 auths " +
        "whose client is not auto-provisioned (DCR/CIMD) have an org tier; " +
        `any other auth is a 400. ${PERMISSION_NOTE}`,
      parameters: [...packageParams, authKeyParam],
      responses: {
        "200": {
          description: "Org-level and system OAuth clients",
          headers: STD_RESPONSE_HEADERS,
          content: { "application/json": { schema: integrationClientsListSchema } },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/org-integrations/{scope}/{name}/auths/{authKey}/default-client": {
    put: {
      operationId: "setOrgDefaultIntegrationClient",
      tags: ["Integrations"],
      summary: "Set the org-level default OAuth client of an integration auth",
      description:
        "Selecting an org client flags it default for every space that has not " +
        "flagged one of its own; selecting the system client un-flags the org's " +
        "clients. Any other `client_ref` is a 400. Returns the refreshed org clients list. " +
        PERMISSION_NOTE,
      parameters: [...packageParams, authKeyParam],
      requestBody: jsonBody(setDefaultClientBodySchema),
      responses: {
        "200": {
          description: "Default set; org-level and system OAuth clients (re-badged)",
          headers: STD_RESPONSE_HEADERS,
          content: { "application/json": { schema: integrationClientsListSchema } },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/org-integrations/{scope}/{name}/auths/{authKey}/oauth-clients": {
    post: {
      operationId: "createOrgIntegrationOAuthClient",
      tags: ["Integrations"],
      summary: "Register an org-level OAuth client for an integration auth",
      description:
        "Registers a custom (BYO-app) client at the org level (`spaceId: null`), " +
        "inherited by every space of the org. The first one becomes the org " +
        "default. Rejected (400) for auto-provisioned (DCR/CIMD) auths, whose " +
        `clients are per space. ${PERMISSION_NOTE}`,
      parameters: [...packageParams, authKeyParam],
      requestBody: jsonBody(oauthClientCreateBodySchema),
      responses: {
        "201": {
          description: "Created",
          headers: STD_RESPONSE_HEADERS,
          content: { "application/json": { schema: oauthClientSchema } },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/org-integrations/{scope}/{name}/oauth-clients/{clientId}": {
    put: {
      operationId: "rotateOrgIntegrationOAuthClient",
      tags: ["Integrations"],
      summary: "Rotate an org-level OAuth client's credentials",
      description: `Rotates one org-level client in place, by its id (a space client id is a 404 here). ${PERMISSION_NOTE}`,
      parameters: [...packageParams, clientIdParam],
      requestBody: jsonBody(oauthClientUpdateBodySchema),
      responses: {
        "200": {
          description: "Rotated",
          headers: STD_RESPONSE_HEADERS,
          content: { "application/json": { schema: oauthClientSchema } },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteOrgIntegrationOAuthClient",
      tags: ["Integrations"],
      summary: "Delete an org-level OAuth client",
      description:
        "Deletes one org-level client by id (a space client id is a 404 here), " +
        "with every connection it minted in any space of the org. " +
        PERMISSION_NOTE,
      parameters: [...packageParams, clientIdParam],
      responses: {
        "204": { description: "OAuth client deleted", headers: STD_RESPONSE_HEADERS },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;

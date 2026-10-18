// SPDX-License-Identifier: Apache-2.0

import { REQUEST_ID_ONLY_HEADERS } from "../headers.ts";

const documentSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "client_id",
    "client_name",
    "client_uri",
    "redirect_uris",
    "grant_types",
    "response_types",
    "token_endpoint_auth_method",
  ],
  properties: {
    client_id: {
      type: "string",
      format: "uri",
      description: "The URL this document is served at, exactly (the draft requires equality).",
    },
    client_name: { type: "string", description: "`Appstrate (<APP_URL host>)`." },
    client_uri: { type: "string", format: "uri", description: "This instance's `APP_URL`." },
    redirect_uris: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: { type: "string", format: "uri" },
      description:
        "The one redirect URI the connect flow sends with this `client_id`: the server's own `<APP_URL>/api/integrations/callback/<tag>` — never the shared callback, so a response from another server cannot land on it (mix-up, RFC 9700 §4.4).",
    },
    grant_types: {
      type: "array",
      items: { type: "string", enum: ["authorization_code", "refresh_token"] },
    },
    response_types: { type: "array", items: { type: "string", enum: ["code"] } },
    token_endpoint_auth_method: {
      type: "string",
      enum: ["none"],
      description: "A public client (PKCE): no secret, no key.",
    },
  },
} as const;

const documentResponse = (description: string) => ({
  description,
  headers: {
    ...REQUEST_ID_ONLY_HEADERS,
    "Cache-Control": {
      description: "`public, max-age=300` — an authorization server may cache the document.",
      schema: { type: "string" },
    },
  },
  content: {
    "application/json": {
      schema: documentSchema,
      example: {
        client_id:
          "https://app.example.com/oauth/client-metadata/aHR0cHM6Ly9tY3Aubm90aW9uLmNvbQ.json",
        client_name: "Appstrate (app.example.com)",
        client_uri: "https://app.example.com",
        redirect_uris: ["https://app.example.com/api/integrations/callback/ZUGRhbwa83_JyNgKjMOax-"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    },
  },
});

export const oauthClientMetadataPaths = {
  "/oauth/client-metadata/{document}": {
    get: {
      operationId: "getOAuthClientMetadataDocument",
      tags: ["Integrations"],
      summary: "OAuth client metadata document",
      description:
        "Public. This instance's OAuth Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document) for one authorization server: its URL is the `client_id` an auto-provisioned integration auth (remote MCP, or a server chosen per connection — `token_endpoint_auth_method: none`) presents to a server whose validated metadata advertises `client_id_metadata_document_supported` and RFC 9207 `authorization_response_iss_parameter_supported` (the `iss` check is what refuses a response another server returns on this redirect URI), which fetches it — the client registration MCP 2026-07-28 prefers to dynamic registration (RFC 7591), the fallback otherwise. `document` is `<base64url(issuer)>.json`, and the document names that server's own redirect URI (`/api/integrations/callback/<tag>`), so each server is given a `client_id` and a redirect URI of its own (RFC 9700 §4.4). Presented only when `APP_URL` is `https` on a public host and `INTEGRATION_OAUTH_CIMD` is not `off`; otherwise connect registers by DCR. Computed from `APP_URL` and the issuer, nothing stored.",
      security: [],
      parameters: [
        {
          name: "document",
          in: "path",
          required: true,
          description:
            "`<base64url(issuer)>.json`, the issuer in its canonical encoding: an `https` URL, or `http` for a host listed in `EGRESS_ALLOW_INTERNAL_HOSTS`.",
          schema: { type: "string", maxLength: 2048, pattern: "^[A-Za-z0-9_-]+\\.json$" },
        },
      ],
      responses: {
        "200": documentResponse("The client metadata document"),
        "404": {
          description:
            "`document` encodes no admissible issuer (not an `https` URL — or `http` on an allowlisted host —, not in its canonical encoding, or longer than 2048 characters)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
} as const;

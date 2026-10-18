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
        "The one redirect URI the connect flow sends with this `client_id`: `<APP_URL>/api/integrations/callback`, or its per-server twin `<APP_URL>/api/integrations/callback/<tag>` for a document of a server chosen per connection.",
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
        client_id: "https://app.example.com/oauth/client-metadata.json",
        client_name: "Appstrate (app.example.com)",
        client_uri: "https://app.example.com",
        redirect_uris: ["https://app.example.com/api/integrations/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    },
  },
});

export const oauthClientMetadataPaths = {
  "/oauth/client-metadata.json": {
    get: {
      operationId: "getOAuthClientMetadataDocument",
      tags: ["Integrations"],
      summary: "OAuth client metadata document",
      description:
        "Public. This instance's OAuth Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document): its URL is the `client_id` an auto-provisioned integration auth (remote MCP, `token_endpoint_auth_method: none`) presents to an authorization server advertising `client_id_metadata_document_supported`, which fetches it — the client registration MCP 2026-07-28 prefers to dynamic registration (RFC 7591), the fallback otherwise. Used only when `APP_URL` is `https` on a public host; a tier-0/localhost instance registers by DCR. Computed from `APP_URL`, nothing stored.",
      security: [],
      responses: { "200": documentResponse("The client metadata document") },
    },
  },
  "/oauth/client-metadata/{document}": {
    get: {
      operationId: "getOAuthServerClientMetadataDocument",
      tags: ["Integrations"],
      summary: "OAuth client metadata document of a server chosen per connection",
      description:
        "Public. The Client ID Metadata Document presented to an authorization server chosen per connection (AFPS §7.3): `document` is `<base64url(issuer)>.json`, and the document names that server's own redirect URI (`/api/integrations/callback/<tag>`), so each server is given a redirect URI of its own (RFC 9700 §4.4). Computed from `APP_URL` and the issuer, nothing stored.",
      security: [],
      parameters: [
        {
          name: "document",
          in: "path",
          required: true,
          description: "`<base64url(issuer)>.json`, the issuer in its canonical encoding.",
          schema: { type: "string", pattern: "^[A-Za-z0-9_-]+\\.json$" },
        },
      ],
      responses: {
        "200": documentResponse("The client metadata document"),
        "404": {
          description: "`document` encodes no issuer URL (or not in its canonical encoding)",
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

// SPDX-License-Identifier: Apache-2.0

/**
 * This instance's OAuth Client ID Metadata Documents (`lib/integration-client-metadata.ts`),
 * fetched by the authorization servers of the integrations it connects — one per server, named by
 * its issuer. Public — outside `/api/`, so the auth pipeline skips it — and stateless: each
 * document is computed from `APP_URL` and the issuer its name encodes. Short public caching: a
 * server may cache it (MCP 2026-07-28), and a changed `APP_URL` must reach it soon after.
 */

import { Hono } from "hono";
import { notFound } from "../lib/errors.ts";
import {
  clientMetadataDocument,
  issuerOfClientMetadataDocument,
  type ClientMetadataDocument,
} from "../lib/integration-client-metadata.ts";

const CACHE_CONTROL = "public, max-age=300";

export function createOAuthClientMetadataRouter() {
  const router = new Hono();
  const serve = (document: ClientMetadataDocument) =>
    new Response(JSON.stringify(document), {
      headers: { "Content-Type": "application/json", "Cache-Control": CACHE_CONTROL },
    });

  router.get("/client-metadata/:document", (c) => {
    const issuer = issuerOfClientMetadataDocument(c.req.param("document"));
    if (issuer === undefined) throw notFound("Client metadata document not found");
    return serve(clientMetadataDocument(issuer));
  });
  return router;
}

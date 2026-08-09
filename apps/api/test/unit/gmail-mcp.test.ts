// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { integrationManifestSchema, missingScopesForConnection } from "@appstrate/core/integration";

const SYSTEM_PACKAGES = join(import.meta.dir, "../../../../scripts/system-packages");

async function readLatestGmailManifest() {
  const sourceDir = (await readdir(SYSTEM_PACKAGES))
    .filter((entry) => entry.startsWith("integration-gmail-mcp-"))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .at(-1);

  if (!sourceDir) throw new Error("no integration-gmail-mcp-* source directory found");

  return integrationManifestSchema.parse(
    await Bun.file(join(SYSTEM_PACKAGES, sourceDir, "manifest.json")).json(),
  );
}

describe("@appstrate/gmail-mcp OAuth scopes", () => {
  it("accepts Google's canonical userinfo.email grant as the OIDC email scope", async () => {
    const manifest = await readLatestGmailManifest();

    expect(
      missingScopesForConnection({
        manifest,
        authKey: "primary",
        granted: [
          "openid",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.modify",
        ],
        agentTools: [
          "list_labels",
          "search_threads",
          "get_thread",
          "get_message",
          "label_thread",
          "unlabel_thread",
        ],
        agentScopes: [
          "openid",
          "email",
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.modify",
        ],
      }),
    ).toEqual([]);
  });
});

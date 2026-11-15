// SPDX-License-Identifier: Apache-2.0

/**
 * MCP Bundle (`.mcpb`) import and export — AFPS §7.1.1.
 *
 * IMPORT: a raw `.mcpb` becomes a local integration (`@<org slug>/<mcpb name>`) with its payload
 * kept verbatim; the normal write-path rules judge the result. EXPORT: a published local
 * integration comes out as a strict MCPB bundle; what has no faithful form is a 422.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync, unzipSync } from "fflate";
import Ajv from "ajv";
import mcpbV03 from "../../../../../packages/core/test/fixtures/mcpb/mcpb-manifest-v0.3.schema.json";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import {
  localIntegrationManifest,
  remoteIntegrationManifest,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat("email", true);
ajv.addFormat("uri", true);
const validateMcpb = ajv.compile(mcpbV03);

const dec = new TextDecoder();
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const SERVER = "// payload\nconsole.log('mcp');\n";

function mcpbManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifest_version: "0.3",
    name: "Fetch JSON",
    display_name: "Fetch JSON",
    version: "1.2.0",
    description: "Fetches JSON documents",
    author: { name: "Example" },
    server: {
      type: "node",
      entry_point: "server/index.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/index.js"],
        env: { API_KEY: "${user_config.api_key}", LOG_LEVEL: "info" },
      },
    },
    tools: [{ name: "fetch_json", description: "Fetch a JSON document" }],
    user_config: {
      api_key: {
        type: "string",
        title: "API key",
        description: "Upstream key",
        sensitive: true,
        required: true,
      },
    },
    ...overrides,
  };
}

function zip(manifest: Record<string, unknown>, files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = { "manifest.json": enc(JSON.stringify(manifest)) };
  for (const [path, text] of Object.entries(files)) entries[path] = enc(text);
  return zipSync(entries as unknown as Parameters<typeof zipSync>[0]);
}

describe("MCPB import and export", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "mcpborg" });
  });

  async function importFile(
    bytes: Uint8Array,
    name = "fetch.mcpb",
    as: TestContext = ctx,
  ): Promise<Response> {
    const form = new FormData();
    form.append("file", new Blob([bytes]), name);
    return await app.request("/api/packages/import", {
      method: "POST",
      body: form,
      headers: authHeaders(as),
    });
  }

  async function exportMcpb(id: string, query = "", as: TestContext = ctx): Promise<Response> {
    return await app.request(`/api/packages/integrations/${id}/mcpb${query}`, {
      headers: authHeaders(as),
    });
  }

  async function readIntegration(id: string): Promise<Record<string, any>> {
    const res = await app.request(`/api/packages/integrations/${id}`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { manifest: Record<string, any> };
    return body.manifest;
  }

  it("imports a sensitive user_config as a custom auth, keeping the payload and the tools", async () => {
    const res = await importFile(zip(mcpbManifest(), { "server/index.js": SERVER }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { packageId: string; type: string; version: string };
    expect(body).toMatchObject({
      packageId: "@mcpborg/fetch-json",
      type: "integration",
      version: "1.2.0",
    });

    const manifest = await readIntegration(body.packageId);
    expect(manifest.source.kind).toBe("local");
    expect(manifest.source.server.entry_point).toBe("server/index.js");
    expect(manifest.source.server.tools).toEqual([
      { name: "fetch_json", description: "Fetch a JSON document" },
    ]);
    expect(Object.values(manifest.auths as Record<string, any>)[0].type).toBe("custom");

    const files = await app.request(`/api/packages/${body.packageId}/1.2.0/download`, {
      headers: authHeaders(ctx),
    });
    expect(files.status).toBe(200);
    const entries = unzipSync(new Uint8Array(await files.arrayBuffer()));
    expect(dec.decode(entries["server/index.js"])).toBe(SERVER);
  });

  it("imports a bundle without a sensitive setting as an integration with no auth", async () => {
    const res = await importFile(
      zip(
        mcpbManifest({
          name: "plain-tool",
          user_config: undefined,
          server: {
            type: "node",
            entry_point: "server/index.js",
            mcp_config: { command: "node", args: ["${__dirname}/server/index.js"] },
          },
        }),
        { "server/index.js": SERVER },
      ),
    );
    expect(res.status).toBe(201);
    const { packageId } = (await res.json()) as { packageId: string };
    const manifest = await readIntegration(packageId);
    expect(Object.keys(manifest.auths ?? {})).toEqual([]);
  });

  it("refuses a non-sensitive user_config without a default", async () => {
    const res = await importFile(
      zip(
        mcpbManifest({
          user_config: {
            region: { type: "string", title: "Region", description: "Where", required: true },
          },
        }),
        { "server/index.js": SERVER },
      ),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("mcpb_unsupported_user_config");
  });

  it("refuses a manifest without an author", async () => {
    const res = await importFile(
      zip(mcpbManifest({ author: undefined }), { "server/index.js": SERVER }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("mcpb_invalid_manifest");
  });

  it("refuses a bundle whose entry point file is missing (the local entry-point rule)", async () => {
    const res = await importFile(zip(mcpbManifest(), { "other.js": SERVER }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("server/index.js");
  });

  it("exports a published local integration as a strict MCPB bundle", async () => {
    const imported = await importFile(zip(mcpbManifest(), { "server/index.js": SERVER }));
    const { packageId } = (await imported.json()) as { packageId: string };

    const res = await exportMcpb(packageId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("fetch-json-1.2.0.mcpb");
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(["manifest.json", "server/index.js"]);
    expect(dec.decode(entries["server/index.js"])).toBe(SERVER);
    const mcpb = JSON.parse(dec.decode(entries["manifest.json"])) as Record<string, any>;
    expect(validateMcpb(mcpb)).toBe(true);
    expect(validateMcpb.errors ?? []).toEqual([]);
    expect(Object.values(mcpb.user_config as Record<string, any>).map((e) => e.sensitive)).toEqual([
      true,
    ]);
  });

  it("refuses to export an integration delivering a credential as a file (mcpb_unsupported_auth)", async () => {
    const manifest = {
      ...localIntegrationManifest({
        name: "@mcpborg/ssh-like",
        version: "1.0.0",
        server: { entryPoint: "server/index.js" },
        auths: { key: { type: "custom" } },
      }),
    } as Record<string, any>;
    manifest.auths = {
      key: {
        type: "custom",
        authorized_uris: ["https://api.example.com/*"],
        credentials: {
          schema: {
            type: "object",
            properties: { private_key: { type: "string", writeOnly: true } },
            required: ["private_key"],
          },
        },
        delivery: {
          files: { "/tmp/id_key": { value: "{$credential.private_key}", mode: "0600" } },
        },
      },
    };
    const imported = await importFile(
      zip(manifest, { "server/index.js": SERVER }),
      "ssh-like.afps",
    );
    expect(imported.status).toBe(201);
    const res = await exportMcpb("@mcpborg/ssh-like");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("mcpb_unsupported_auth");
  });

  it("refuses to export a remote integration (mcpb_not_local)", async () => {
    const manifest = remoteIntegrationManifest({
      name: "@mcpborg/remote-one",
      auths: { api: { type: "api_key" } },
    });
    const imported = await importFile(
      zip(manifest as unknown as Record<string, unknown>, {}),
      "r.afps",
    );
    expect(imported.status).toBe(201);
    const res = await exportMcpb("@mcpborg/remote-one");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("mcpb_not_local");
  });

  it("round-trips: import → export → import under another org keeps source.server", async () => {
    const first = await importFile(zip(mcpbManifest(), { "server/index.js": SERVER }));
    const { packageId } = (await first.json()) as { packageId: string };
    const exported = new Uint8Array(await (await exportMcpb(packageId)).arrayBuffer());
    const original = await readIntegration(packageId);

    const other = await createTestContext({ orgSlug: "secondorg" });
    const again = await importFile(exported, "fetch.mcpb", other);
    expect(again.status).toBe(201);
    const { packageId: secondId } = (await again.json()) as { packageId: string };
    expect(secondId).toBe("@secondorg/fetch-json");
    const res = await app.request(`/api/packages/integrations/${secondId}`, {
      headers: authHeaders(other),
    });
    const second = ((await res.json()) as { manifest: Record<string, any> }).manifest;
    expect(second.source.server).toEqual(original.source.server);
  });

  it("answers a caller who cannot read the package as the archive download does", async () => {
    const imported = await importFile(zip(mcpbManifest(), { "server/index.js": SERVER }));
    const { packageId } = (await imported.json()) as { packageId: string };
    const stranger = await createTestContext({ orgSlug: "strangerorg" });

    const download = await app.request(`/api/packages/${packageId}/1.2.0/download`, {
      headers: authHeaders(stranger),
    });
    const exported = await exportMcpb(packageId, "", stranger);
    expect(download.status).toBe(404);
    expect(exported.status).toBe(download.status);
  });
});

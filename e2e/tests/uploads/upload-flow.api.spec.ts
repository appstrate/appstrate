/**
 * E2E test for the upload:// protocol — covers the full direct-upload flow:
 *
 *   POST /api/uploads       → get presigned descriptor + upload:// URI
 *   PUT   <url>             → push the bytes to storage
 *   POST /api/agents/:id/run → submit run with upload:// in input JSON
 *
 * Also covers server-side magic-byte validation: a file declared as PDF but
 * with spoofed content MUST be rejected at run-consume time.
 *
 * @tags @critical
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import type { ApiClient } from "../../helpers/api-client.ts";

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // "%PDF-1.4\n"

async function createAgentWithFileInput(client: ApiClient, scope: string, name: string) {
  const manifest = {
    schemaVersion: "1.0",
    name: `${scope}/${name}`,
    displayName: `Upload Test ${name}`,
    version: "0.1.0",
    type: "agent",
    description: "E2E upload-flow test agent",
    input: {
      schema: {
        type: "object",
        properties: {
          doc: { type: "string", format: "uri", contentMediaType: "application/pdf" },
        },
        required: ["doc"],
      },
      fileConstraints: { doc: { accept: ".pdf", maxSize: 5_000_000 } },
    },
  };

  const res = await client.post("/packages/agents", {
    manifest,
    content: "Echo the uploaded document.",
  });
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`Create upload agent failed (${res.status()}): ${await res.text()}`);
  }
  return res.json();
}

test.describe("upload:// protocol", () => {
  test("POST /uploads → PUT → run consumes the blob", async ({
    apiClient,
    browserCtx,
    request,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const agentName = `upload-ok-${Date.now()}`;
    await createAgentWithFileInput(apiClient, scope, agentName);

    // 1. Reserve the upload slot.
    const createRes = await apiClient.post("/uploads", {
      name: "hello.pdf",
      size: PDF_MAGIC.length,
      mime: "application/pdf",
    });
    expect(createRes.status()).toBe(201);
    const descriptor = await createRes.json();
    expect(descriptor.uri).toMatch(/^upload:\/\/upl_/);
    expect(descriptor.method).toBe("PUT");

    // 2. PUT the bytes to the signed URL.
    const putRes = await request.fetch(descriptor.url, {
      method: "PUT",
      headers: descriptor.headers,
      data: Buffer.from(PDF_MAGIC),
    });
    expect(putRes.ok()).toBe(true);

    // 3. Trigger a run referencing the upload URI.
    const runRes = await apiClient.post(`/agents/${scope}/${agentName}/run`, {
      input: { doc: descriptor.uri },
    });
    expect(runRes.status()).toBe(200);
  });

  test("consume rejects a file whose magic bytes don't match contentMediaType", async ({
    apiClient,
    browserCtx,
    request,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const agentName = `upload-bad-${Date.now()}`;
    await createAgentWithFileInput(apiClient, scope, agentName);

    // Bytes that look nothing like a PDF.
    const garbage = new TextEncoder().encode("this is plainly not a PDF file");

    const createRes = await apiClient.post("/uploads", {
      name: "fake.pdf",
      size: garbage.length,
      mime: "application/pdf",
    });
    expect(createRes.status()).toBe(201);
    const descriptor = await createRes.json();

    const putRes = await request.fetch(descriptor.url, {
      method: "PUT",
      headers: descriptor.headers,
      data: Buffer.from(garbage),
    });
    expect(putRes.ok()).toBe(true);

    const runRes = await apiClient.post(`/agents/${scope}/${agentName}/run`, {
      input: { doc: descriptor.uri },
    });
    expect(runRes.status()).toBe(400);
    const body = await runRes.text();
    expect(body.toLowerCase()).toContain("mime");
  });

  test("reusing an upload:// URI twice fails with 409", async ({
    apiClient,
    browserCtx,
    request,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const agentName = `upload-once-${Date.now()}`;
    await createAgentWithFileInput(apiClient, scope, agentName);

    const createRes = await apiClient.post("/uploads", {
      name: "once.pdf",
      size: PDF_MAGIC.length,
      mime: "application/pdf",
    });
    const descriptor = await createRes.json();

    await request.fetch(descriptor.url, {
      method: "PUT",
      headers: descriptor.headers,
      data: Buffer.from(PDF_MAGIC),
    });

    const first = await apiClient.post(`/agents/${scope}/${agentName}/run`, {
      input: { doc: descriptor.uri },
    });
    expect(first.status()).toBe(200);

    const second = await apiClient.post(`/agents/${scope}/${agentName}/run`, {
      input: { doc: descriptor.uri },
    });
    expect([404, 409, 410]).toContain(second.status());
  });
});

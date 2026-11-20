// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import { legacyMcpHandler } from "@appstrate/mcp-transport/testing";
import { test, expect } from "../../fixtures/browser.fixture.ts";
import { pickModel, withLocalChatModel } from "../../helpers/chat-model.ts";

for (const [scenario, title] of [
  ["success", "reads a remote tool image for the current turn and reloads only its receipt"],
  ["diagnostic", "reads an error screenshot and preserves the remote failure"],
  ["corrupt", "shows a provider refusal for a truncated image and reloads only its receipt"],
] as const) {
  test(title, async ({ authedPage: page, apiClient, browserCtx }, testInfo) => {
    test.slow();
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    // The truncated PNG still has a valid MIME signature. The provider detects the missing pixels.
    const data =
      scenario === "corrupt" ? Buffer.from(png, "base64").subarray(0, 41).toString("base64") : png;
    const privateImage =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC";
    const rawRefusal = "Cannot decode PNG: incomplete image data";
    let refusals = 0;
    let reads = 0;
    const mcp = legacyMcpHandler({
      tools: [
        {
          descriptor: { name: "read_media_file", inputSchema: { type: "object" } },
          handler: async () => {
            reads++;
            return {
              isError: scenario === "diagnostic",
              content: [
                ...(scenario === "diagnostic"
                  ? [{ type: "text" as const, text: "Remote preview failed" }]
                  : []),
                { type: "image", mimeType: "image/png", data },
                {
                  type: "image",
                  mimeType: "image/png",
                  data: privateImage,
                  annotations: { audience: ["user"] },
                },
              ],
            };
          },
        },
      ],
    });
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await mcp(
        new Request("http://localhost/mcp", {
          method: req.method,
          headers: Object.entries(req.headers).flatMap(([key, value]): [string, string][] =>
            value === undefined ? [] : [[key, String(value)]],
          ),
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        }),
      );
      res
        .writeHead(response.status, Object.fromEntries(response.headers))
        .end(await response.text());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Missing MCP port");
      const { orgSlug, defaultSpaceId, orgId } = browserCtx.org;
      const integration = `@${orgSlug}/photo`;
      const created = await apiClient.post("/packages/integrations", {
        manifest: {
          schema_version: "0.3",
          type: "integration",
          name: integration,
          version: "1.0.0",
          display_name: "Photo",
          description: "Returns a test PNG",
          source: {
            kind: "remote",
            remote: { url: `http://127.0.0.1:${addr.port}/mcp`, transport: "streamable-http" },
          },
          tools_policy: { read_media_file: {} },
          default_tools: ["read_media_file"],
        },
      });
      expect(created.ok(), await created.text()).toBe(true);
      const modelId = "local-relay-vision";
      const answer =
        scenario === "corrupt"
          ? "Le modèle a refusé la demande. Modifiez-la avant de réessayer."
          : "Image du connecteur reçue.";
      const followup = "Le reçu est disponible.";
      const reply: Parameters<typeof withLocalChatModel>[1]["reply"] = (body) => {
        const messages = JSON.stringify(body.messages);
        if (messages.includes(privateImage)) return "User-only image reached the provider";
        if (messages.includes("Relis le reçu")) {
          return messages.includes("supplied for this turn") &&
            !messages.includes(data) &&
            !messages.includes("data:image/")
            ? followup
            : "Unexpected replay";
        }
        const results = body.messages.filter((m) => m.role === "tool");
        if (!results.length)
          return {
            name: "search",
            arguments: {
              kinds: ["integration_tool"],
              integration,
              space_id: defaultSpaceId,
            },
          };
        if (results.length === 1) {
          const tool = JSON.stringify(results[0]?.content).match(
            /[a-z0-9_]+__read_media_file/,
          )?.[0];
          if (!tool) return "Missing remote tool";
          return {
            name: "call_integration_tool",
            arguments: { tool, space_id: defaultSpaceId, arguments: {} },
          };
        }
        const imageUrls = body.messages.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.flatMap((part) =>
                part?.type === "image_url" ? [part.image_url?.url] : [],
              )
            : [],
        );
        if (imageUrls.length !== 1 || imageUrls[0] !== `data:image/png;base64,${data}`) {
          return "Missing typed image input";
        }
        if (
          scenario === "diagnostic" &&
          !JSON.stringify(results).includes("Remote preview failed")
        ) {
          return "Missing diagnostic text";
        }
        if (scenario === "corrupt") {
          refusals++;
          return Response.json(
            {
              error: { type: "invalid_request_error", code: "invalid_image", message: rawRefusal },
            },
            { status: 400 },
          );
        }
        return answer;
      };
      await withLocalChatModel(
        apiClient,
        { modelId, input: ["text", "image"], reply },
        async () => {
          const errors: string[] = [];
          page.on("pageerror", (e) => errors.push(e.message));
          await page.goto("/chat");
          await pickModel(page, modelId);
          const message = page.getByRole("textbox", { name: "Message Appstrate…", exact: true });
          await message.fill("Lis une image du connecteur.");
          const streamResponse = page.waitForResponse(
            (r) =>
              r.request().method() === "POST" &&
              r.headers()["content-type"]?.includes("text/event-stream") === true,
          );
          await page.getByRole("button", { name: "Envoyer", exact: true }).click();
          const outcome =
            scenario === "corrupt"
              ? page.getByRole("alert").filter({ hasText: answer })
              : page.getByText(answer, { exact: true });
          await expect(outcome).toBeVisible();
          const response = await streamResponse;
          expect(response.ok()).toBe(true);
          if (scenario === "corrupt") {
            // The client closes the SSE reader on a terminal error. Verify its rendered outcome.
            await expect(outcome).toContainText("Identifiant de requête");
            await expect(outcome).not.toContainText(rawRefusal);
          } else {
            const stream = await response.text();
            expect(stream).toContain("supplied for this turn");
            expect(stream).not.toContain(data);
            expect(stream).not.toContain(privateImage);
            if (scenario === "diagnostic") expect(stream).toContain("tool-output-error");
          }
          const sessionId = new URL(page.url()).pathname.split("/").at(-1);
          const session = await apiClient.get(`/orgs/${orgId}/chat/sessions/${sessionId}`);
          expect(session.status()).toBe(200);
          const history = await session.text();
          expect(history).toContain("supplied for this turn");
          expect(history).not.toContain(data);
          expect(history).not.toContain(privateImage);
          expect(history).not.toContain(rawRefusal);
          if (scenario === "corrupt") expect(history).toContain("invalid_request");
          await page.reload();
          await expect(outcome).toBeVisible();
          await message.fill("Relis le reçu de cette image.");
          await page.getByRole("button", { name: "Envoyer", exact: true }).click();
          await expect(page.getByText(followup, { exact: true })).toBeVisible();
          expect(reads).toBe(1);
          expect(refusals).toBe(scenario === "corrupt" ? 1 : 0);
          expect(errors).toEqual([]);
          await page.screenshot({
            path: testInfo.outputPath("relayed-image-chat.png"),
            animations: "disabled",
          });
        },
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

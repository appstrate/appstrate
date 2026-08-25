// SPDX-License-Identifier: Apache-2.0

/** Behaviour and geometry guard for the shared creation handoff. */

import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const BASE = process.env.LAB_URL ?? "http://localhost:5175";
const browser = await chromium.launch({ channel: "chrome" });
const resources = [
  ["/agents?create=agent", "agent"],
  ["/skills?create=skill", "skill"],
  ["/integrations?create=integration", "integration"],
  ["/mcp-servers?create=mcp-server", "mcp-server"],
];

async function withPage(width, run) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem("appstrate-lab-scenario", "nominal"));
  const page = await context.newPage();
  try {
    await run(page);
  } finally {
    await context.close();
  }
}

for (const width of [1440, 390]) {
  await withPage(width, async (page) => {
    for (const [path, resource] of resources) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      const chooser = page.locator(`[data-creation-chooser="${resource}"]`);
      await chooser.waitFor({ state: "visible" });
      assert.equal(await chooser.locator("[data-creation-method]").count(), 3);
      assert.equal(await chooser.locator("[data-creation-method]:disabled").count(), 0);
      const overflow = await chooser.evaluate(() => ({
        viewport: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        dialog: (() => {
          const dialog = document.querySelector('[role="dialog"]');
          return dialog ? dialog.scrollWidth - dialog.clientWidth : -1;
        })(),
      }));
      assert.ok(overflow.viewport <= 1, `${path} viewport overflow at ${width}`);
      assert.ok(overflow.dialog <= 1, `${path} dialog overflow at ${width}`);
    }
  });
}
console.log("  four enabled creation handoffs at 1440 / 390: ok");

await withPage(1440, async (page) => {
  await page.goto(`${BASE}/agents?create=agent`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-creation-method="coding-agent"]').click();
  const prompt = page.getByTestId("creation-coding-prompt");
  await prompt.waitFor({ state: "visible" });
  assert.match((await prompt.textContent()) ?? "", /createAgent/);
  await page.getByRole("tab", { name: /Connecter le MCP|Connect MCP/ }).click();
  await page.getByText("claude mcp add", { exact: false }).waitFor({ state: "visible" });
});
console.log("  coding-agent prompt and canonical MCP connection instructions: ok");

await withPage(1440, async (page) => {
  let chatPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat") {
      chatPosts += 1;
    }
  });
  await page.goto(`${BASE}/agents?create=agent`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-creation-method="chat"]').click();
  await page.waitForURL("**/chat");
  const composer = page.getByPlaceholder("Message Appstrate…");
  await composer.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const composer = [...document.querySelectorAll("textarea")].find(
      (element) => element.placeholder === "Message Appstrate…",
    );
    return Boolean(composer?.value.includes("createAgent"));
  });
  assert.match(await composer.inputValue(), /createAgent/);
  assert.equal(chatPosts, 0);
});
console.log("  Chat receives an editable draft without sending it: ok");

await withPage(1440, async (page) => {
  await page.goto(`${BASE}/agents?create=agent`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-creation-method="manual"]').click();
  await page.waitForURL("**/agents/new");
  assert.equal(new URL(page.url()).pathname, "/agents/new");

  await page.goto(`${BASE}/mcp-servers?create=mcp-server`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator('[data-creation-method="manual"]').click();
  await page
    .getByRole("heading", { name: /Importer un package|Import package/ })
    .waitFor({ state: "visible" });
});
console.log("  existing manual editor and MCP import destinations: ok");

await browser.close();

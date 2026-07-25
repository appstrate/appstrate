// SPDX-License-Identifier: Apache-2.0
/**
 * End-to-end check of the human handoff (`browser.request_human`).
 *
 * The agent asks for a person, the run is parked, and the hand-back is
 * performed by CLICKING THE REAL BUTTON in the desktop's chrome through
 * CDP. Nothing is simulated server-side: banner, button, notification
 * and the suspended call are all the production path.
 *
 * Prerequisites: a platform loading the `desktop` module, and the app
 * started with `APPSTRATE_DESKTOP_REMOTE_DEBUG=1` (source builds only —
 * a packaged app never opens a debugging port).
 *
 * Run: bun run apps/api/scripts/desktop-handoff-e2e.ts
 */

import { db } from "@appstrate/db/client";
import { packages, runs, applications, organizations, user } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { signRunToken } from "../src/lib/run-token.ts";

const PLATFORM = "http://localhost:3100";
const CDP = "http://127.0.0.1:9222";
const SITE_PORT = 4601;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const AGENT = "@e2e/handoff-agent";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/**
 * Evaluate an expression in the desktop's own chrome (the navbar
 * renderer), which is where the banner and its button live.
 */
async function evaluateInChrome(expression: string): Promise<unknown> {
  const targets = (await (await fetch(`${CDP}/json/list`)).json()) as CdpTarget[];
  const navbar = targets.find((t) => t.url.includes("navbar.html"));
  if (!navbar) throw new Error("navbar target not found — is the app running with remote debug?");
  const socket = new WebSocket(navbar.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const reply = await new Promise<Record<string, any>>((resolve) => {
    socket.onmessage = (event) => resolve(JSON.parse(String(event.data)));
    socket.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true },
      }),
    );
  });
  socket.close();
  return reply.result?.result?.value;
}

async function command(token: string, body: Record<string, unknown>) {
  const res = await fetch(`${PLATFORM}/internal/desktop-command`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

function manifest(id: string): Record<string, unknown> {
  return {
    name: id,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.1",
    display_name: "Handoff Agent",
    runtime_tools: ["desktop_browser"],
    desktop_browser: { authorized_uris: [`${SITE}/**`] },
  };
}

const site = Bun.serve({
  port: SITE_PORT,
  hostname: "127.0.0.1",
  fetch: () =>
    new Response("<html><body>portal</body></html>", {
      headers: { "Content-Type": "text/html" },
    }),
});

let runId = "";
try {
  const [org] = await db.select().from(organizations).limit(1);
  const [app] = await db
    .select()
    .from(applications)
    .where(eq(applications.orgId, org!.id))
    .limit(1);
  const [owner] = await db.select().from(user).limit(1);

  await db
    .insert(packages)
    .values({
      id: AGENT,
      type: "agent",
      orgId: org!.id,
      createdBy: owner!.id,
      draftManifest: manifest(AGENT),
      source: "local",
    })
    .onConflictDoUpdate({ target: packages.id, set: { draftManifest: manifest(AGENT) } });

  const [row] = await db
    .insert(runs)
    .values({
      id: `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      packageId: AGENT,
      orgId: org!.id,
      applicationId: app!.id,
      userId: owner!.id,
      status: "running",
      input: {},
    })
    .returning({ id: runs.id });
  runId = row!.id;
  const token = signRunToken(runId);

  await command(token, {
    method: "browser.navigate",
    params: { url: `${SITE}/` },
    timeout_ms: 20000,
  });

  // The agent hits something only a person can clear, and stops.
  const started = Date.now();
  const parked = command(token, {
    method: "browser.request_human",
    params: { message: "saisis le code reçu par SMS puis rends-moi la main" },
  });
  await Bun.sleep(2000);

  const stillSuspended = await Promise.race([
    parked.then(() => false),
    Bun.sleep(50).then(() => true),
  ]);
  check("the agent's call stays suspended while the person acts", stillSuspended);

  // The banner is what the person actually sees.
  const bannerText = (await evaluateInChrome(
    `document.getElementById("banner-text").textContent`,
  )) as string;
  check(
    "the banner shows the agent's request",
    typeof bannerText === "string" && bannerText.includes("code reçu par SMS"),
    `banner said "${bannerText}"`,
  );
  const bannerVisible = await evaluateInChrome(`document.body.dataset.banner`);
  check("the banner is on screen", bannerVisible === "true", `data-banner=${bannerVisible}`);

  // Meanwhile the run must not be able to work behind the person's back.
  const blocked = await command(token, { method: "browser.screenshot", timeout_ms: 20000 });
  check(
    "the run cannot drive the parked tab meanwhile",
    blocked.status === 409 && blocked.body.code === "desktop_tab_paused",
    `${blocked.status} ${blocked.body.code ?? ""}`,
  );

  // The person clicks "Rendre la main" — the real button, real click.
  await evaluateInChrome(`document.getElementById("banner-resume").click()`);

  const answer = await parked;
  check(
    "clicking hand-back releases the agent",
    answer.status === 200 && answer.body.result?.resumed === true,
    `${answer.status} ${JSON.stringify(answer.body.result)} after ${Math.round((Date.now() - started) / 1000)}s`,
  );

  const afterResume = await command(token, { method: "browser.screenshot", timeout_ms: 20000 });
  check(
    "the agent drives again once the tab is handed back",
    afterResume.status === 200,
    `${afterResume.status}`,
  );

  const bannerGone = await evaluateInChrome(`document.body.dataset.banner`);
  check("the banner clears on hand-back", bannerGone === "false", `data-banner=${bannerGone}`);

  const list = await command(token, { method: "browser.tabs.list", timeout_ms: 20000 });
  for (const tab of list.body.result?.tabs ?? []) {
    await command(token, { method: "browser.tabs.close", tab_id: tab.tab_id, timeout_ms: 20000 });
  }
} finally {
  site.stop(true);
  if (runId) await db.delete(runs).where(eq(runs.id, runId));
  await db.delete(packages).where(eq(packages.id, AGENT));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);

// SPDX-License-Identifier: Apache-2.0
/**
 * End-to-end check of the multi-tab desktop bridge, against a REAL
 * platform (:3100) and the REAL Electron app.
 *
 * What makes this e2e rather than integration: the commands travel the
 * whole chain — HTTP → lease → WebSocket → Electron TabManager → CDP →
 * a live Chromium tab — and the assertions read what actually happened
 * in that browser.
 *
 * A local site (127.0.0.1:4599) stands in for a portal: /login sets a
 * session cookie, / reports whether the caller carries one. That is what
 * makes the isolation claim testable: if agent B can read the session
 * agent A opened, this prints it.
 *
 * Run: bun run <this file>   (from the worktree root, so .env loads)
 */

import { db } from "@appstrate/db/client";
import { packages, runs, applications, organizations, user } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { signRunToken } from "../src/lib/run-token.ts";

const PLATFORM = "http://localhost:3100";
const SITE_PORT = 4599;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Stand-in portal: hands out a session cookie, then reports it back. */
function startSite(): { stop(): void } {
  const server = Bun.serve({
    port: SITE_PORT,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/login") {
        return new Response("<html><body>logged in</body></html>", {
          headers: {
            "Content-Type": "text/html",
            "Set-Cookie": `e2e_sid=SESSION-OF-A; Path=/; SameSite=Lax`,
          },
        });
      }
      const cookie = req.headers.get("cookie") ?? "";
      const match = /e2e_sid=([^;]+)/.exec(cookie);
      const body = match ? `session=${match[1]}` : "anonymous";
      return new Response(`<html><body>${body}</body></html>`, {
        headers: { "Content-Type": "text/html" },
      });
    },
  });
  return { stop: () => server.stop(true) };
}

function agentManifest(name: string, session?: "isolated" | "agent" | "user") {
  return {
    name,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.1",
    display_name: name,
    runtime_tools: ["desktop_browser", "desktop_browser_evaluate"],
    desktop_browser: {
      authorized_uris: [`${SITE}/**`],
      ...(session ? { session } : {}),
    },
  };
}

async function seedAgentPackage(id: string, orgId: string, userId: string): Promise<void> {
  await db
    .insert(packages)
    .values({
      id,
      type: "agent",
      orgId,
      createdBy: userId,
      draftManifest: agentManifest(id),
      source: "local",
    })
    .onConflictDoUpdate({
      target: packages.id,
      set: { draftManifest: agentManifest(id) },
    });
}

async function seedRun(
  packageId: string,
  orgId: string,
  applicationId: string,
  userId: string,
): Promise<string> {
  const [row] = await db
    .insert(runs)
    .values({
      id: `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      packageId,
      orgId,
      applicationId,
      userId,
      status: "running",
      input: {},
    })
    .returning({ id: runs.id });
  return row!.id;
}

interface CommandResult {
  status: number;
  body: { result?: unknown; code?: string; detail?: string };
}

async function command(token: string, body: Record<string, unknown>): Promise<CommandResult> {
  const res = await fetch(`${PLATFORM}/internal/desktop-command`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as CommandResult["body"];
  return { status: res.status, body: parsed };
}

/** Navigate, then read what the page says — the ground truth of this run. */
async function pageText(token: string, path: string, tabId?: string): Promise<string> {
  await command(token, {
    method: "browser.navigate",
    params: { url: `${SITE}${path}`, timeoutMs: 8000 },
    ...(tabId ? { tab_id: tabId } : {}),
    timeout_ms: 20000,
  });
  const res = await command(token, {
    method: "browser.evaluate",
    params: { script: "document.body.textContent" },
    ...(tabId ? { tab_id: tabId } : {}),
    timeout_ms: 20000,
  });
  return typeof res.body.result === "string" ? res.body.result.trim() : JSON.stringify(res.body);
}

const site = startSite();

try {
  // The desktop is bound to a PERSON, so drive the runs of the user whose
  // Electron app is connected — the most recently active one.
  const [org] = await db.select().from(organizations).limit(1);
  const [app] = await db
    .select()
    .from(applications)
    .where(eq(applications.orgId, org!.id))
    .limit(1);
  const [owner] = await db.select().from(user).limit(1);
  console.log(`org=${org!.id} app=${app!.id} user=${owner!.id}\n`);

  const AGENT_A = "@e2e/tabs-agent-a";
  const AGENT_B = "@e2e/tabs-agent-b";
  await seedAgentPackage(AGENT_A, org!.id, owner!.id);
  await seedAgentPackage(AGENT_B, org!.id, owner!.id);

  const runA = await seedRun(AGENT_A, org!.id, app!.id, owner!.id);
  const runB = await seedRun(AGENT_B, org!.id, app!.id, owner!.id);
  const runC = await seedRun(AGENT_A, org!.id, app!.id, owner!.id);
  const tokenA = signRunToken(runA);
  const tokenB = signRunToken(runB);
  const tokenC = signRunToken(runC);

  // 1. A run with no tab yet gets one opened for it — the compatibility
  //    path every pre-tabs agent takes.
  const anon = await pageText(tokenA, "/");
  check("implicit tab opens and drives a live page", anon === "anonymous", `page said "${anon}"`);

  // 2. The session A opens lands in A's own profile.
  await pageText(tokenA, "/login");
  const asA = await pageText(tokenA, "/");
  check("agent A sees the session it opened", asA === "session=SESSION-OF-A", `page said "${asA}"`);

  // 3. THE point of the profile split: another agent, same site, at the
  //    same moment, must land anonymous.
  const asB = await pageText(tokenB, "/");
  check(
    "agent B cannot see agent A's session (profile isolation)",
    asB === "anonymous",
    `page said "${asB}"`,
  );

  // 4. B just drove the same site while A held it: distinct profiles do
  //    not contend.
  check("two runs work the same site in parallel across profiles", asB === "anonymous");

  // 5. Same agent, second run, same site: shared cookie jar, so it waits.
  const cOnSameOrigin = await command(tokenC, {
    method: "browser.navigate",
    params: { url: `${SITE}/` },
    timeout_ms: 20000,
  });
  check(
    "same-agent concurrent run is serialized on the origin",
    cOnSameOrigin.status === 409 && cOnSameOrigin.body.code === "desktop_in_use",
    `${cOnSameOrigin.status} ${cOnSameOrigin.body.code ?? ""}`,
  );

  // 6. Tab ownership: B may not drive A's tab.
  const openForA = await command(tokenA, { method: "browser.tabs.open", timeout_ms: 20000 });
  const aTabId = (openForA.body.result as { tab_id?: string } | undefined)?.tab_id ?? "";
  const stolen = await command(tokenB, {
    method: "browser.screenshot",
    tab_id: aTabId,
    timeout_ms: 20000,
  });
  check(
    "a run cannot drive another run's tab",
    stolen.status === 409,
    `${stolen.status} ${stolen.body.code ?? ""}`,
  );

  // 7. Closed tab reads as gone, not as somebody else's surface.
  await command(tokenA, { method: "browser.tabs.close", tab_id: aTabId, timeout_ms: 20000 });
  const afterClose = await command(tokenA, {
    method: "browser.screenshot",
    tab_id: aTabId,
    timeout_ms: 20000,
  });
  check(
    "a closed tab answers 410",
    afterClose.status === 410,
    `${afterClose.status} ${afterClose.body.code ?? ""}`,
  );

  // 8. Tab budget (A already holds its implicit tab).
  const opened: string[] = [];
  let quotaStatus = 0;
  let quotaCode = "";
  for (let i = 0; i < 4; i++) {
    const res = await command(tokenA, { method: "browser.tabs.open", timeout_ms: 20000 });
    if (res.status === 200) {
      opened.push((res.body.result as { tab_id: string }).tab_id);
    } else {
      quotaStatus = res.status;
      quotaCode = res.body.code ?? "";
      break;
    }
  }
  check(
    "tab budget is enforced per run",
    quotaStatus === 409 && quotaCode === "desktop_tab_quota",
    `opened ${opened.length} extra then ${quotaStatus} ${quotaCode}`,
  );
  for (const tabId of opened) {
    await command(tokenA, { method: "browser.tabs.close", tab_id: tabId, timeout_ms: 20000 });
  }

  // 9. Profile persistence across runs of the SAME agent. The origin
  //    lease has to lapse first (2 min) — that wait is the test.
  console.log("\nwaiting out the origin lease (~130s) to test cross-run profile reuse…");
  await new Promise((resolve) => setTimeout(resolve, 130_000));
  const cAfterWait = await pageText(tokenC, "/");
  check(
    "a later run of the same agent reuses its profile (no re-login)",
    cAfterWait === "session=SESSION-OF-A",
    `page said "${cAfterWait}"`,
  );

  // Cleanup: close what the runs opened and mark them done.
  for (const token of [tokenA, tokenB, tokenC]) {
    const list = await command(token, { method: "browser.tabs.list", timeout_ms: 20000 });
    const tabs = (list.body.result as { tabs?: Array<{ tab_id: string }> } | undefined)?.tabs ?? [];
    for (const tab of tabs) {
      await command(token, { method: "browser.tabs.close", tab_id: tab.tab_id, timeout_ms: 20000 });
    }
  }
  for (const id of [runA, runB, runC]) {
    await db.update(runs).set({ status: "success" }).where(eq(runs.id, id));
  }
} finally {
  site.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);

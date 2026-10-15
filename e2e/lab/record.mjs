// SPDX-License-Identifier: Apache-2.0

/**
 * Record the response shapes requested by the real web app while Playwright
 * walks the lab screen catalogue. This records nominal shape candidates only.
 * It never imports or rewrites the authored lab fixtures or handlers.
 *
 * Environment:
 *   LAB_RECORD_URL       real Tier 0 app URL (default http://localhost:3000)
 *   LAB_RECORD_SCREENS   comma-separated screen names or paths (default: all)
 *   LAB_RECORD_OUT       candidate TypeScript path
 *   LAB_RECORD_REPORT    Markdown report path
 *   LAB_RECORD_EMAIL     disposable local account (default olivier@tractr.net)
 *   LAB_RECORD_PASSWORD  disposable local password (default 123456789)
 *   LAB_RECORD_START=0   do not start `bun run dev` when the URL is unavailable
 */

import { chromium } from "@playwright/test";
import { format } from "prettier";
import { sign } from "../../packages/afps-runtime/src/events/signing.ts";
import { createApiClient } from "../helpers/api-client.ts";
import { createAgent, createEndUser, createOrg } from "../helpers/seed.ts";
import {
  Pseudonymizer,
  canonicalizeOpenApiPath,
  captureSignature,
  classifyResponse,
  dedupeCaptures,
  generateCandidate,
  generateReport,
  sanitizeJson,
  sanitizeQuery,
} from "./fixture-recorder.mjs";
import { selectScreens } from "./screens.mjs";

function fileUrlPath(url) {
  return decodeURIComponent(url.pathname);
}

function resolvePath(root, candidate) {
  if (candidate.startsWith("/")) return candidate;
  return fileUrlPath(new URL(candidate, `file://${root}/`));
}

function directoryName(file) {
  const separator = file.lastIndexOf("/");
  return separator <= 0 ? "/" : file.slice(0, separator);
}

function relativePath(from, to) {
  const fromParts = from.split("/").filter(Boolean);
  const toParts = to.split("/").filter(Boolean);
  let shared = 0;
  while (fromParts[shared] === toParts[shared] && shared < fromParts.length) shared += 1;
  return [
    ...Array.from({ length: fromParts.length - shared }, () => ".."),
    ...toParts.slice(shared),
  ].join("/");
}

async function output(message) {
  await Bun.write(Bun.stdout, `${message}\n`);
}

async function runCommand(argv) {
  const child = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  const exitCode = await child.exited;
  if (exitCode === 0) return;
  const stderr = await new Response(child.stderr).text();
  throw new Error(`${argv[0]} failed (${exitCode}): ${stderr.trim()}`);
}

const REPO = resolvePath(import.meta.dir, "../..").replace(/\/$/, "");
const BASE = Bun.env.LAB_RECORD_URL ?? "http://localhost:3000";
const EMAIL = Bun.env.LAB_RECORD_EMAIL ?? "olivier@tractr.net";
const PASSWORD = Bun.env.LAB_RECORD_PASSWORD ?? "123456789";
const START_SERVER = Bun.env.LAB_RECORD_START !== "0";
const OUT = resolvePath(
  REPO,
  Bun.env.LAB_RECORD_OUT ?? "apps/web/src/lab/recorded-fixtures.generated.ts",
);
const REPORT = resolvePath(
  REPO,
  Bun.env.LAB_RECORD_REPORT ?? "apps/web/src/lab/recorded-fixtures.report.md",
);
const SCREENS = selectScreens(Bun.env.LAB_RECORD_SCREENS);

async function isReachable() {
  try {
    const response = await fetch(`${BASE}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await isReachable()) return;
  if (!START_SERVER) {
    throw new Error(`${BASE} is unavailable and LAB_RECORD_START=0`);
  }

  const child = Bun.spawn(["bun", "run", "dev"], {
    cwd: REPO,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: Bun.env,
  });
  child.unref();
  await output(
    `Started Tier 0 development server (pid ${child.pid ?? "unknown"}); leaving it running.`,
  );

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await isReachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Tier 0 server did not become ready at ${BASE} within 120 seconds`);
}

function nativeApi() {
  const call = async (method, url, options = {}) => {
    const headers = new Headers(options.headers);
    let body;
    if (options.data !== undefined) {
      body = JSON.stringify(options.data);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    }
    const response = await fetch(new URL(url, BASE), { method, headers, body });
    return {
      status: () => response.status,
      ok: () => response.ok,
      json: () => response.json(),
      text: () => response.text(),
      headers: () => Object.fromEntries(response.headers.entries()),
    };
  };
  return {
    get: (url, options) => call("GET", url, options),
    post: (url, options) => call("POST", url, options),
    put: (url, options) => call("PUT", url, options),
    patch: (url, options) => call("PATCH", url, options),
    delete: (url, options) => call("DELETE", url, options),
  };
}

async function authenticate(api) {
  let response = await api.post("/api/auth/sign-in/email", {
    headers: { Origin: BASE },
    data: { email: EMAIL, password: PASSWORD },
  });
  if (response.status() !== 200) {
    response = await api.post("/api/auth/sign-up/email", {
      headers: { Origin: BASE },
      data: { email: EMAIL, password: PASSWORD, name: "Fixture Recorder" },
    });
  }
  if (response.status() !== 200) {
    throw new Error(`Could not sign in or create the disposable account (${response.status()})`);
  }
  const body = await response.json();
  const setCookie = response.headers()["set-cookie"] ?? "";
  const cookie = /better-auth\.session_token=([^;]+)/.exec(setCookie)?.[1];
  if (!cookie) throw new Error("Authentication succeeded without a session cookie");
  return {
    cookie: `better-auth.session_token=${cookie}`,
    userId: body.user.id,
    email: body.user.email,
    name: body.user.name,
  };
}

async function ensureContext(api, auth) {
  let response = await api.get("/api/orgs", { headers: { Cookie: auth.cookie } });
  if (!response.ok()) throw new Error(`Could not list organizations (${response.status()})`);
  const organizations = (await response.json()).data ?? [];
  const selected = organizations.find((item) => item.slug === "fixture-recorder");
  let org;
  if (!selected) {
    org = await createOrg(api, auth.cookie, { name: "Fixture Recorder", slug: "fixture-recorder" });
  } else {
    response = await api.get("/api/applications", {
      headers: { Cookie: auth.cookie, "X-Org-Id": selected.id },
    });
    if (!response.ok()) throw new Error(`Could not list applications (${response.status()})`);
    const applications = (await response.json()).data ?? [];
    const application = applications.find((item) => item.isDefault) ?? applications[0];
    if (!application) throw new Error(`Organization ${selected.id} has no application`);
    org = {
      orgId: selected.id,
      orgName: selected.name,
      orgSlug: selected.slug,
      defaultAppId: application.id,
    };
  }
  return org;
}

async function seedRoutes(api, auth, org) {
  const client = createApiClient(api, {
    cookie: auth.cookie,
    orgId: org.orgId,
    applicationId: org.defaultAppId,
  });
  const tag = Date.now().toString(36);
  const scope = `@${org.orgSlug}`;
  const agentName = `fixture-recorder-${tag}`;
  const unresolved = [];
  let runId;
  let endUserId;

  try {
    await createAgent(client, scope, agentName);
    const run = await client.post("/runs/remote", {
      source: { kind: "registry", packageId: `${scope}/${agentName}`, stage: "draft" },
      applicationId: org.defaultAppId,
    });
    if (run.status() === 201 || run.status() === 200) {
      const sink = await run.json();
      runId = sink.id;
      const result = JSON.stringify({
        memories: [],
        pinned: {},
        output: { recorded: true },
        logs: [],
        status: "success",
        durationMs: 1,
      });
      const messageId = `fixture-recorder-${tag}`;
      const timestampSec = Math.floor(Date.now() / 1000);
      const finalized = await fetch(sink.finalize_url, {
        method: "POST",
        headers: {
          ...sign({ msgId: messageId, timestampSec, body: result, secret: sink.secret }),
          "Content-Type": "application/json",
        },
        body: result,
      });
      if (!finalized.ok)
        unresolved.push(`run detail finalize failed with HTTP ${finalized.status}`);
    } else unresolved.push(`run detail seed failed with HTTP ${run.status()}`);
  } catch (error) {
    unresolved.push(
      `agent detail seed failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    endUserId = (
      await createEndUser(client, {
        name: "Recorded End User",
        email: `fixture-${tag}@example.invalid`,
        externalId: `fixture-${tag}`,
      })
    ).id;
  } catch (error) {
    unresolved.push(
      `end-user detail seed failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { scope, agentName, runId, endUserId, unresolved };
}

function resolveScreen(screen, seeded) {
  const agentBase = `/agents/${seeded.scope}/${seeded.agentName}`;
  switch (screen.name) {
    case "agent-detail":
      return agentBase;
    case "agent-connections":
      return `${agentBase}#connections`;
    case "agent-memory":
      return `${agentBase}#memory`;
    case "run-detail":
      return seeded.runId ? `${agentBase}/runs/${seeded.runId}` : null;
    case "run-memory":
      return seeded.runId ? `${agentBase}/runs/${seeded.runId}#memory` : null;
    case "end-user-detail":
      return seeded.endUserId
        ? `/workspace-settings/end-users?user=${encodeURIComponent(seeded.endUserId)}`
        : null;
    case "end-user-edit":
      return seeded.endUserId
        ? `/workspace-settings/end-users?user=${encodeURIComponent(seeded.endUserId)}&edit=1`
        : null;
    default:
      return screen.path;
  }
}

function decodedPathname(url) {
  return url.pathname
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

async function writeAtomically(destination, contents) {
  await runCommand(["mkdir", "-p", directoryName(destination)]);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await Bun.write(Bun.file(temporary), contents);
  await runCommand(["mv", temporary, destination]);
}

await ensureServer();
const api = nativeApi();
const openApiResponse = await api.get("/api/openapi.json");
if (!openApiResponse.ok()) {
  throw new Error(`Could not load live OpenAPI document (${openApiResponse.status()})`);
}
const openApi = await openApiResponse.json();
const auth = await authenticate(api);
const org = await ensureContext(api, auth);
const seeded = await seedRoutes(api, auth, org);

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const baseUrl = new URL(BASE);
const sessionCookie = auth.cookie.split("=", 2);
await context.addCookies([
  {
    name: sessionCookie[0],
    value: sessionCookie[1],
    domain: baseUrl.hostname,
    path: "/",
    secure: baseUrl.protocol === "https:",
  },
]);
await context.addInitScript(
  ({ orgId, applicationId }) => {
    localStorage.setItem("appstrate_current_org", orgId);
    localStorage.setItem("appstrate_current_app", applicationId);
  },
  { orgId: org.orgId, applicationId: org.defaultAppId },
);

const page = await context.newPage();
const pseudonymizer = new Pseudonymizer();
pseudonymizer.alias("id", auth.userId);
pseudonymizer.alias("person", auth.email);
pseudonymizer.alias("name", auth.name);
pseudonymizer.alias("name", org.orgName);
pseudonymizer.alias("name", "Recorded End User");
pseudonymizer.alias("org", org.orgId);
pseudonymizer.alias("app", org.defaultAppId);
pseudonymizer.alias("scope", seeded.scope);
pseudonymizer.alias("agent", seeded.agentName);
pseudonymizer.alias("id", seeded.runId);
pseudonymizer.alias("id", seeded.endUserId);
const observations = new WeakMap();
const respondedRequests = new WeakSet();
const waitingForResponse = new Set();
const pending = new Set();
const captures = [];
const specials = [];
const unresolvedScreens = [...seeded.unresolved];
let order = 0;
let currentScreen = "bootstrap";

function recordSpecial(observation, path, reason, fatal) {
  specials.push({ ...observation, path, reason, fatal });
}

async function waitForCaptureQuiet() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await Promise.allSettled([...pending]);
    if (pending.size === 0 && waitingForResponse.size === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function alreadyCaptured(observation) {
  if (!observation.path) return false;
  const signature = captureSignature({ ...observation, path: observation.path });
  return captures.some((capture) => captureSignature(capture) === signature);
}

page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith("/api/")) return;
  waitingForResponse.add(request);
  const method = request.method().toLowerCase();
  const pathname = decodedPathname(url);
  const canonicalPath = canonicalizeOpenApiPath(pathname, method, openApi.paths ?? {});
  const headers = request.headers();
  const scope = {
    org: pseudonymizer.alias("org", headers["x-org-id"]),
    application: pseudonymizer.alias("app", headers["x-application-id"]),
  };
  let query = "";
  let rejection;
  try {
    query = sanitizeQuery(url.searchParams, pseudonymizer);
  } catch (error) {
    rejection = error instanceof Error ? error.message : String(error);
  }
  observations.set(request, {
    order: ++order,
    method,
    path: canonicalPath,
    query,
    scope,
    screen: currentScreen,
    rejection,
  });
});

page.on("response", (response) => {
  const observation = observations.get(response.request());
  if (!observation) return;
  waitingForResponse.delete(response.request());
  respondedRequests.add(response.request());
  const task = (async () => {
    const safePath = observation.path ?? "[unmatched API path]";
    if (observation.rejection || !observation.path) {
      recordSpecial(
        observation,
        safePath,
        observation.rejection ?? "No matching path in the live OpenAPI document",
        true,
      );
      return;
    }
    const classification = classifyResponse({
      path: observation.path,
      method: observation.method,
      status: response.status(),
      contentType: response.headers()["content-type"] ?? "",
      openApi,
    });
    if (classification.kind !== "json200") {
      const expected =
        observation.path.startsWith("/api/auth/") ||
        response.status() === 204 ||
        classification.reason.startsWith("SSE") ||
        classification.reason.startsWith("Binary");
      recordSpecial(observation, safePath, classification.reason, !expected);
      return;
    }
    try {
      const body = sanitizeJson(await response.json(), pseudonymizer);
      captures.push({ ...observation, path: observation.path, body });
    } catch (error) {
      recordSpecial(
        observation,
        safePath,
        `Rejected before persistence: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  })();
  pending.add(task);
  task.finally(() => pending.delete(task));
});

page.on("requestfailed", (request) => {
  const observation = observations.get(request);
  waitingForResponse.delete(request);
  if (!observation || respondedRequests.has(request)) return;
  if (alreadyCaptured(observation)) return;
  recordSpecial(
    observation,
    observation.path ?? "[unmatched API path]",
    `Network failure: ${request.failure()?.errorText ?? "unknown"}`,
    true,
  );
});

for (const screen of SCREENS) {
  const route = resolveScreen(screen, seeded);
  if (!route) {
    unresolvedScreens.push(`${screen.name}: no live resource id`);
    continue;
  }
  currentScreen = screen.name;
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1200);
    await waitForCaptureQuiet();
    await output(`  ${screen.name}`);
  } catch (error) {
    unresolvedScreens.push(
      `${screen.name}: ${error instanceof Error ? error.message.split("\n", 1)[0] : String(error)}`,
    );
  }
}

await Promise.allSettled([...pending]);
await context.close();
await browser.close();

const deduped = dedupeCaptures(captures);
const specialBySignature = new Map();
for (const special of specials) {
  const signature = [
    special.method,
    special.path,
    special.query,
    special.scope.org,
    special.scope.application,
    special.reason,
  ].join("\u0000");
  if (!specialBySignature.has(signature)) specialBySignature.set(signature, special);
}
const uniqueSpecials = [...specialBySignature.values()];
const fixtureModule = resolvePath(REPO, "apps/web/src/lab/fixtures");
let fixtureImport = relativePath(directoryName(OUT), fixtureModule);
if (!fixtureImport.startsWith(".")) fixtureImport = `./${fixtureImport}`;
const candidate = await format(generateCandidate(deduped.captures, { fixtureImport }), {
  parser: "typescript",
});
const report = generateReport({
  captures: deduped.captures,
  specials: uniqueSpecials.sort((a, b) => a.order - b.order),
  conflicts: deduped.conflicts,
  unresolvedScreens,
});
await writeAtomically(OUT, candidate);
await writeAtomically(REPORT, report);

await output(`\n${deduped.captures.length} typed candidate(s): ${relativePath(REPO, OUT)}`);
await output(
  `${uniqueSpecials.length} special/rejected response(s): ${relativePath(REPO, REPORT)}`,
);
await output("Auth, request headers and request bodies were not persisted.");
if (unresolvedScreens.length > 0 || specials.some((special) => special.fatal)) {
  throw new Error("Fixture recording stopped with blocking report items");
}

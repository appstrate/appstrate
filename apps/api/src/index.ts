// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { getEnv } from "@appstrate/env";
import { recordProcessAnomaly } from "@appstrate/core/telemetry";
import { logger } from "./lib/logger.ts";
import { boot } from "./lib/boot.ts";
import { createShutdownHandler } from "./lib/shutdown.ts";
import { requireAppContext } from "./middleware/app-context.ts";
import { requestId } from "./middleware/request-id.ts";
import { telemetry } from "./middleware/telemetry.ts";
import { clientIp } from "./middleware/client-ip.ts";
import { errorHandler } from "./middleware/error-handler.ts";
import { bodyLimit } from "./middleware/body-limit.ts";
import { createAgentsRouter } from "./routes/agents.ts";
import { createRunsRouter } from "./routes/runs.ts";
import { createRunsRemoteRouter } from "./routes/runs-remote.ts";
import { createRunsEventsRouter } from "./routes/runs-events.ts";
import { createSchedulesRouter } from "./routes/schedules.ts";
import { createUserAgentsRouter } from "./routes/user-agents.ts";
import { createApiKeysRouter } from "./routes/api-keys.ts";
import { createProxiesRouter } from "./routes/proxies.ts";
import { createModelsRouter } from "./routes/models.ts";
import { createModelProviderCredentialsRouter } from "./routes/model-provider-credentials.ts";
import { createModelProvidersOAuthRouter } from "./routes/model-providers-oauth.ts";
import { createInternalRouter } from "./routes/internal.ts";
import { createApplicationsRouter } from "./routes/applications.ts";
import { createNotificationsRouter } from "./routes/notifications.ts";
import { createPackagesRouter } from "./routes/packages.ts";
import { createRealtimeRouter } from "./routes/realtime.ts";
import { createEndUsersRouter } from "./routes/end-users.ts";
import { createUploadsRouter, createUploadContentRouter } from "./routes/uploads.ts";
import healthRouter from "./routes/health.ts";
import { createIntegrationsRouter } from "./routes/integrations.ts";
import { createCredentialProxyRouter } from "./routes/credential-proxy.ts";
import { createLlmProxyRouter } from "./routes/llm-proxy.ts";
import { createLibraryRouter } from "./routes/library.ts";
import { createAuthBootstrapRouter } from "./routes/auth-bootstrap.ts";
import orgsRouter from "./routes/organizations.ts";
import meRouter from "./routes/me.ts";
import profileRouter from "./routes/profile.ts";
import invitationsRouter from "./routes/invitations.ts";
import welcomeRouter from "./routes/welcome.ts";
import { createVersionRouter } from "./routes/version.ts";
import { swaggerUI } from "@hono/swagger-ui";
import { buildOpenApiSpec } from "./openapi/index.ts";
import {
  getModulePublicPaths,
  getModuleAuthStrategies,
  getModuleOpenApiPaths,
  getModuleOpenApiComponentSchemas,
  getModuleOpenApiTags,
  registerModuleRoutes,
} from "./lib/modules/module-loader.ts";
import { ApiError, notFound } from "./lib/errors.ts";
import { apiVersion } from "./middleware/api-version.ts";
import { getOrgSettings } from "./services/organizations.ts";
import { getAppConfig, initAppConfig } from "./lib/app-config.ts";
import { applyAuthPipeline, skipAuth } from "./lib/auth-pipeline.ts";
import type { AppEnv } from "./types/index.ts";

// Fail-fast: validate all env vars at startup
const env = getEnv();

const app = new Hono<AppEnv>();

// Error handler — converts ApiError to RFC 9457 application/problem+json
app.onError(errorHandler);

// Request-Id — generates req_ prefixed ID, sets header + context variable
app.use("*", requestId());

// Telemetry — delegates to the telemetry provider's HTTP SERVER-span
// middleware (installed by an observability module at boot, e.g.
// `@appstrate/module-observability`). Registered right after `requestId()` so
// the span — and its bound logger trace context — covers the full handler
// chain. Pass-through no-op when no provider is installed.
app.use("*", telemetry());

// Client IP — captures `getConnInfo(c).remote.address` into a per-Request
// WeakMap so downstream code that only sees the bare `Request` (Better
// Auth plugin endpoints, OIDC strategy) can resolve the IP without
// trusting forwarded headers.
app.use("*", clientIp());

// Middleware
const trustedOrigins = env.TRUSTED_ORIGINS;

app.use("*", cors({ origin: trustedOrigins, credentials: true }));

// Global body-size cap. Skipped for the public FS upload sink — that route
// authenticates via a signed token whose payload encodes its own size limit
// (up to 100 MB by design), enforced while the body streams to disk: the
// signed max replaces this cap and chunked encoding cannot bypass it.
const globalBodyLimit = bodyLimit(env.API_BODY_LIMIT_BYTES);
app.use("*", async (c, next) => {
  if (c.req.path === "/api/uploads/_content") return next();
  return globalBodyLimit(c, next);
});

// Health check — before auth middleware (no auth required)
app.route("/", healthRouter);

// OpenAPI docs — public (before auth middleware)
// Spec is built lazily on first request (after modules are initialized at boot).
let _openApiSpec: ReturnType<typeof buildOpenApiSpec> | null = null;
function getOpenApiSpec() {
  if (!_openApiSpec)
    _openApiSpec = buildOpenApiSpec(
      getModuleOpenApiPaths(),
      getModuleOpenApiComponentSchemas(),
      getModuleOpenApiTags(),
    );
  return _openApiSpec;
}
app.get("/api/openapi.json", (c) => c.json(getOpenApiSpec()));
app.get("/api/docs", swaggerUI({ url: "/api/openapi.json" }));

// Public llms.txt — points AI coding agents at the CLI + OpenAPI entry
// points for this instance. Served at the root so agents crawling
// `https://<instance>/llms.txt` (the emerging /llms.txt convention) find
// the right docs without guessing. Kept inline so the Docker image does
// not need to ship the repo-root markdown file.
const LLMS_TXT = `# Appstrate

> Open-source platform for running autonomous AI agents in sandboxed Docker containers. This instance exposes a REST API documented in OpenAPI 3.1; the \`appstrate\` CLI is the recommended control plane for AI coding agents.

## Control this instance from a coding agent

Install the CLI (\`curl -fsSL https://get.appstrate.dev | bash\` or \`bunx appstrate\`), then:

- \`appstrate login --instance <this-url>\` — RFC 8628 device flow, tokens land in the OS keyring
- \`appstrate openapi list --json\` — discover endpoints without loading the full 191-operation spec
- \`appstrate openapi show <operationId> --json\` — fully dereferenced operation schema for body construction
- \`appstrate api <METHOD> <path>\` — authenticated HTTP passthrough (\`curl\`-compatible), bearer never exposed

## Docs

- [CLI agent quickstart](https://github.com/appstrate/appstrate/blob/main/apps/cli/AGENTS.md): zero-to-first-run recipe, rules of engagement
- [Full CLI reference](https://github.com/appstrate/appstrate/blob/main/apps/cli/README.md): flags, exit codes, profile management
- [OpenAPI spec](/api/openapi.json): live, always current for this instance
- [Interactive API docs](/api/docs): Swagger UI
- [Source repository](https://github.com/appstrate/appstrate): Apache-2.0
`;
app.get("/llms.txt", (c) => c.text(LLMS_TXT));

// Shutdown gate — reject new write requests during graceful shutdown
let shuttingDown = false;

// Every mutating method must be drained, not just POST — a PUT/PATCH/DELETE
// arriving mid-shutdown would otherwise slip past the gate and race the
// in-flight wait, leaving a half-applied write behind.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

app.use("*", async (c, next) => {
  if (shuttingDown && MUTATING_METHODS.has(c.req.method)) {
    throw new ApiError({
      status: 503,
      code: "shutting_down",
      title: "Service Unavailable",
      detail: "Server is shutting down",
    });
  }
  return next();
});

// Bootstrap-token redemption (#344 Layer 2b) — registered BEFORE the
// Better Auth catch-all so the more-specific path wins. This route owns
// its own gate (timing-safe token compare + DB-org-count check) and
// must NOT pass through Better Auth's normal `/api/auth/*` handler.
app.route("/api/auth/bootstrap", createAuthBootstrapRouter());

// Shared auth pipeline — mounts Better Auth handler, installs module
// auth strategies → Bearer API key → cookie session middleware, org
// context, and session permission resolution. The test harness
// (`apps/api/test/helpers/app.ts`) calls the same helper so the two
// cannot drift. Accessors are lazy: this is wired before `await boot()`
// finishes loading modules, so snapshotting here would miss module
// contributions.
applyAuthPipeline(app, {
  publicPaths: getModulePublicPaths,
  authStrategies: getModuleAuthStrategies,
});

// App context middleware: resolve X-Application-Id for app-scoped routes.
// Modules own app-scoping for their own routes (e.g. webhooks gates via an
// explicit `applicationId` body/query field), so the prefix list is core-only.
const APP_SCOPED_PREFIXES = [
  "/api/agents",
  "/api/runs",
  "/api/schedules",
  "/api/end-users",
  "/api/api-keys",
  "/api/notifications",
  "/api/packages",
  "/api/integrations",
  "/api/uploads",
];

const appContextMiddleware = requireAppContext();
app.use("*", async (c, next) => {
  if (skipAuth(c.req.path, getModulePublicPaths(), c.req.raw.headers)) return next();
  if (!c.get("user")) return next();
  if (!APP_SCOPED_PREFIXES.some((p) => c.req.path.startsWith(p))) return next();
  return appContextMiddleware(c, next);
});

// API versioning: resolve Appstrate-Version header > org setting > default.
// Session requests pass through `requireOrgContext`, which loads the org
// settings in the same query as the membership check — read them from
// context instead of hitting the organizations table again on every
// request. Non-session auth (API key, module strategies) resolves orgId
// inline without that middleware, so fall back to the direct lookup there.
const apiVersionMiddleware = apiVersion(async (orgId, c) => {
  const settings = c.get("orgSettings") ?? (await getOrgSettings(orgId));
  return settings.api_version ?? null;
});
app.use("*", async (c, next) => {
  if (skipAuth(c.req.path, getModulePublicPaths(), c.req.raw.headers)) return next();
  if (!c.get("user")) return next();
  return apiVersionMiddleware(c, next);
});

// Boot: load system resources, init services, clean up orphans
await boot();

// Initialize app config (async — modules may contribute structured data like OIDC client ID)
await initAppConfig();

// Build the per-request `<script>` that injects `window.__APP_CONFIG__`.
// Most fields are stable after boot (modules don't load/unload at runtime),
// but `bootstrapTokenPending` flips false the moment the operator claims
// an unattended install via `/api/auth/bootstrap/redeem` (#344). Re-
// stringifying on every SPA request is ~1µs and means the post-claim
// page reload doesn't loop the user back into `/claim`.
import { isBootstrapTokenPending } from "./lib/bootstrap-token.ts";
function buildAppConfigScript(): string {
  const base = getAppConfig();
  const liveConfig = {
    ...base,
    features: { ...base.features, bootstrapTokenPending: isBootstrapTokenPending() },
  };
  return `<script>window.__APP_CONFIG__=${JSON.stringify(liveConfig)};</script>`;
}

// Graceful shutdown
const shutdown = createShutdownHandler(() => {
  shuttingDown = true;
});
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// ── Process-level last-resort net ──────────────────────────────────────────
// Single-process, multi-tenant server: an async error that escapes EVERY
// request try/catch would otherwise crash Bun and take down every tenant. This
// is a BACKSTOP, not a fix — the known offender (an LLM stream teardown that
// rejects after the response is already on the wire) is caught at its source in
// `services/llm-proxy/metering.ts#guardSseTeardown`. A non-zero
// `appstrate.process.anomaly` rate under normal load signals a NEW escape to
// chase upstream, not a healthy steady state.
const UNCAUGHT_DRAIN_CEILING_MS = 35_000;
let crashing = false;

function formatProcessError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

// A rejected promise leaves the event loop intact — log, meter, keep serving
// the other tenants. (Node's default since v15 would crash here.)
process.on("unhandledRejection", (reason) => {
  recordProcessAnomaly({ kind: "unhandledRejection" });
  logger.error("Unhandled promise rejection (kept alive)", {
    kind: "unhandledRejection",
    error: formatProcessError(reason),
  });
});

// A thrown exception that unwound to the top leaves the process in an undefined
// state — crash-only per Node guidance. Drain in-flight runs gracefully, then
// let the supervisor restart a clean process; force-exit if the drain hangs.
process.on("uncaughtException", (err, origin) => {
  recordProcessAnomaly({ kind: "uncaughtException" });
  logger.error("Uncaught exception (shutting down)", {
    kind: "uncaughtException",
    origin,
    error: formatProcessError(err),
  });
  if (crashing) return;
  crashing = true;
  const force = setTimeout(() => process.exit(1), UNCAUGHT_DRAIN_CEILING_MS);
  force.unref();
  void shutdown();
});

// Routes
const userAgentsRouter = createUserAgentsRouter();
const agentsRouter = createAgentsRouter();
const runsRouter = createRunsRouter();
const schedulesRouter = createSchedulesRouter();

// Organization routes (no org context needed — self-managed auth)
app.route("/api/orgs", orgsRouter);

// User-scoped identity routes — `/api/me/orgs` skips `requireOrgContext`
// (it is the prerequisite to setting `X-Org-Id`); `/api/me/models` runs
// inside org context.
app.route("/api/me", meRouter);

app.route("/api/agents", userAgentsRouter); // Must be before agentsRouter (import/delete routes)
app.route("/api/agents", agentsRouter);
app.route("/api", createNotificationsRouter()); // Must be before runsRouter (GET /api/runs vs /api/runs/:id)
// Unified-runner event ingestion — HMAC-authenticated, no user principal.
// Mounted BEFORE runsRouter so the more-specific `/runs/:runId/events` path
// matches without falling through to `GET /runs/:id`. Path-pattern `skipAuth`
// bypass is declared in `lib/auth-pipeline.ts` so these never pass through
// the cookie/API-key auth layer.
app.route("/api", createRunsEventsRouter());
app.route("/api", createRunsRemoteRouter());
app.route("/api", runsRouter);
app.route("/api", schedulesRouter);
app.route("/api/packages", createPackagesRouter());
app.route("/api/end-users", createEndUsersRouter());
// Upload content sink MUST be registered BEFORE /api/uploads — more specific path first.
// Public path (no auth middleware — authenticated via HMAC token), rate-limited.
app.route("/api/uploads/_content", createUploadContentRouter());
app.route("/api/uploads", createUploadsRouter());
app.route("/api/api-keys", createApiKeysRouter());
app.route("/api/proxies", createProxiesRouter());
app.route("/api/models", createModelsRouter());
app.route("/api/model-provider-credentials", createModelProviderCredentialsRouter());
app.route("/api/model-providers-oauth", createModelProvidersOAuthRouter());
app.route("/api/applications", createApplicationsRouter());
app.route("/api/library", createLibraryRouter());
app.route("/api", profileRouter);
app.route("/api/realtime", createRealtimeRouter());
app.route("/api/integrations", createIntegrationsRouter());
app.route("/api/credential-proxy", createCredentialProxyRouter());
app.route("/api/llm-proxy", createLlmProxyRouter());

// Public invitation routes (no auth required — path doesn't start with /api/ or /auth/)
app.route("/invite", invitationsRouter);

// Welcome route (authenticated, cookie-based — org context not required)
app.route("/api", welcomeRouter);

// Version + update availability (authenticated — org context not required)
app.route("/api", createVersionRouter());

// Internal routes (container-to-host, auth via run token — no JWT)
const internalRouter = createInternalRouter();
app.route("/internal", internalRouter);

// Module routes — mounted at root. Modules declare full paths (typically
// `/api/<name>/*` for business endpoints, plus `/.well-known/*` for any
// RFC-specified well-known URI). MUST be mounted BEFORE the SPA `/*`
// catch-all below, otherwise the static fallback shadows module paths.
// No-op when no module exposes `createRouter()`.
registerModuleRoutes(app);

// Unknown /api/* → 404 problem+json. Without this the SPA fallback below would
// match every unknown API path and return index.html with a 200, breaking
// pass-through clients (CLI, curl, SDKs).
app.all("/api/*", (c) => {
  const pathname = new URL(c.req.url).pathname;
  throw notFound(`API endpoint not found: ${c.req.method} ${pathname}`);
});

// Static files for UI (JS, CSS, images, fonts — skip index.html, served with config below)
app.use(
  "/*",
  serveStatic({
    root: "./apps/web/dist",
    rewriteRequestPath: (path) => (path === "/" || path === "/index.html" ? "/.noop" : path),
  }),
);

// SPA fallback — serve index.html with injected app config for all non-asset routes.
// Read fresh each time: Vite build --watch rewrites index.html with new asset hashes.
app.get("/*", async (c) => {
  const raw = await Bun.file("./apps/web/dist/index.html").text();
  return c.html(raw.replace("</head>", `${buildAppConfigScript()}\n</head>`));
});

// Start server — bind 0.0.0.0 so both IPv4 and IPv6 clients can connect
export default {
  port: env.PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
  idleTimeout: 255,
};

logger.info("Server started", { port: env.PORT });

// Proxy-upload diagnosability (issue #829): with S3 storage and no
// S3_PUBLIC_ENDPOINT, upload URLs are signed against APP_URL and the browser
// PUTs the bytes there. If APP_URL is still a loopback address on a remotely
// reached production instance, every remote browser PUTs uploads at ITS OWN
// machine — the request never reaches this server, so nothing is logged and
// the failure is otherwise invisible server-side. Warn loudly at boot.
if (
  env.NODE_ENV === "production" &&
  env.S3_BUCKET &&
  !env.S3_PUBLIC_ENDPOINT &&
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(env.APP_URL)
) {
  logger.warn(
    "S3 storage is in proxy-upload mode (S3_PUBLIC_ENDPOINT unset) but APP_URL is a loopback address. " +
      "Browsers reaching this instance over the network will PUT uploads to their own machine and fail " +
      "without any server-side trace. Set APP_URL to this instance's public URL, or set " +
      "S3_PUBLIC_ENDPOINT to presign direct-to-bucket upload URLs instead.",
    { appUrl: env.APP_URL },
  );
}

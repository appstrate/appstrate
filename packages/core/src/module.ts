// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate Module System — contract types.
 *
 * Published in @appstrate/core so that external modules (e.g. @appstrate/cloud)
 * can implement the interface without depending on the API package.
 *
 * Hono is the only framework dependency — all Appstrate modules must provide
 * Hono routers. It is declared as an optional peer dependency.
 */

import type { Hono } from "hono";

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

/** Metadata describing a module. */
export interface ModuleManifest {
  /** Unique identifier (e.g. "cloud", "oidc"). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Semantic version. */
  version: string;
  /** Module IDs this module depends on (loaded first). */
  dependencies?: string[];
}

/**
 * The contract every Appstrate module must implement.
 *
 * Lifecycle: resolve -> init -> createRouter -> (running) -> shutdown
 */
export interface AppstrateModule {
  manifest: ModuleManifest;

  /**
   * Called once at boot. Must initialize internal state (DB client, migrations, etc.).
   * Any error is treated as a fatal init failure — all declared modules are required.
   */
  init(ctx: ModuleInitContext): Promise<void>;

  /** Paths that bypass auth middleware (e.g. webhook endpoints). */
  publicPaths?: string[];

  /**
   * Create and return a Hono router to be mounted on the app under `/api`.
   * The platform calls `app.route("/api", router)` with the returned instance.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createRouter?(): Hono<any>;

  /**
   * Contribute to the frontend AppConfig (feature flags, legal URLs, etc.).
   *
   * Return a **partial overlay** — only the keys you want to add or override.
   * The platform deep-merges your return value onto the accumulated config.
   * Do NOT spread `...base` — just return the delta.
   *
   * `base` is provided for read-only inspection (e.g. conditional flags).
   *
   * @example return { features: { billing: true }, legalUrls: { terms: "..." } }
   */
  extendAppConfig?(base: Record<string, unknown>): Record<string, unknown>;

  /**
   * Named hooks (first-match-wins).
   * The platform invokes hooks by name — only the first module that provides
   * a given hook is called. For broadcast-to-all semantics, use `events`.
   */
  hooks?: Partial<ModuleHooks>;

  /**
   * Named event handlers (broadcast-to-all).
   * Unlike hooks, events are emitted to ALL modules that listen for them.
   * Errors in individual handlers are isolated — they don't block other modules.
   */
  events?: Partial<ModuleEvents>;

  /**
   * Email template overrides (e.g. branded versions for Cloud).
   * Collected after init and merged into the email registry.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emailOverrides?: Record<string, any>;

  /** Called during graceful shutdown (reverse init order). */
  shutdown?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook & event type maps — the typed contract
// ---------------------------------------------------------------------------

/** Known hooks and their signatures. */
export interface ModuleHooks {
  /** Pre-run gate — return a rejection to block the run, or null/undefined to allow. */
  beforeRun: (params: BeforeRunParams) => Promise<RunRejection | null>;
  /** Pre-signup gate — throw to reject signup (e.g. domain allowlist). */
  beforeSignup: (email: string) => Promise<void>;
}

/** Known events and their signatures. */
export interface ModuleEvents {
  /** Post-run notification — broadcast to all modules after a run completes. */
  afterRun: (params: AfterRunParams) => Promise<void>;
  /** Org created — broadcast after a new organization is created. */
  onOrgCreated: (orgId: string, userEmail: string) => Promise<void>;
  /** Org deleted — broadcast before an organization is deleted. */
  onOrgDeleted: (orgId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Lifecycle hook types — shared between platform and modules
// ---------------------------------------------------------------------------

/** Parameters passed to the `beforeRun` hook. */
export interface BeforeRunParams {
  orgId: string;
  agentId: string;
  runningCount: number;
}

/** Structured rejection returned by `beforeRun` when a module blocks a run. */
export interface RunRejection {
  code: string;
  message: string;
  /** HTTP status hint (e.g. 402 for payment required, 429 for rate limit). Defaults to 403. */
  status?: number;
}

/** Parameters passed to the `afterRun` event. */
export interface AfterRunParams {
  orgId: string;
  runId: string;
  agentId: string;
  applicationId: string;
  status: "success" | "failed" | "timeout";
  cost: number;
  duration: number;
  modelSource: string | null;
}

// ---------------------------------------------------------------------------
// Init context — platform services injected into modules
// ---------------------------------------------------------------------------

export interface ModuleInitContext {
  /** PostgreSQL connection string, or null in PGlite mode. */
  databaseUrl: string | null;
  /** Redis connection string, or null when Redis is absent. */
  redisUrl: string | null;
  /** Public-facing URL of the platform (for OAuth callbacks, etc.). */
  appUrl: string;
  /** Whether running in embedded DB mode (PGlite). */
  isEmbeddedDb: boolean;
  /** Lazy email sender (breaks circular deps at module load time). */
  getSendMail: () => Promise<(to: string, subject: string, html: string) => void>;
  /** Query helper: get org admin emails. */
  getOrgAdminEmails: (orgId: string) => Promise<string[]>;
}

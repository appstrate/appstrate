// SPDX-License-Identifier: Apache-2.0

import type { Hono } from "hono";
import type { AppEnv } from "../../types/index.ts";
import type { AppConfig } from "@appstrate/shared-types";
import type { EmailType, EmailRenderer } from "@appstrate/emails";

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
 * Lifecycle: resolve -> init -> registerRoutes -> (running) -> shutdown
 */
export interface AppstrateModule {
  manifest: ModuleManifest;

  /**
   * Called once at boot. Must initialize internal state (DB client, migrations, etc.).
   * Throw `SkipModuleError` to gracefully skip (e.g. missing dependency, PGlite mode).
   * Any other error is treated as a fatal init failure.
   */
  init(ctx: ModuleInitContext): Promise<void>;

  /** Paths that bypass auth middleware (e.g. webhook endpoints). */
  publicPaths?: string[];

  /** Mount routes onto the Hono app. Called after all modules are initialized. */
  registerRoutes?(app: Hono<AppEnv>): void;

  /**
   * Contribute to the frontend AppConfig (feature flags, legal URLs, etc.).
   * Returns a partial overlay that is deep-merged onto the base config.
   */
  extendAppConfig?(base: AppConfig): Partial<AppConfig>;

  /**
   * Lifecycle hooks that other parts of the platform can invoke.
   * Callers access hooks via typed helpers in `hooks.ts`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hooks?: Record<string, (...args: any[]) => any>;

  /** Called during graceful shutdown (reverse init order). */
  shutdown?(): Promise<void>;
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
  /** Register email template overrides. */
  registerEmailOverrides: (overrides: Partial<{ [K in EmailType]: EmailRenderer<K> }>) => void;
  /** Register a Better Auth before-signup hook. */
  setBeforeSignupHook: (hook: (email: string) => void) => void;
}

// ---------------------------------------------------------------------------
// Module entry — used in the registry
// ---------------------------------------------------------------------------

export interface ModuleEntry {
  /** The module instance (adapter or native). */
  module: AppstrateModule;
  /** If true, init failure crashes the platform instead of skipping. */
  required?: boolean;
}

// ---------------------------------------------------------------------------
// Skip error
// ---------------------------------------------------------------------------

/**
 * Throw from `init()` to gracefully skip a module.
 * The loader catches this specific class and logs at debug level.
 */
export class SkipModuleError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SkipModuleError";
  }
}

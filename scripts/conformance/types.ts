// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the system-package conformance harness.
 *
 * The harness connects to / spawns each system package "for real" and
 * verifies that its declared surface (tools, scopes, auth) matches what the
 * server actually exposes. Findings are collected across class-specific
 * handlers and rendered by `report.ts`.
 */

/** Severity of a single conformance finding. */
export type Severity = "fail" | "warn" | "info";

/**
 * Behavioural class of a system package — drives which handler runs.
 *
 *   - `mcp-server-local`  → `type: "mcp-server"`, spawned over stdio (deterministic).
 *   - `mcp-remote`        → `type: "integration"`, `source.kind: "remote"` (3rd-party MCP).
 *   - `integration-cred`  → `type: "integration"`, `source.kind: "none"` (credential-only proxy).
 *   - `other`             → agents, skills, etc. — no live surface, static only.
 */
export type PackageClass = "mcp-server-local" | "mcp-remote" | "integration-cred" | "other";

/** A single conformance result for one package + check. */
export interface Finding {
  /** Canonical package id, e.g. "@appstrate/github-git-mcp". */
  packageId: string;
  /** Check that produced this finding, e.g. "mcp-local-parity". */
  check: string;
  severity: Severity;
  message: string;
}

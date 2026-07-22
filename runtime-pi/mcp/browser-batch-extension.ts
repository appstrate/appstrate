// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Agent-side Pi extension for the `desktop_batch` tool.
 *
 * The LLM manipulates a REFERENCE (a workspace file path, typically
 * inside a mounted skill) — the tool manipulates the content. Same
 * house pattern as `api_upload` (fromFile) and `desktop_download`
 * (returns a path): the frozen step list never enters the LLM context,
 * so it cannot be deformed and costs no tokens.
 *
 * Flow: read `steps_file` from the workspace (traversal-guarded) →
 * fill `{name}` placeholders from `variables` (single braces —
 * distinct from the `{{field}}` CREDENTIAL placeholders, which the
 * PLATFORM resolves per step when `substitute_params` is set) →
 * dispatch the whole list through the sidecar's `desktop_browser`
 * `browser.batch` in one round-trip.
 *
 * Routed by `direct.ts` from the `dev.appstrate/desktop-batch` `_meta`
 * marker on the sidecar-advertised descriptor.
 */

import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Type, type ExtensionAPI, type ExtensionFactory } from "../pi-sdk.ts";
import type { AppstrateMcpClient } from "@appstrate/mcp-transport";

const VARIABLE_PLACEHOLDER = /\{([\w.-]+)\}/g;

export interface BuildBrowserBatchFactoryOptions {
  /** The advertised `desktop_batch` tool from the sidecar's `tools/list`. */
  tool: { name: string; description?: string; inputSchema?: unknown };
  mcp: AppstrateMcpClient;
  /** Workspace root `steps_file` is resolved against (symlink-safe). */
  workspace: string;
}

/**
 * Fill `{name}` placeholders in every string of `value`. `{{field}}`
 * credential placeholders survive untouched: the double-brace form
 * never matches a single-brace name capture that starts with `{`.
 */
export function fillVariables(value: unknown, variables: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(VARIABLE_PLACEHOLDER, (match, key: string, offset: number) => {
      // Skip `{{field}}` credential placeholders: they present as a
      // `{field}` match preceded by `{` (or followed by `}`), and they
      // belong to the PLATFORM's substitution pass, not this one.
      const prev = offset > 0 ? value[offset - 1] : "";
      const next = value[offset + match.length] ?? "";
      if (prev === "{" || next === "}") return match;
      return key in variables ? variables[key]! : match;
    });
  }
  if (Array.isArray(value)) return value.map((v) => fillVariables(v, variables));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fillVariables(v, variables);
    return out;
  }
  return value;
}

async function callBridge(
  mcp: AppstrateMcpClient,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const res = await mcp.callTool(
    { name: "desktop_browser", arguments: args },
    { signal, timeoutMs: 150_000 },
  );
  const text = (res.content as Array<{ type?: string; text?: string }> | undefined)
    ?.filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  if (res.isError) throw new Error(text || "desktop_browser failed");
  try {
    return (JSON.parse(text ?? "") as { result?: unknown }).result;
  } catch {
    throw new Error(`desktop_browser: unparseable reply: ${(text ?? "").slice(0, 200)}`);
  }
}

export function buildBrowserBatchToolFactory(
  opts: BuildBrowserBatchFactoryOptions,
): ExtensionFactory[] {
  return [
    (pi: ExtensionAPI) => {
      pi.registerTool({
        name: opts.tool.name,
        label: opts.tool.name,
        description:
          opts.tool.description ??
          "Run a frozen desktop_browser step sequence from a workspace file in one round-trip.",
        parameters: Type.Unsafe<Record<string, unknown>>(
          (opts.tool.inputSchema as Record<string, unknown>) ?? {
            type: "object",
            additionalProperties: false,
            required: ["steps_file"],
            properties: {
              steps_file: { type: "string" },
              variables: { type: "object", additionalProperties: { type: "string" } },
              integration_id: { type: "string" },
              substitute_params: { type: "boolean" },
              timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
            },
          },
        ),
        async execute(_toolCallId, params, signal) {
          const args = (params ?? {}) as {
            steps_file?: string;
            variables?: Record<string, string>;
            integration_id?: string;
            substitute_params?: boolean;
            timeout_ms?: number;
          };
          const fail = (text: string) => ({
            content: [{ type: "text" as const, text: `desktop_batch: ${text}` }],
            details: undefined,
            isError: true,
          });
          if (!args.steps_file) return fail("missing steps_file");

          const target = resolve(join(opts.workspace, args.steps_file));
          if (!target.startsWith(resolve(opts.workspace) + sep)) {
            return fail(`refusing path outside the workspace: ${args.steps_file}`);
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(await readFile(target, "utf-8"));
          } catch (err) {
            return fail(
              `cannot read ${args.steps_file}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          const steps = Array.isArray(parsed)
            ? parsed
            : ((parsed as { steps?: unknown[] } | null)?.steps ?? null);
          if (!Array.isArray(steps) || steps.length === 0) {
            return fail(`${args.steps_file} must hold {"steps": [...]} (or a bare array)`);
          }
          const filled = args.variables ? fillVariables(steps, args.variables) : steps;

          try {
            const result = await callBridge(
              opts.mcp,
              {
                method: "browser.batch",
                params: { steps: filled },
                ...(args.integration_id !== undefined
                  ? { integration_id: args.integration_id }
                  : {}),
                ...(args.substitute_params !== undefined
                  ? { substitute_params: args.substitute_params }
                  : {}),
                ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
              },
              signal ?? new AbortController().signal,
            );
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              details: undefined,
              isError: false,
            };
          } catch (err) {
            return fail(err instanceof Error ? err.message : String(err));
          }
        },
      });
    },
  ];
}

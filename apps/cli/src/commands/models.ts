// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate models` — discover model presets exposed by the pinned
 * Appstrate instance. Counterpart to `/api/llm-proxy/<api>/…`: the CLI
 * references presets by id, the platform injects upstream credentials.
 *
 * Subcommands:
 *   models list  — enumerate presets (id, api, label, defaults, cost)
 */

import { resolveActiveProfile, requireLoggedIn } from "../lib/config.ts";
import { listModelPresets, PROXY_SUPPORTED_APIS } from "../lib/models.ts";
import { exitWithError } from "../lib/ui.ts";

export interface ModelsListOptions {
  profile?: string;
  /** Emit machine-readable JSON instead of the human table. */
  json?: boolean;
  /** Only list presets wired on `/api/llm-proxy/*` (filters by protocol family). */
  proxyOnly?: boolean;
}

export async function modelsListCommand(opts: ModelsListOptions): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  requireLoggedIn(profileName, profile);

  try {
    let models = await listModelPresets(profileName);
    if (opts.proxyOnly) {
      models = models.filter((m) => PROXY_SUPPORTED_APIS.has(m.apiShape));
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify(models, null, 2) + "\n");
      return;
    }

    if (models.length === 0) {
      process.stdout.write("(no models)\n");
      return;
    }

    for (const m of models) {
      const suffixes: string[] = [];
      if (m.isDefault) suffixes.push("default");
      if (!m.enabled) suffixes.push("disabled");
      if (!PROXY_SUPPORTED_APIS.has(m.apiShape)) suffixes.push("proxy-unsupported");
      const suffix = suffixes.length > 0 ? ` [${suffixes.join(", ")}]` : "";
      process.stdout.write(`  ${m.id.padEnd(36)}  ${m.apiShape.padEnd(24)}  ${m.label}${suffix}\n`);
    }
  } catch (err) {
    exitWithError(err);
  }
}

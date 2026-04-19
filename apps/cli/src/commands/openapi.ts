// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate openapi` — explore the active profile's OpenAPI schema
 * without piping the full spec (~191 endpoints) through stdout.
 *
 * Three subcommands:
 *
 *   list    compact index, filterable by --tag, --method, --path,
 *           --search. Default sink is stdout as colored text; --json
 *           emits a minimal JSON array for agents.
 *
 *   show    detailed view of one operation, identified by either
 *           `operationId` or `METHOD /path`. Uses swagger-parser to
 *           dereference `$ref`s so response/parameter schemas are
 *           inlined. --json emits the full dereferenced operation.
 *
 *   export  dump the raw schema to stdout or a file (-o). The escape
 *           hatch — equivalent to `appstrate api GET /api/openapi.json`
 *           but via the cached copy.
 *
 * Shared flags:
 *   --no-cache  ephemeral fetch, no read + no write
 *   --refresh   skip read, re-download, update cache
 *
 * Error surface:
 *   - AuthError / network errors bubble up and render via formatError.
 *   - Unknown subcommand → Commander handles (exit 1).
 *   - Unmatched filters → stdout message, exit 0 (not an error: users
 *     iterate).
 *   - `show` with no match → stderr error + exit 1 (the user asked for
 *     a specific thing and got nothing).
 */

import { Command } from "commander";
import { resolveProfileName, readConfig } from "../lib/config.ts";
import { formatError } from "../lib/ui.ts";
import { fetchOpenApi, type OpenApiDocument } from "../lib/openapi-cache.ts";
import {
  collectOperations,
  filterOperations,
  findOperation,
  formatList,
  formatShow,
  toListJson,
} from "../lib/openapi-format.ts";
import { writeFile } from "node:fs/promises";
import SwaggerParser from "@apidevtools/swagger-parser";

export interface OpenapiCommandBaseOptions {
  profile?: string;
  noCache?: boolean;
  refresh?: boolean;
}

export interface OpenapiListOptions extends OpenapiCommandBaseOptions {
  tag?: string;
  method?: string;
  path?: string;
  search?: string;
  json?: boolean;
}

export interface OpenapiShowOptions extends OpenapiCommandBaseOptions {
  json?: boolean;
}

export interface OpenapiExportOptions extends OpenapiCommandBaseOptions {
  output?: string;
}

/**
 * Shared resolver — returns the fetched schema for the active profile.
 * Factored out so all three subcommand handlers look identical up to
 * the profile-name bootstrap, no duplication.
 */
async function loadSchema(opts: OpenapiCommandBaseOptions): Promise<OpenApiDocument> {
  const config = await readConfig();
  const profileName = resolveProfileName(opts.profile, config);
  return fetchOpenApi(profileName, {
    noCache: opts.noCache,
    refresh: opts.refresh,
  });
}

/**
 * Default color detection: respect `NO_COLOR` (https://no-color.org),
 * `FORCE_COLOR`, and fall back to TTY. `process.stdout.isTTY` is
 * `undefined` under Bun test runners, which correctly evaluates to
 * "not a TTY" — tests see plain output by default.
 */
function detectColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout.isTTY);
}

export async function openapiListCommand(opts: OpenapiListOptions): Promise<void> {
  try {
    const doc = await loadSchema(opts);
    const entries = collectOperations(doc);
    const filtered = filterOperations(entries, {
      tag: opts.tag,
      method: opts.method,
      path: opts.path,
      search: opts.search,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(toListJson(filtered), null, 2) + "\n");
      return;
    }
    process.stdout.write(formatList(filtered, detectColor()));
  } catch (err) {
    process.stderr.write(formatError(err) + "\n");
    process.exit(1);
  }
}

export async function openapiShowCommand(
  identifier: string,
  pathArg: string | undefined,
  opts: OpenapiShowOptions,
): Promise<void> {
  try {
    const doc = await loadSchema(opts);
    const entry = findOperation(doc, identifier, pathArg);
    if (!entry) {
      const hint = pathArg
        ? `No operation matches "${identifier} ${pathArg}".`
        : `No operation matches "${identifier}" (tried operationId, then "METHOD /path").`;
      process.stderr.write(
        `${hint}\nTip: run \`appstrate openapi list\` to see available operations.\n`,
      );
      process.exit(1);
      return;
    }
    // Dereference $refs so parameter/request/response schemas are
    // inlined. SwaggerParser mutates a copy; we feed it the doc and
    // it returns the dereferenced tree. Failures fall back to the raw
    // operation (the summary renderer handles $ref stubs gracefully).
    let dereferenced: OpenApiDocument = doc;
    try {
      // SwaggerParser.dereference accepts `string | OpenAPI.Document`;
      // we pass our own narrower OpenApiDocument through `unknown` to
      // satisfy its openapi-types signature without pulling the
      // openapi-types package into our type surface.
      const result = (await SwaggerParser.dereference(
        doc as unknown as Parameters<typeof SwaggerParser.dereference>[0],
      )) as unknown;
      if (result && typeof result === "object") {
        dereferenced = result as OpenApiDocument;
      }
    } catch {
      // swallow — renderer copes with refs it can't resolve
    }
    // Re-resolve the entry against the dereferenced doc so nested
    // $refs (especially deeply nested response schemas) are expanded.
    const derefEntry = findOperation(dereferenced, identifier, pathArg) ?? entry;

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            method: derefEntry.method.toUpperCase(),
            path: derefEntry.path,
            operation: derefEntry.op,
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }
    process.stdout.write(formatShow(derefEntry, detectColor()));
  } catch (err) {
    process.stderr.write(formatError(err) + "\n");
    process.exit(1);
  }
}

export async function openapiExportCommand(opts: OpenapiExportOptions): Promise<void> {
  try {
    const doc = await loadSchema(opts);
    const payload = JSON.stringify(doc, null, 2);
    if (opts.output) {
      await writeFile(opts.output, payload + "\n", { mode: 0o600 });
      process.stderr.write(`Wrote ${payload.length} bytes to ${opts.output}\n`);
      return;
    }
    process.stdout.write(payload + "\n");
  } catch (err) {
    process.stderr.write(formatError(err) + "\n");
    process.exit(1);
  }
}

/**
 * Register the `openapi` command on a Commander `program` instance.
 * Exported for `cli.ts` — avoids making `cli.ts` aware of the three
 * subcommands individually.
 */
export function registerOpenapiCommand(
  program: Command,
  globalProfile: () => string | undefined,
): Command {
  const openapi = program
    .command("openapi")
    .description(
      "Explore the API's OpenAPI schema for the active profile.\n" +
        "Subcommands: list (filterable index), show (single operation), export (raw dump).",
    );

  openapi
    .command("list")
    .description("List operations. Filter with --tag, --method, --path (glob), --search.")
    .option("--tag <tag>", "Filter by OpenAPI tag (case-insensitive).")
    .option("--method <m>", "Filter by HTTP method (GET/POST/...).")
    .option(
      "--path <pattern>",
      "Filter by path. Supports `*` (single segment) and `**` (any). Exact match otherwise.",
    )
    .option(
      "--search <query>",
      "Substring match across operationId, summary, description, path, method.",
    )
    .option("--json", "Emit a minimal JSON array instead of text.")
    .option("--no-cache", "Skip the on-disk cache entirely (no read, no write).")
    .option("--refresh", "Force a fresh fetch; still update the cache on success.")
    .action(async (opts: Record<string, unknown>) => {
      await openapiListCommand({
        profile: globalProfile(),
        tag: typeof opts.tag === "string" ? opts.tag : undefined,
        method: typeof opts.method === "string" ? opts.method : undefined,
        path: typeof opts.path === "string" ? opts.path : undefined,
        search: typeof opts.search === "string" ? opts.search : undefined,
        json: opts.json === true,
        // Commander turns `--no-cache` into `cache: false`. Normalize.
        noCache: opts.cache === false,
        refresh: opts.refresh === true,
      });
    });

  openapi
    .command("show <identifier> [path]")
    .description(
      "Show one operation by `operationId` OR `METHOD /path`.\n" +
        "Examples: appstrate openapi show createRun\n" +
        "          appstrate openapi show GET /api/runs",
    )
    .option("--json", "Emit the full dereferenced operation as JSON.")
    .option("--no-cache", "Skip the on-disk cache entirely (no read, no write).")
    .option("--refresh", "Force a fresh fetch; still update the cache on success.")
    .action(
      async (identifier: string, pathArg: string | undefined, opts: Record<string, unknown>) => {
        await openapiShowCommand(identifier, pathArg, {
          profile: globalProfile(),
          json: opts.json === true,
          noCache: opts.cache === false,
          refresh: opts.refresh === true,
        });
      },
    );

  openapi
    .command("export")
    .description("Dump the raw OpenAPI schema. Writes to <file> with -o, else stdout.")
    .option("-o, --output <file>", "Write the schema to this file (default: stdout).")
    .option("--no-cache", "Skip the on-disk cache entirely (no read, no write).")
    .option("--refresh", "Force a fresh fetch; still update the cache on success.")
    .action(async (opts: Record<string, unknown>) => {
      await openapiExportCommand({
        profile: globalProfile(),
        output: typeof opts.output === "string" ? opts.output : undefined,
        noCache: opts.cache === false,
        refresh: opts.refresh === true,
      });
    });

  return openapi;
}

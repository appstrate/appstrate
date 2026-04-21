// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { Bundle, ProviderRef, ProviderResolver, Tool } from "./types.ts";
import {
  makeProviderTool,
  readProviderMeta,
  type ProviderCallFn,
  type ProviderCallResponse,
  type ProviderMeta,
} from "./provider-tool.ts";

export interface LocalCredentialsFile {
  version: number;
  providers: Record<
    string,
    {
      fields: Record<string, string>;
      /** How credentials are injected into outgoing requests. */
      injection?: {
        headerName?: string;
        headerPrefix?: string;
        template?: string;
      };
    }
  >;
}

export interface LocalProviderResolverOptions {
  /**
   * Either a path to a credentials JSON file or an already-parsed
   * credentials object. The path form is resolved lazily on the first
   * `resolve()` call so the resolver can be constructed in code that
   * cannot do filesystem IO (tests).
   */
  creds: string | LocalCredentialsFile;
  /** Override the low-level HTTP client. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Directory prefix for provider manifests in the bundle. */
  providerPrefix?: string;
}

/**
 * {@link ProviderResolver} that reads credentials from a local JSON file
 * and makes direct HTTP calls to the upstream provider. Intended for
 * CLI / offline runs — there is no refresh logic, no audit log, and no
 * rotation. Tokens expire, dev re-authenticates manually.
 */
export class LocalProviderResolver implements ProviderResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly providerPrefix: string;
  private creds: LocalCredentialsFile | null;
  private readonly credsPath: string | null;

  constructor(opts: LocalProviderResolverOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.providerPrefix = opts.providerPrefix ?? ".agent-package/providers/";
    if (typeof opts.creds === "string") {
      this.creds = null;
      this.credsPath = opts.creds;
    } else {
      this.creds = opts.creds;
      this.credsPath = null;
    }
  }

  async resolve(refs: ProviderRef[], bundle: Bundle): Promise<Tool[]> {
    const creds = await this.loadCreds();
    const tools: Tool[] = [];
    for (const ref of refs) {
      const meta = await readProviderMeta(bundle, ref, this.providerPrefix, false);
      const entry = creds.providers[ref.name];
      if (!entry) {
        throw new Error(
          `LocalProviderResolver: no credentials found for ${ref.name} in the local creds file`,
        );
      }
      tools.push(makeProviderTool(meta, this.buildCall(meta, entry)));
    }
    return tools;
  }

  private async loadCreds(): Promise<LocalCredentialsFile> {
    if (this.creds !== null) return this.creds;
    if (this.credsPath === null) {
      throw new Error("LocalProviderResolver: creds was neither a parsed object nor a path");
    }
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(this.credsPath, "utf8");
    this.creds = JSON.parse(raw) as LocalCredentialsFile;
    return this.creds;
  }

  private buildCall(
    meta: ProviderMeta,
    entry: LocalCredentialsFile["providers"][string],
  ): ProviderCallFn {
    return async (req) => {
      const target = substitutePlaceholders(req.target, entry.fields);
      const headers = { ...(req.headers ?? {}) };
      for (const [key, value] of Object.entries(headers)) {
        headers[key] = substitutePlaceholders(value, entry.fields);
      }
      applyCredentialInjection(headers, entry);

      const bodyBytes = await resolveBodyStream(req.body, entry.fields);

      const res = await this.fetchImpl(target, {
        method: req.method,
        headers,
        body: bodyBytes,
      });

      const respHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        respHeaders[key] = value;
      });
      const text = await res.text();
      const response: ProviderCallResponse = {
        status: res.status,
        headers: respHeaders,
        body: { inline: text, inlineEncoding: "utf8" },
      };
      void meta;
      return response;
    };
  }
}

function substitutePlaceholders(input: string, fields: Record<string, string>): string {
  return input.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => fields[key] ?? "");
}

function applyCredentialInjection(
  headers: Record<string, string>,
  entry: LocalCredentialsFile["providers"][string],
): void {
  const injection = entry.injection;
  if (!injection) return;
  const rendered = injection.template
    ? substitutePlaceholders(injection.template, entry.fields)
    : (entry.fields.api_key ?? entry.fields.access_token);
  if (!rendered) return;
  const headerName = injection.headerName ?? "Authorization";
  const headerPrefix = injection.headerPrefix ?? "";
  headers[headerName] = `${headerPrefix}${rendered}`;
}

async function resolveBodyStream(
  body: string | Uint8Array | null | { fromFile: string } | undefined,
  fields: Record<string, string>,
): Promise<string | Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return substitutePlaceholders(body, fields);
  if (body instanceof Uint8Array) return body;
  if ("fromFile" in body) {
    const fs = await import("node:fs/promises");
    return new Uint8Array(await fs.readFile(body.fromFile));
  }
  return undefined;
}

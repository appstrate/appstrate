// SPDX-License-Identifier: Apache-2.0

import type { BrowserProviderId, BrowserProviderProxy } from "@appstrate/core/sidecar-types";
import { getEnv } from "@appstrate/env";

function isValidProxyHost(host: string): boolean {
  return (
    host.length > 0 &&
    host.length <= 253 &&
    !/[/?#@]/u.test(host) &&
    ![...host].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    })
  );
}

/** Snapshot operator routing onto a connection so future runs stay stable. */
export function resolveBrowserProviderProxy(
  provider: BrowserProviderId,
): BrowserProviderProxy | undefined {
  if (provider === "process") return undefined;
  const env = getEnv();
  const host = env.BROWSER_USE_CLOUD_CUSTOM_PROXY_HOST?.trim();
  const port = env.BROWSER_USE_CLOUD_CUSTOM_PROXY_PORT;
  const username = env.BROWSER_USE_CLOUD_CUSTOM_PROXY_USERNAME;
  const password = env.BROWSER_USE_CLOUD_CUSTOM_PROXY_PASSWORD;
  if (host || port || username || password) {
    if (!host || !isValidProxyHost(host) || !port) {
      throw new Error("Browser Use custom proxy requires a valid host and port");
    }
    if ((username === undefined) !== (password === undefined)) {
      throw new Error("Browser Use custom proxy username and password must be set together");
    }
    if (
      username !== undefined &&
      (username.length === 0 ||
        username.length > 512 ||
        password!.length === 0 ||
        password!.length > 4096)
    ) {
      throw new Error("Browser Use custom proxy credentials are invalid");
    }
    if (env.BROWSER_USE_CLOUD_PROXY_COUNTRY) {
      throw new Error("Browser Use country and custom proxy routing cannot be combined");
    }
    return {
      kind: "custom",
      host,
      port,
      ...(username !== undefined ? { username, password } : {}),
      ignoreCertErrors: false,
    };
  }
  return { kind: "country", countryCode: env.BROWSER_USE_CLOUD_PROXY_COUNTRY ?? "fr" };
}

export function parseStoredBrowserProviderProxy(value: unknown): BrowserProviderProxy | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored browser proxy configuration is malformed");
  }
  const proxy = value as Record<string, unknown>;
  if (
    proxy.kind === "country" &&
    Object.keys(proxy).every((key) => key === "kind" || key === "countryCode") &&
    typeof proxy.countryCode === "string" &&
    /^[a-z]{2}$/.test(proxy.countryCode)
  ) {
    return { kind: "country", countryCode: proxy.countryCode };
  }
  if (
    proxy.kind === "custom" &&
    Object.keys(proxy).every((key) =>
      ["kind", "host", "port", "username", "password", "ignoreCertErrors"].includes(key),
    ) &&
    typeof proxy.host === "string" &&
    isValidProxyHost(proxy.host) &&
    typeof proxy.port === "number" &&
    Number.isInteger(proxy.port) &&
    proxy.port >= 1 &&
    proxy.port <= 65_535 &&
    proxy.ignoreCertErrors === false &&
    ((proxy.username === undefined && proxy.password === undefined) ||
      (typeof proxy.username === "string" && typeof proxy.password === "string"))
  ) {
    return {
      kind: "custom",
      host: proxy.host,
      port: proxy.port,
      ...(typeof proxy.username === "string"
        ? { username: proxy.username, password: proxy.password as string }
        : {}),
      ignoreCertErrors: false,
    };
  }
  throw new Error("stored browser proxy configuration is malformed");
}

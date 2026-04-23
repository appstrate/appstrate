// SPDX-License-Identifier: Apache-2.0

/**
 * Integration guard tying three pieces together:
 *
 *   1. the bytes we ship in `system-packages/provider-gmail-1.0.0.afps`,
 *   2. `readProviderMeta`'s projection of `definition.authorizedUris`,
 *   3. the new `matchesAuthorizedUriSpec` semantics (`**` = any suffix).
 *
 * If any of the three regresses, every authenticated provider call made
 * via `<provider>_call` breaks at runtime — the failure mode we hit when
 * the sidecar tool migration first shipped. A cheap unit test here beats
 * catching it in a live run.
 */
import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BUNDLE_FORMAT_VERSION,
  bundleIntegrity,
  extractRootFromAfps,
  type Bundle,
  type BundlePackage,
  type PackageIdentity,
} from "@appstrate/afps-runtime/bundle";
import { createSidecarProviderResolver } from "../../src/services/adapters/appstrate-sidecar-provider-resolver.ts";
import type { RunEvent, ToolContext } from "@appstrate/afps-runtime/resolvers";

const GMAIL_AFPS = join(import.meta.dir, "../../../../system-packages/provider-gmail-1.0.0.afps");

async function loadGmailPackage(): Promise<BundlePackage> {
  const bytes = new Uint8Array(await readFile(GMAIL_AFPS));
  return extractRootFromAfps(bytes);
}

/**
 * A two-package Bundle containing only the root agent and the shipped
 * Gmail provider. The root is a stub — the resolver never reads it,
 * only `dependencies.providers` refs are walked.
 */
function bundleWith(provider: BundlePackage): Bundle {
  const rootIdentity = "@acme/test-agent@1.0.0" as PackageIdentity;
  const root: BundlePackage = {
    identity: rootIdentity,
    manifest: {
      name: "@acme/test-agent",
      version: "1.0.0",
      type: "agent",
      dependencies: { providers: { "@appstrate/gmail": "^1" } },
    },
    files: new Map(),
    integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  };
  const packages = new Map<PackageIdentity, BundlePackage>([
    [rootIdentity, root],
    [provider.identity, provider],
  ]);
  const pkgIndex = new Map<PackageIdentity, { path: string; integrity: string }>();
  for (const p of packages.values()) {
    const name = (p.manifest as { name: string }).name;
    const version = (p.manifest as { version: string }).version;
    pkgIndex.set(p.identity, {
      path: `packages/${name}/${version}/`,
      integrity: p.integrity,
    });
  }
  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: rootIdentity,
    packages,
    integrity: bundleIntegrity(pkgIndex),
  };
}

function makeCtx(): ToolContext {
  return {
    emit: (_e: RunEvent) => {},
    workspace: "/tmp",
    runId: "run_test",
    toolCallId: "call_1",
    signal: new AbortController().signal,
  };
}

describe("SidecarProviderResolver with the shipped Gmail system package", () => {
  it("accepts a multi-segment Gmail API target", async () => {
    const gmail = await loadGmailPackage();
    const bundle = bundleWith(gmail);

    const calls: { url: string; init: RequestInit }[] = [];
    const resolver = createSidecarProviderResolver({
      sidecarUrl: "http://sidecar:8080",
      fetch: ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });

    const tools = await resolver.resolve([{ name: "@appstrate/gmail", version: "^1" }], bundle);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("appstrate_gmail_call");

    const res = await tools[0]!.execute(
      {
        method: "GET",
        target: "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10",
      },
      makeCtx(),
    );
    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Provider"]).toBe("@appstrate/gmail");
    expect(headers["X-Target"]).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10",
    );
  });

  it("rejects a target outside the shipped authorizedUris allowlist", async () => {
    const gmail = await loadGmailPackage();
    const bundle = bundleWith(gmail);
    const resolver = createSidecarProviderResolver({
      sidecarUrl: "http://sidecar:8080",
      fetch: (() => Promise.resolve(new Response())) as unknown as typeof fetch,
    });
    const tools = await resolver.resolve([{ name: "@appstrate/gmail", version: "^1" }], bundle);
    await expect(
      tools[0]!.execute({ method: "GET", target: "https://evil.example.com/x" }, makeCtx()),
    ).rejects.toThrow(/not in authorizedUris/);
  });
});

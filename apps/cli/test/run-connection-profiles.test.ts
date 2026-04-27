// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `parseProviderProfileOverrides` +
 * `resolveConnectionProfileSelection` — the resolver-input layer for
 * `--connection-profile` and `--provider-profile`.
 */

import { describe, it, expect } from "bun:test";
import {
  parseProviderProfileOverrides,
  resolveConnectionProfileSelection,
  ConnectionProfileResolutionError,
} from "../src/commands/run/connection-profiles.ts";
import type { ConnectionProfile } from "../src/lib/connection-profiles.ts";

const PROFILES: ConnectionProfile[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Default",
    isDefault: true,
    connectionCount: 2,
    applicationId: null,
    userId: "u_1",
    endUserId: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Work",
    isDefault: false,
    connectionCount: 1,
    applicationId: null,
    userId: "u_1",
    endUserId: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

const fakeFetcher = async () => PROFILES;

describe("parseProviderProfileOverrides", () => {
  it("returns [] when undefined or empty", () => {
    expect(parseProviderProfileOverrides(undefined)).toEqual([]);
    expect(parseProviderProfileOverrides([])).toEqual([]);
  });

  it("splits each entry on the first =", () => {
    expect(parseProviderProfileOverrides(["@afps/gmail=work"])).toEqual([
      { providerId: "@afps/gmail", ref: "work" },
    ]);
    expect(parseProviderProfileOverrides(["@afps/x=a=b=c"])).toEqual([
      { providerId: "@afps/x", ref: "a=b=c" },
    ]);
  });

  it("rejects entries without =", () => {
    expect(() => parseProviderProfileOverrides(["@afps/gmail"])).toThrow(
      ConnectionProfileResolutionError,
    );
  });

  it("rejects entries with empty sides", () => {
    expect(() => parseProviderProfileOverrides(["=work"])).toThrow(
      ConnectionProfileResolutionError,
    );
    expect(() => parseProviderProfileOverrides(["@afps/gmail="])).toThrow(
      ConnectionProfileResolutionError,
    );
  });
});

describe("resolveConnectionProfileSelection", () => {
  it("passes UUIDs through without an API call", async () => {
    let called = 0;
    const fetcher = async () => {
      called++;
      return PROFILES;
    };
    const sel = await resolveConnectionProfileSelection({
      profileName: "default",
      flagRef: "11111111-1111-4111-8111-111111111111",
      perProvider: [{ providerId: "@afps/gmail", ref: "22222222-2222-4222-8222-222222222222" }],
      fetchProfiles: fetcher,
    });
    expect(called).toBe(0);
    expect(sel.connectionProfileId).toBe("11111111-1111-4111-8111-111111111111");
    expect(sel.providerProfileOverrides["@afps/gmail"]).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("translates a name to its UUID via the API", async () => {
    const sel = await resolveConnectionProfileSelection({
      profileName: "default",
      flagRef: "Work",
      fetchProfiles: fakeFetcher,
    });
    expect(sel.connectionProfileId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("falls back to the pinned id when no flag is set", async () => {
    const sel = await resolveConnectionProfileSelection({
      profileName: "default",
      pinnedId: "11111111-1111-4111-8111-111111111111",
      fetchProfiles: fakeFetcher,
    });
    expect(sel.connectionProfileId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("flag wins over pinned default", async () => {
    const sel = await resolveConnectionProfileSelection({
      profileName: "default",
      flagRef: "Work",
      pinnedId: "11111111-1111-4111-8111-111111111111",
      fetchProfiles: fakeFetcher,
    });
    expect(sel.connectionProfileId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("throws on unknown name with available list in hint", async () => {
    let caught: ConnectionProfileResolutionError | undefined;
    try {
      await resolveConnectionProfileSelection({
        profileName: "default",
        flagRef: "Personal",
        fetchProfiles: fakeFetcher,
      });
    } catch (err) {
      caught = err as ConnectionProfileResolutionError;
    }
    expect(caught).toBeInstanceOf(ConnectionProfileResolutionError);
    expect(caught?.hint).toContain("Default");
    expect(caught?.hint).toContain("Work");
  });

  it("passes UUIDs through verbatim — server-side validates ownership", async () => {
    // Fast path skips the API entirely for UUID inputs. The platform's
    // credential-proxy resolver returns null (→ 404) when the id does
    // not belong to the caller, so the CLI doesn't need to pre-validate.
    let called = 0;
    const fetcher = async () => {
      called++;
      return PROFILES;
    };
    const sel = await resolveConnectionProfileSelection({
      profileName: "default",
      flagRef: "99999999-9999-4999-8999-999999999999",
      fetchProfiles: fetcher,
    });
    expect(called).toBe(0);
    expect(sel.connectionProfileId).toBe("99999999-9999-4999-8999-999999999999");
  });

  it("translates per-provider name overrides too", async () => {
    const sel = await resolveConnectionProfileSelection({
      profileName: "default",
      perProvider: [{ providerId: "@afps/gmail", ref: "Work" }],
      fetchProfiles: fakeFetcher,
    });
    expect(sel.providerProfileOverrides["@afps/gmail"]).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });
});

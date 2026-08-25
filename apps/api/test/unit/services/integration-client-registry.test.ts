// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  initSystemIntegrations,
  __resetSystemIntegrationsForTest,
  isSystemIntegration,
  getSystemIntegrationClientById,
  listSystemIntegrationClientsFor,
  getDefaultSystemIntegrationClient,
  resolveSystemClientForAuth,
} from "../../../src/services/integration-client-registry.ts";

const GMAIL = "@appstrate/integration-gmail";
const DRIVE = "@appstrate/integration-google-drive";
const MCP = "@appstrate/integration-remote-mcp";

describe("integration-client-registry", () => {
  afterEach(() => __resetSystemIntegrationsForTest());

  describe("initSystemIntegrations", () => {
    it("loads valid entries and indexes clients by id and by (integration, authKey)", () => {
      initSystemIntegrations([
        {
          id: GMAIL,
          clients: [
            {
              id: "gmail-system",
              auth_key: "google",
              client_id: "gm-client.apps.googleusercontent.com",
              client_secret: "gm-secret",
            },
          ],
        },
        {
          id: DRIVE,
          clients: [
            {
              id: "drive-system",
              auth_key: "google",
              client_id: "drive-client",
              client_secret: "drive-secret",
            },
          ],
        },
      ]);

      // Membership = both integrations are system (auto-active).
      expect(isSystemIntegration(GMAIL)).toBe(true);
      expect(isSystemIntegration(DRIVE)).toBe(true);
      expect(isSystemIntegration("@x/none")).toBe(false);

      const gmail = getSystemIntegrationClientById("gmail-system");
      expect(gmail).not.toBeNull();
      expect(gmail!.clientId).toBe("gm-client.apps.googleusercontent.com");
      expect(gmail!.clientSecret).toBe("gm-secret");
      expect(gmail!.integrationId).toBe(GMAIL);
      expect(gmail!.authKey).toBe("google");

      const forGmail = listSystemIntegrationClientsFor(GMAIL, "google");
      expect(forGmail.map((d) => d.id)).toEqual(["gmail-system"]);
      expect(listSystemIntegrationClientsFor(DRIVE, "google").map((d) => d.id)).toEqual([
        "drive-system",
      ]);

      expect(getDefaultSystemIntegrationClient(GMAIL, "google")!.id).toBe("gmail-system");
      expect(getDefaultSystemIntegrationClient(GMAIL, "nope")).toBeNull();
      expect(getDefaultSystemIntegrationClient("@x/none", "google")).toBeNull();
    });

    it("offers a clientless (DCR) integration: member but no client", () => {
      initSystemIntegrations([{ id: MCP }]);
      // Auto-active by membership, even though it ships no static client.
      expect(isSystemIntegration(MCP)).toBe(true);
      expect(getDefaultSystemIntegrationClient(MCP, "oauth")).toBeNull();
      expect(listSystemIntegrationClientsFor(MCP, "oauth")).toEqual([]);
    });

    it("aborts boot on a client with no secret and no declared auth method", () => {
      // The empty-secret INFERENCE, deleted. A `client_secret` left out used to
      // default to `""` and silently produce a public client, so an operator who
      // simply forgot the secret got `invalid_client` from the provider instead
      // of a boot crash naming the env var they mistyped.
      let message = "";
      try {
        initSystemIntegrations([
          { id: GMAIL, clients: [{ id: "pub", auth_key: "google", client_id: "pub-client" }] },
        ]);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain(`SYSTEM_INTEGRATIONS entry #0 ("${GMAIL}") is invalid`);
      expect(message).toContain("clients[0].client_secret:");
      expect(message).toContain("token_endpoint_auth_method='none'");
      expect(message).toContain('(client "pub")');
    });

    it("accepts a public client that DECLARES token_endpoint_auth_method 'none'", () => {
      initSystemIntegrations([
        {
          id: GMAIL,
          clients: [
            {
              id: "pub",
              auth_key: "google",
              client_id: "pub-client",
              token_endpoint_auth_method: "none",
            },
          ],
        },
      ]);
      const def = getSystemIntegrationClientById("pub")!;
      // No secret at all — not an empty string standing in for one.
      expect(def.clientSecret).toBeUndefined();
      expect(def.tokenEndpointAuthMethod).toBe("none");
    });

    it("aborts boot on a declared public client that also carries a secret", () => {
      // The other direction of the pair: the operator resolved a credential and
      // then said it would not be used. One of the two is a mistake and the
      // registry cannot tell which.
      expect(() =>
        initSystemIntegrations([
          {
            id: GMAIL,
            clients: [
              {
                id: "pub",
                auth_key: "google",
                client_id: "pub-client",
                token_endpoint_auth_method: "none",
                client_secret: "leftover",
              },
            ],
          },
        ]),
      ).toThrow(/do not send a client_secret with it/);
    });

    it("carries a declared secret-based method through to the definition", () => {
      initSystemIntegrations([
        {
          id: GMAIL,
          clients: [
            {
              id: "basic",
              auth_key: "google",
              client_id: "c1",
              client_secret: "s1",
              token_endpoint_auth_method: "client_secret_basic",
            },
          ],
        },
      ]);
      expect(getSystemIntegrationClientById("basic")!.tokenEndpointAuthMethod).toBe(
        "client_secret_basic",
      );
      // Declaring nothing leaves the manifest's method to apply.
      initSystemIntegrations([
        {
          id: GMAIL,
          clients: [{ id: "undeclared", auth_key: "google", client_id: "c1", client_secret: "s1" }],
        },
      ]);
      expect(getSystemIntegrationClientById("undeclared")!.tokenEndpointAuthMethod).toBeUndefined();
    });

    it("throws on an invalid entry, naming its index and the failing field", () => {
      // Declared-but-invalid = boot crash: an entry silently dropped here would
      // resurface as an unrelated "not installed" / "no OAuth client" error.
      expect(() =>
        initSystemIntegrations([
          {
            id: GMAIL,
            clients: [{ id: "good", auth_key: "google", client_id: "c1", client_secret: "s1" }],
          },
          // missing entry id
          {
            clients: [
              { id: "bad-no-entry-id", auth_key: "google", client_id: "c5", client_secret: "s5" },
            ],
          },
        ]),
      ).toThrow(/SYSTEM_INTEGRATIONS entry #1 is invalid: id:/);
      // A clientless member is still VALID (DCR) — membership only.
      initSystemIntegrations([
        {
          id: GMAIL,
          clients: [{ id: "good", auth_key: "google", client_id: "c1", client_secret: "s1" }],
        },
        { id: MCP },
      ]);
      expect(isSystemIntegration(GMAIL)).toBe(true);
      expect(isSystemIntegration(MCP)).toBe(true);
      expect(listSystemIntegrationClientsFor(GMAIL, "google").map((d) => d.id)).toEqual(["good"]);
      expect(listSystemIntegrationClientsFor(MCP, "oauth")).toEqual([]);
    });

    it("throws on a bad nested client, naming the entry AND the offending client", () => {
      // The entry schema validates `clients` atomically, so one mistyped
      // auth_key rejects the whole entry — the message must say WHICH client.
      let message = "";
      try {
        initSystemIntegrations([
          {
            id: GMAIL,
            clients: [{ id: "good", auth_key: "google", client_id: "c1", client_secret: "s1" }],
          },
          {
            id: DRIVE,
            clients: [
              { id: "bad-authkey", auth_key: "Google!", client_id: "c2", client_secret: "sek" },
            ],
          },
        ]);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain(`SYSTEM_INTEGRATIONS entry #1 ("${DRIVE}") is invalid`);
      // Bracket path (`formatZodIssues` -> `renderFieldPath`), then the
      // client-id annotation the shared renderer knows nothing about.
      expect(message).toContain("clients[0].auth_key: auth_key must match ^[a-z][a-z0-9_]*$");
      expect(message).toContain('(client "bad-authkey")');
      // The redacted entry is safe to surface: no client_id / client_secret.
      expect(message).not.toContain("c2");
    });

    it("throws on a duplicate integration id instead of keeping the first", () => {
      expect(() =>
        initSystemIntegrations([
          {
            id: GMAIL,
            clients: [{ id: "first", auth_key: "google", client_id: "ca", client_secret: "sa" }],
          },
          {
            id: GMAIL,
            clients: [{ id: "second", auth_key: "google", client_id: "cb", client_secret: "sb" }],
          },
        ]),
      ).toThrow(`SYSTEM_INTEGRATIONS entry #1 re-declares integration id "${GMAIL}"`);
    });

    it("throws on a duplicate client id across entries (client_ref keyspace is global)", () => {
      expect(() =>
        initSystemIntegrations([
          {
            id: GMAIL,
            clients: [{ id: "dup", auth_key: "google", client_id: "first", client_secret: "sa" }],
          },
          {
            id: DRIVE,
            clients: [{ id: "dup", auth_key: "google", client_id: "second", client_secret: "sb" }],
          },
        ]),
      ).toThrow(
        `SYSTEM_INTEGRATIONS entry #1 ("${DRIVE}") declares client id "dup", already registered ` +
          `by integration "${GMAIL}"`,
      );
    });

    it("returns multiple clients for the same (integration, authKey) in env order", () => {
      initSystemIntegrations([
        {
          id: GMAIL,
          clients: [
            { id: "a", auth_key: "google", client_id: "ca", client_secret: "sa" },
            { id: "b", auth_key: "google", client_id: "cb", client_secret: "sb" },
          ],
        },
      ]);
      expect(listSystemIntegrationClientsFor(GMAIL, "google").map((d) => d.id)).toEqual(["a", "b"]);
      // The default is the first registered.
      expect(getDefaultSystemIntegrationClient(GMAIL, "google")!.id).toBe("a");
    });
  });

  describe("reset yields an empty initialized registry", () => {
    it("accessors return empties after a reset without throwing", () => {
      __resetSystemIntegrationsForTest();
      // Reset leaves an empty (initialized) registry — accessors degrade to
      // empty/null/false, they do not trip the access-before-init guard.
      expect(listSystemIntegrationClientsFor("@x/y", "google")).toEqual([]);
      expect(getSystemIntegrationClientById("x")).toBeNull();
      expect(getDefaultSystemIntegrationClient("@x/y", "google")).toBeNull();
      expect(isSystemIntegration("@x/y")).toBe(false);
    });
  });

  describe("resolveSystemClientForAuth", () => {
    beforeEach(() => __resetSystemIntegrationsForTest());

    it("resolves a system client by id when it serves this (integration, authKey)", () => {
      initSystemIntegrations([
        {
          id: GMAIL,
          clients: [
            { id: "gmail-system", auth_key: "google", client_id: "c1", client_secret: "s1" },
          ],
        },
      ]);
      expect(resolveSystemClientForAuth("gmail-system", GMAIL, "google")?.clientId).toBe("c1");
    });

    it("returns null when the id is unknown", () => {
      expect(resolveSystemClientForAuth("nope", GMAIL, "google")).toBeNull();
    });

    it("returns null when the id was remapped to a different integration/auth", () => {
      // Escalation guard: an operator reused the id under another integration.
      initSystemIntegrations([
        {
          id: DRIVE,
          clients: [
            { id: "gmail-system", auth_key: "google", client_id: "c1", client_secret: "s1" },
          ],
        },
      ]);
      expect(resolveSystemClientForAuth("gmail-system", GMAIL, "google")).toBeNull();
      expect(resolveSystemClientForAuth("gmail-system", DRIVE, "other")).toBeNull();
    });
  });
});

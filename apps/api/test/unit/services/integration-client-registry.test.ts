// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  initSystemIntegrations,
  __resetSystemIntegrationsForTest,
  isSystemIntegration,
  getSystemIntegrationClients,
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

      expect(getSystemIntegrationClients().size).toBe(2);

      const gmail = getSystemIntegrationClientById("gmail-system");
      expect(gmail).not.toBeNull();
      expect(gmail!.clientId).toBe("gm-client.apps.googleusercontent.com");
      expect(gmail!.clientSecret).toBe("gm-secret");
      expect(gmail!.integrationId).toBe(GMAIL);
      expect(gmail!.authKey).toBe("google");

      const forGmail = listSystemIntegrationClientsFor(GMAIL, "google");
      expect(forGmail.map((d) => d.id)).toEqual(["gmail-system"]);

      expect(getDefaultSystemIntegrationClient(GMAIL, "google")!.id).toBe("gmail-system");
      expect(getDefaultSystemIntegrationClient(GMAIL, "nope")).toBeNull();
      expect(getDefaultSystemIntegrationClient("@x/none", "google")).toBeNull();
    });

    it("offers a clientless (DCR) integration: member but no client", () => {
      initSystemIntegrations([{ id: MCP }]);
      // Auto-active by membership, even though it ships no static client.
      expect(isSystemIntegration(MCP)).toBe(true);
      expect(getSystemIntegrationClients().size).toBe(0);
      expect(getDefaultSystemIntegrationClient(MCP, "oauth")).toBeNull();
      expect(listSystemIntegrationClientsFor(MCP, "oauth")).toEqual([]);
    });

    it("defaults an absent client_secret to empty (public client)", () => {
      initSystemIntegrations([
        { id: GMAIL, clients: [{ id: "pub", auth_key: "google", client_id: "pub-client" }] },
      ]);
      expect(getSystemIntegrationClientById("pub")!.clientSecret).toBe("");
    });

    it("skips invalid entries without throwing and keeps the valid ones", () => {
      initSystemIntegrations([
        { id: GMAIL, clients: [{ id: "good", auth_key: "google", client_id: "c1" }] },
        // missing entry id
        { clients: [{ id: "bad-no-entry-id", auth_key: "google", client_id: "c5" }] },
        // a clientless member is VALID (DCR) — counts toward membership only
        { id: MCP },
        // entry with a bad nested client: whole entry rejected (Zod validates the
        // entry atomically), so neither the entry nor its client land.
        { id: DRIVE, clients: [{ id: "bad-authkey", auth_key: "Google!", client_id: "c2" }] },
      ]);
      expect(getSystemIntegrationClients().size).toBe(1);
      expect(getSystemIntegrationClientById("good")).not.toBeNull();
      expect(isSystemIntegration(GMAIL)).toBe(true);
      expect(isSystemIntegration(MCP)).toBe(true);
      expect(isSystemIntegration(DRIVE)).toBe(false);
    });

    it("skips a duplicate integration id (first wins)", () => {
      initSystemIntegrations([
        { id: GMAIL, clients: [{ id: "first", auth_key: "google", client_id: "ca" }] },
        { id: GMAIL, clients: [{ id: "second", auth_key: "google", client_id: "cb" }] },
      ]);
      expect(getSystemIntegrationClients().size).toBe(1);
      expect(getSystemIntegrationClientById("first")).not.toBeNull();
      expect(getSystemIntegrationClientById("second")).toBeNull();
    });

    it("skips a duplicate client id across entries (client_ref keyspace is global)", () => {
      initSystemIntegrations([
        { id: GMAIL, clients: [{ id: "dup", auth_key: "google", client_id: "first" }] },
        { id: DRIVE, clients: [{ id: "dup", auth_key: "google", client_id: "second" }] },
      ]);
      // Both integrations are members; only the first client keeps the id.
      expect(isSystemIntegration(GMAIL)).toBe(true);
      expect(isSystemIntegration(DRIVE)).toBe(true);
      expect(getSystemIntegrationClients().size).toBe(1);
      expect(getSystemIntegrationClientById("dup")!.clientId).toBe("first");
    });

    it("returns multiple clients for the same (integration, authKey) in env order", () => {
      initSystemIntegrations([
        {
          id: GMAIL,
          clients: [
            { id: "a", auth_key: "google", client_id: "ca" },
            { id: "b", auth_key: "google", client_id: "cb" },
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
      expect(getSystemIntegrationClients().size).toBe(0);
      expect(getSystemIntegrationClientById("x")).toBeNull();
      expect(getDefaultSystemIntegrationClient("@x/y", "google")).toBeNull();
      expect(isSystemIntegration("@x/y")).toBe(false);
    });
  });

  describe("resolveSystemClientForAuth", () => {
    beforeEach(() => __resetSystemIntegrationsForTest());

    it("resolves a system client by id when it serves this (integration, authKey)", () => {
      initSystemIntegrations([
        { id: GMAIL, clients: [{ id: "gmail-system", auth_key: "google", client_id: "c1" }] },
      ]);
      expect(resolveSystemClientForAuth("gmail-system", GMAIL, "google")?.clientId).toBe("c1");
    });

    it("returns null when the id is unknown", () => {
      expect(resolveSystemClientForAuth("nope", GMAIL, "google")).toBeNull();
    });

    it("returns null when the id was remapped to a different integration/auth", () => {
      // Escalation guard: an operator reused the id under another integration.
      initSystemIntegrations([
        { id: DRIVE, clients: [{ id: "gmail-system", auth_key: "google", client_id: "c1" }] },
      ]);
      expect(resolveSystemClientForAuth("gmail-system", GMAIL, "google")).toBeNull();
      expect(resolveSystemClientForAuth("gmail-system", DRIVE, "other")).toBeNull();
    });
  });
});

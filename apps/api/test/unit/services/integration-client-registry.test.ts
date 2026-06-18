// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  initSystemIntegrationClients,
  __resetSystemIntegrationClientsForTest,
  getSystemIntegrationClients,
  getSystemIntegrationClientById,
  listSystemIntegrationClientsFor,
  getDefaultSystemIntegrationClient,
  parseClientRef,
  systemClientRef,
  SYSTEM_CLIENT_REF_PREFIX,
  CUSTOM_CLIENT_REF,
} from "../../../src/services/integration-client-registry.ts";

const GMAIL = "@appstrate/integration-gmail";
const DRIVE = "@appstrate/integration-google-drive";

describe("integration-client-registry", () => {
  afterEach(() => __resetSystemIntegrationClientsForTest());

  describe("initSystemIntegrationClients", () => {
    it("loads valid entries and indexes them by id and by (integration, authKey)", () => {
      initSystemIntegrationClients([
        {
          id: "gmail-system",
          integrationId: GMAIL,
          authKey: "google",
          clientId: "gm-client.apps.googleusercontent.com",
          clientSecret: "gm-secret",
        },
        {
          id: "drive-system",
          integrationId: DRIVE,
          authKey: "google",
          clientId: "drive-client",
          clientSecret: "drive-secret",
        },
      ]);

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

    it("defaults an absent client_secret to empty (public client)", () => {
      initSystemIntegrationClients([
        { id: "pub", integrationId: GMAIL, authKey: "google", clientId: "pub-client" },
      ]);
      expect(getSystemIntegrationClientById("pub")!.clientSecret).toBe("");
    });

    it("skips invalid entries without throwing and keeps the valid ones", () => {
      initSystemIntegrationClients([
        { id: "good", integrationId: GMAIL, authKey: "google", clientId: "c1" },
        // missing clientId
        { id: "bad-no-client", integrationId: GMAIL, authKey: "google" },
        // illegal authKey (AFPS §7.2)
        { id: "bad-authkey", integrationId: GMAIL, authKey: "Google!", clientId: "c2" },
        // id charset outside the wire-addressable set (space) — not selectable
        { id: "bad id", integrationId: GMAIL, authKey: "google", clientId: "c4" },
        // missing id
        { integrationId: GMAIL, authKey: "google", clientId: "c3" },
      ]);
      expect(getSystemIntegrationClients().size).toBe(1);
      expect(getSystemIntegrationClientById("good")).not.toBeNull();
    });

    it("skips a duplicate id (first wins)", () => {
      initSystemIntegrationClients([
        { id: "dup", integrationId: GMAIL, authKey: "google", clientId: "first" },
        { id: "dup", integrationId: DRIVE, authKey: "google", clientId: "second" },
      ]);
      expect(getSystemIntegrationClients().size).toBe(1);
      expect(getSystemIntegrationClientById("dup")!.clientId).toBe("first");
    });

    it("returns multiple clients for the same (integration, authKey) in env order", () => {
      initSystemIntegrationClients([
        { id: "a", integrationId: GMAIL, authKey: "google", clientId: "ca" },
        { id: "b", integrationId: GMAIL, authKey: "google", clientId: "cb" },
      ]);
      expect(listSystemIntegrationClientsFor(GMAIL, "google").map((d) => d.id)).toEqual(["a", "b"]);
      // The default is the first registered.
      expect(getDefaultSystemIntegrationClient(GMAIL, "google")!.id).toBe("a");
    });
  });

  describe("reset yields an empty initialized registry", () => {
    it("accessors return empties after a reset without throwing", () => {
      __resetSystemIntegrationClientsForTest();
      // Reset leaves an empty (initialized) registry — accessors degrade to
      // empty/null, they do not trip the access-before-init guard.
      expect(getSystemIntegrationClients().size).toBe(0);
      expect(getSystemIntegrationClientById("x")).toBeNull();
      expect(getDefaultSystemIntegrationClient("@x/y", "google")).toBeNull();
    });
  });

  describe("client_ref helpers", () => {
    beforeEach(() => __resetSystemIntegrationClientsForTest());

    it("systemClientRef prefixes the id", () => {
      expect(systemClientRef("gmail-system")).toBe(`${SYSTEM_CLIENT_REF_PREFIX}gmail-system`);
      expect(systemClientRef("gmail-system")).toBe("system:gmail-system");
    });

    it("parseClientRef discriminates system vs custom", () => {
      expect(parseClientRef("system:gmail-system")).toEqual({ kind: "system", id: "gmail-system" });
      expect(parseClientRef(CUSTOM_CLIENT_REF)).toEqual({ kind: "custom" });
      expect(parseClientRef("custom")).toEqual({ kind: "custom" });
    });

    it("parseClientRef throws on a malformed ref (closed set, no silent coercion)", () => {
      // client_ref is always server-derived/validated; anything else is corruption.
      expect(() => parseClientRef("garbage")).toThrow(/Invalid client_ref/);
      expect(() => parseClientRef("")).toThrow(/Invalid client_ref/);
      // "system" without a colon is not a system ref and not "custom".
      expect(() => parseClientRef("system")).toThrow(/Invalid client_ref/);
    });

    it("round-trips a system id through systemClientRef → parseClientRef", () => {
      const parsed = parseClientRef(systemClientRef("drive-system"));
      expect(parsed).toEqual({ kind: "system", id: "drive-system" });
    });
  });
});
